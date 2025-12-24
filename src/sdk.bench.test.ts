import { describe, it, expect, beforeAll } from 'vitest';
import init from './wasm/nmeshed_core';
import { SyncEngine } from './core/SyncEngine';
import { NMeshedClient } from './client';
import { Transport, TransportStatus, TransportEvents } from './transport/Transport';
import { EventEmitter } from './utils/EventEmitter';

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
}

describe('SDK High-Level Benchmarks', () => {
    let wasmBuffer: Buffer;
    const workspaceId = '12345678-1234-1234-1234-123456789abc';
    const ITERATIONS = 1_000;

    beforeAll(async () => {
        const fs = await import('fs/promises');
        const path = await import('path');
        const { fileURLToPath } = await import('url');

        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const wasmPath = path.resolve(__dirname, './wasm/nmeshed_core_bg.wasm');

        wasmBuffer = await fs.readFile(wasmPath);
        await init(wasmBuffer);
    });

    describe('SyncEngine Performance', () => {
        it('Benchmark: SyncEngine.set (json/codec overhead)', async () => {
            const engine = new SyncEngine(workspaceId, 'crdt');
            await engine.boot();

            const start = performance.now();
            for (let i = 0; i < ITERATIONS; i++) {
                engine.set(`key-${i}`, { val: i, text: 'some sample data for benchmarking' });
            }
            const end = performance.now();
            const time = end - start;
            console.log(`[SyncEngine] set: ${(time / ITERATIONS * 1000).toFixed(2)} µs/op`);
        });

        it('Benchmark: SyncEngine.applyRemoteDelta (merge + decode)', async () => {
            const engine = new SyncEngine(workspaceId, 'crdt');
            await engine.boot();
            const delta = engine.set('bench', { x: 10, y: 20 });

            const start = performance.now();
            for (let i = 0; i < ITERATIONS; i++) {
                engine.applyRemoteDelta(delta);
            }
            const end = performance.now();
            const time = end - start;
            console.log(`[SyncEngine] applyRemoteDelta: ${(time / ITERATIONS * 1000).toFixed(2)} µs/op`);
        });
    });

    describe('NMeshedClient Performance', () => {
        it('Benchmark: NMeshedClient.set (Full Stack)', async () => {
            const client = new NMeshedClient({
                workspaceId,
                userId: '12345678-1234-1234-1234-123456789abc',
                token: 'mock',
                transport: 'server' // We'll mock the transport actually
            });

            // Inject mock transport
            (client as any).transport = new MockTransport();
            (client as any).setupTransportListeners();
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

        it('Benchmark: SyncedMap.set (Abstraction Overhead)', async () => {
            const client = new NMeshedClient({
                workspaceId,
                userId: '00000000-0000-0000-0000-000000000000',
                token: 'mock'
            });
            (client as any).transport = new MockTransport();
            (client as any).setupTransportListeners();
            (client as any).setStatus('CONNECTED');
            await (client as any).bootPromise;

            const map = client.getSyncedMap('bench-map');

            const start = performance.now();
            for (let i = 0; i < ITERATIONS; i++) {
                map.set(`item-${i}`, { data: i });
            }
            const end = performance.now();
            const time = end - start;
            console.log(`[SyncedMap] set: ${(time / ITERATIONS * 1000).toFixed(2)} µs/op`);
        });
    });
});
