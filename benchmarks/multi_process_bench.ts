import { fork } from 'child_process';
import { isMaster } from 'cluster'; // isPrimary in newer node, but isMaster is compatible with older versions
import { NMeshedClient } from '../src/client';
import { fileURLToPath } from 'url';
import * as path from 'path';
import * as fs from 'fs/promises';
// @ts-ignore
import init from '../src/wasm/nmeshed_core';

// Arguments passing helper
const getArg = (name: string, def: string) => {
    const args = process.argv;
    const idx = args.indexOf('--' + name);
    return idx >= 0 ? args[idx + 1] : def;
};

interface WorkerResult {
    totalOps: number;
    errors: number;
    latencies: number[];
    duration: number;
}

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

// Check if we are a worker based on env (child_process.fork doesn't set cluster.isWorker)
const isWorker = !!process.env.SLAVE_WS_ID;

if (!isWorker) {
    runMain();
} else {
    runWorker();
}

async function runMain() {
    const url = getArg('url', 'ws://127.0.0.1:9090/v1/sync');
    const workspaces = parseInt(getArg('workspaces', '1'));
    const usersPerWs = parseInt(getArg('users', '10'));
    const rate = parseInt(getArg('rate', '0'));
    const duration = parseInt(getArg('duration', '10'));

    console.log(`Starting Process-Based Benchmark:`);
    console.log(`  Workspaces: ${workspaces}`);
    console.log(`  Users/WS: ${usersPerWs}`);
    console.log(`  Target Rate: ${rate === 0 ? 'MAX' : rate}`);
    console.log(`  Duration: ${duration}s`);

    const totalWorkers = workspaces * usersPerWs;
    let completed = 0;
    const results: WorkerResult[] = [];
    const startTime = Date.now();

    // Fork workers
    for (let w = 0; w < workspaces; w++) {
        const wsId = uuidFrom(`bench_ws_${w}`);
        for (let u = 0; u < usersPerWs; u++) {
            const userId = uuidFrom(`user_${w}_${u}`);

            const worker = fork(fileURLToPath(import.meta.url), [], {
                env: {
                    ...process.env, // Inherit parent process environment
                    SLAVE_URL: url,
                    SLAVE_WS_ID: wsId,
                    SLAVE_USER_ID: userId,
                    SLAVE_RATE: rate.toString(),
                    SLAVE_DURATION: duration.toString()
                }
            });


            worker.on('message', (msg: any) => {
                if (msg.type === 'result') {
                    results.push(msg.data);
                }
            });

            worker.on('exit', (code) => {
                if (code !== 0) {
                    console.error(`Worker exited with code ${code}`);
                }
                completed++;
                if (completed === totalWorkers) {
                    reportResults(results, startTime, workspaces, usersPerWs, rate, duration);
                }
            });
        }
    }
}

function reportResults(results: WorkerResult[], startTime: number, workspaces: number, users: number, rate: number, duration: number) {
    const totalDuration = (Date.now() - startTime) / 1000;
    let totalOps = 0;
    let totalErrors = 0;
    let allLatencies: number[] = [];

    for (const r of results) {
        totalOps += r.totalOps;
        totalErrors += r.errors;
        if (r.latencies.length < 100000) {
            allLatencies.push(...r.latencies);
        }
    }

    const throughput = totalOps / totalDuration;
    const avgLatency = allLatencies.reduce((a, b) => a + b, 0) / (allLatencies.length || 1);

    console.log(JSON.stringify({
        config: { workspaces, users, rate, duration },
        results: {
            total_ops: totalOps,
            throughput: Math.round(throughput),
            errors: totalErrors,
            avg_latency_ms: avgLatency.toFixed(3),
            duration: totalDuration
        }
    }, null, 2));
}

async function runWorker() {
    let url = process.env.SLAVE_URL!;
    const wsId = process.env.SLAVE_WS_ID!;
    const userId = process.env.SLAVE_USER_ID!;
    const rate = parseInt(process.env.SLAVE_RATE!);
    const duration = parseInt(process.env.SLAVE_DURATION!);

    // Init WASM
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const wasmPath = path.resolve(__dirname, '../src/wasm/nmeshed_core_bg.wasm');

    try {
        const wasmBuffer = await fs.readFile(wasmPath);
        await init(wasmBuffer);
    } catch (e) {
        process.exit(1);
    }

    // Polyfills - Force 'ws' package over native Node experimental WebSocket
    // @ts-ignore
    global.WebSocket = (await import('ws')).default;
    // @ts-ignore
    if (!global.indexedDB) await import('fake-indexeddb/auto');

    // Force IPv4 to avoid ::1 issues
    if (url.includes('localhost')) {
        url = url.replace('localhost', '127.0.0.1');
    }

    // Construct URL with Workspace ID to match e2e_bench.ts behavior (Server expects /v1/sync/{wsId} ?)
    // And ensure no double slashes
    const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
    const finalUrl = `${baseUrl}/${wsId}`;

    const client = new NMeshedClient({
        workspaceId: wsId,
        userId: userId,
        apiKey: `nm_local_bench_${userId}`,
        serverUrl: finalUrl,
        transport: 'server',
        debug: false
    });

    try {
        await client.connect();
    } catch (e) {
        // @ts-ignore
        if (process.send) {
            process.send({ type: 'result', data: { totalOps: 0, errors: 1, latencies: [], duration: 0 } });
        }
        console.error(`Worker ${userId} failed to connect:`, e);
        process.exit(1);
    }

    const latencies: number[] = [];
    let ops = 0;
    let errors = 0;

    const endAt = Date.now() + (duration * 1000);
    const intervalMs = rate > 0 ? 1000 / rate : 0;

    while (Date.now() < endAt) {
        const start = performance.now();
        const key = `pos_${userId}`;
        const val = { x: Math.random() * 100, y: Math.random() * 100, ts: Date.now() };

        try {
            client.set(key, val);
            latencies.push(performance.now() - start);
            ops++;
        } catch (e) {
            errors++;
        }

        if (intervalMs > 0) {
            const elapsed = performance.now() - start;
            const sleep = intervalMs - elapsed;
            if (sleep > 0) await new Promise(r => setTimeout(r, sleep));
        } else {
            if (ops % 10 === 0) await new Promise(r => setTimeout(r, 0));
        }
    }

    client.disconnect();

    // @ts-ignore
    process.send({
        type: 'result',
        data: {
            totalOps: ops,
            errors: errors,
            latencies: latencies,
            duration: duration
        }
    });
    process.exit(0);
}
