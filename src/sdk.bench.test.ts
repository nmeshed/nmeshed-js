import { describe, it, expect, beforeAll, vi } from 'vitest';
import init from './wasm/nmeshed_core';
import { SyncEngine } from './core/SyncEngine';
import { NMeshedClient } from './client';
import { Transport, TransportStatus, TransportEvents } from './transport/Transport';
import { EventEmitter } from './utils/EventEmitter';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

class MockTransport extends EventEmitter<TransportEvents> implements Transport {
    getStatus() { return 'CONNECTED' as TransportStatus; }
    async connect() { }
    disconnect() { }
    send(data: Uint8Array) { this.emit('message', data); }
    broadcast(data: Uint8Array) { }
    sendEphemeral(payload: any) { }
    simulateLatency(ms: number) { }
    simulatePacketLoss(rate: number) { }
    getPeers() { return []; }
    async ping() { return 0; }
    getLatency() { return 0; }
}

// Mock persistence to avoid IndexedDB errors
vi.mock('./persistence', () => ({
    loadQueue: vi.fn().mockResolvedValue([]),
    saveQueue: vi.fn().mockResolvedValue(undefined),
}));

// Skip: Benchmarks are slow and meant for manual performance testing.
describe('SDK High-Level Benchmarks', () => {
    let wasmBuffer: Uint8Array;
    const workspaceId = '12345678-1234-1234-1234-123456789abc';
    const ITERATIONS = 1_000;

    beforeAll(async () => {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const wasmPath = path.resolve(__dirname, './wasm/nmeshed_core/nmeshed_core_bg.wasm');

        const buffer = await fs.readFile(wasmPath);
        wasmBuffer = new Uint8Array(buffer);
        await init(wasmBuffer);
    });

    describe('SyncEngine Performance', () => {
        it('Benchmark: SyncEngine.set (json/codec overhead)', async () => {
            const engine = new SyncEngine(workspaceId, '00000000-0000-0000-0000-000000000100');
            await engine.boot();

            const start = performance.now();
            for (let i = 0; i < ITERATIONS; i++) {
                engine.set(`key-${i}`, { val: i, text: 'some sample data for benchmarking' });
            }
            const end = performance.now();
            const time = end - start;
            console.log(`[SyncEngine] set: ${(time / ITERATIONS * 1000).toFixed(2)} µs/op`);
        });

        it('Benchmark: SyncEngine.applyRawMessage (parse + merge + decode)', async () => {
            const engine = new SyncEngine(workspaceId, '00000000-0000-0000-0000-000000000100');
            await engine.boot();
            const delta = engine.set('bench', { x: 10, y: 20 });

            const start = performance.now();
            for (let i = 0; i < ITERATIONS; i++) {
                engine.applyRawMessage(delta);
            }
            const end = performance.now();
            const time = end - start;
            console.log(`[SyncEngine] applyRawMessage: ${(time / ITERATIONS * 1000).toFixed(2)} µs/op`);
        });
    });

    describe('NMeshedClient Performance', () => {
        it('Benchmark: NMeshedClient.set (Full Stack)', async () => {
            const client = new NMeshedClient({
                workspaceId,
                userId: '00000000-0000-0000-0000-000000000000',
                token: 'mock'
            });

            // Inject mock transport
            (client as any).transport = new MockTransport();
            (client as any).setupBindings();
            (client as any).setStatus('CONNECTED');

            await (client as any).bootPromise;

            const start = performance.now();
            for (let i = 0; i < ITERATIONS; i++) {
                client.set(`key-${i}`, { val: i });
            }
            const end = performance.now();
            const time = end - start;
            console.log(`[NMeshedClient] set: ${(time / ITERATIONS * 1000).toFixed(2)} µs/op`);
        });

        it('Benchmark: SyncedCollection.set (Abstraction Overhead)', async () => {
            const client = new NMeshedClient({
                workspaceId,
                userId: '00000000-0000-0000-0000-000000000000',
                token: 'mock'
            });
            (client as any).transport = new MockTransport();
            (client as any).setupBindings();
            (client as any).setStatus('CONNECTED');
            await (client as any).bootPromise;

            const col = client.getCollection('bench-col');

            const start = performance.now();
            for (let i = 0; i < ITERATIONS; i++) {
                col.set(`item-${i}`, { data: i });
            }
            const end = performance.now();
            const time = end - start;
            console.log(`[SyncedCollection] set: ${(time / ITERATIONS * 1000).toFixed(2)} µs/op`);
        });
    });
});
