import { NMeshedClient } from '../src/client';
import { performance } from 'perf_hooks';

// Stats
class Stats {
    totalOps = 0;
    errors = 0;
    latencies: number[] = [];
    startTime = 0;
    endTime = 0;

    start() { this.startTime = performance.now(); }
    stop() { this.endTime = performance.now(); }

    addLatency(ms: number) {
        this.latencies.push(ms);
        this.totalOps++;
    }

    addError() { this.errors++; }

    report() {
        const duration = (this.endTime - this.startTime) / 1000;
        const throughput = duration > 0 ? this.totalOps / duration : 0;
        const avg = this.latencies.reduce((a, b) => a + b, 0) / (this.latencies.length || 1);
        return {
            duration,
            total_ops: this.totalOps,
            throughput,
            errors: this.errors,
            latencies: { avg }
        };
    }
}

async function runClient(
    url: string,
    wsId: string,
    userId: string,
    rate: number,
    useJitter: boolean,
    durationSecs: number,
    stats: Stats
) {
    // API Path is correctly handled by client, we just pass base URL
    // (Wait, python client had issue with path, JS client `buildUrl` uses `serverUrl`)

    // JS Client buildUrl:
    // const baseUrl = this.config.serverUrl || 'wss://api.nmeshed.com';
    // const url = new URL(baseUrl);

    // If we pass http://localhost:9090, it will use that.
    // However, JS client usually appends queries. It does NOT seem to append /v1/sync/ ? 
    // Let me check existing code memory... 
    // "url.search = params.toString()"
    // It returns url.toString().
    // So if serverUrl is "ws://localhost:9090", it connects to "ws://localhost:9090?..."
    // BUT Server needs "/v1/sync/..." path.
    // So we must pass "ws://localhost:9090/v1/sync" as serverUrl.

    const client = new NMeshedClient({
        workspaceId: wsId,
        userId: userId,
        apiKey: "nm_local_bench_" + userId, // Bypass
        serverUrl: `${url}/${wsId}`,
        transport: 'server',
        debug: false,
    });

    try {
        await client.connect();
    } catch (e) {
        console.error(`Connect failed ${userId}`, e);
        stats.addError();
        return;
    }

    const intervalMs = 1000 / rate;
    const endTime = performance.now() + (durationSecs * 1000);

    while (performance.now() < endTime) {
        let sleep = intervalMs;
        if (useJitter) {
            // Simple random jitter +/- 50%
            sleep = intervalMs * (0.5 + Math.random());
        }

        await new Promise(r => setTimeout(r, sleep));

        const key = `pos_${userId}`;
        const val = { x: Math.random() * 100, y: Math.random() * 100, ts: Date.now() };

        const start = performance.now();
        try {
            client.set(key, val);
            // In JS SDK, set() is sync (optimistic). Only transaction() waits?
            // Actually `set` sends immediately if connected.
            // We measure "time to call set" which implies serialization overhead.
            // For true network ack, we'd need a promise based API or wait for server reflection.
            // Matching Go/Python logic: measure client-side processing + send enqueue.
            stats.addLatency(performance.now() - start);
        } catch (e) {
            stats.addError();
        }
    }

    client.disconnect();
}

import WebSocket from 'ws';
// @ts-ignore
global.WebSocket = WebSocket;

// @ts-ignore
import 'fake-indexeddb/auto';

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
// @ts-ignore
import init from '../src/wasm/nmeshed_core';

import { createHash } from 'crypto';

function uuidFrom(input: string): string {
    const hash = createHash('sha256').update(input).digest('hex');
    // Format as UUID: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    return [
        hash.substring(0, 8),
        hash.substring(8, 12),
        '4' + hash.substring(13, 16),
        (parseInt(hash.substring(16, 17), 16) & 0x3 | 0x8).toString(16) + hash.substring(17, 20),
        hash.substring(20, 32)
    ].join('-');
}

async function main() {
    // Initialize WASM
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const wasmPath = path.resolve(__dirname, '../src/wasm/nmeshed_core_bg.wasm');
    const wasmBuffer = await fs.readFile(wasmPath);
    await init(wasmBuffer);
    console.log("WASM Initialized");

    const args = process.argv.slice(2);
    // Simple arg parsing
    const getArg = (name: string, def: string) => {
        const idx = args.indexOf('--' + name);
        return idx >= 0 ? args[idx + 1] : def;
    };

    const url = getArg('url', 'ws://127.0.0.1:9090/v1/sync'); // IMPORTANT: Path included
    const workspaces = parseInt(getArg('workspaces', '1'));
    const users = parseInt(getArg('users', '10'));
    const rate = parseInt(getArg('rate', '100'));
    const duration = parseInt(getArg('duration', '10'));
    const jitter = true;

    // console.log(`Starting JS Bench: ${workspaces} ws, ${users} users/ws`);

    const stats = new Stats();
    stats.start();

    const promises = [];
    for (let w = 0; w < workspaces; w++) {
        const wsId = uuidFrom(`bench_ws_${w}`);
        for (let u = 0; u < users; u++) {
            const userId = uuidFrom(`user_${w}_${u}`);
            promises.push(runClient(url, wsId, userId, rate, jitter, duration, stats));
        }
    }

    await Promise.all(promises);
    stats.stop();

    console.log(JSON.stringify({
        results: stats.report()
    }, null, 2));
}

main().catch(console.error);
