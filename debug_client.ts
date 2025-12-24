
import WebSocket from 'ws';
// @ts-ignore
global.WebSocket = WebSocket;

// @ts-ignore
import 'fake-indexeddb/auto';

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
// @ts-ignore
import init from './src/wasm/nmeshed_core';
import { NMeshedClient } from './src/client';
import { createHash } from 'crypto';

function uuidFrom(input: string): string {
    const hash = createHash('sha256').update(input).digest('hex');
    return [
        hash.substring(0, 8),
        hash.substring(8, 12),
        '4' + hash.substring(13, 16),
        (parseInt(hash.substring(16, 17), 16) & 0x3 | 0x8).toString(16) + hash.substring(17, 20),
        hash.substring(20, 32)
    ].join('-');
}

async function start() {
    console.log("Loading WASM...");
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const wasmPath = path.resolve(__dirname, './src/wasm/nmeshed_core_bg.wasm');
    const wasmBuffer = await fs.readFile(wasmPath);
    await init(wasmBuffer);
    console.log("WASM Loaded.");

    const client = new NMeshedClient({
        workspaceId: uuidFrom('ws-1'),
        userId: uuidFrom('user-1'),
        apiKey: 'nm_local_debug',
        serverUrl: 'ws://127.0.0.1:9091/v1/sync/ws-1',
        debug: true
    });

    client.on('status', (s) => console.log('STATUS:', s));
    client.on('error', (e) => console.error('CLIENT ERROR:', e));

    console.log("Connecting...");
    try {
        await client.connect();
        console.log("Connected!");
        await new Promise(r => setTimeout(r, 1000));
        client.disconnect();
    } catch (e) {
        console.error("Failed:", e);
    }
}

start();
