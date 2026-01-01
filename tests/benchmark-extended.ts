/**
 * JavaScript SDK Extended Benchmarks
 * 
 * Covers:
 * - WebSocket message parsing (Flatbuffers decode)
 * - Offline queue drain
 * - Snapshot hydration (cold start)
 * - Memory pressure (10k keys)
 * 
 * Run: npx tsx tests/benchmark-extended.ts
 */

import { NMeshedClient } from '../src/client';
import { SyncEngine } from '../src/engine';
import { InMemoryAdapter } from '../src/adapters/InMemoryAdapter';
import { encodeValue, decodeValue } from '../src/protocol';

// Mock transport
class NoopTransport {
    onMessage: ((data: Uint8Array) => void) | null = null;
    connect() { return Promise.resolve(); }
    send(_data: Uint8Array) { /* noop */ }
    disconnect() { }
    getStatus() { return 'connected' as const; }
}

// Mock WASM core
class MockWasmCore {
    private store = new Map<string, Uint8Array>();

    applyLocalOp(key: string, value: Uint8Array, _timestamp: number, _isDelete: boolean) {
        this.store.set(key, value);
        return new Uint8Array([1, 2, 3]);
    }

    applyRemoteOp(_key: string, _binary: Uint8Array, _timestamp: number) { }

    getValue(key: string): Uint8Array | null {
        return this.store.get(key) || null;
    }

    getAllValues() {
        return Object.fromEntries(this.store);
    }

    getBinarySnapshot(): Uint8Array {
        return new Uint8Array([]);
    }

    loadSnapshot(_data: Uint8Array) { }
}

function benchmark(name: string, fn: () => void, iterations: number = 10000, warmup: number = 1000) {
    // Warmup
    for (let i = 0; i < warmup; i++) fn();

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
        fn();
    }
    const end = performance.now();

    const totalMs = end - start;
    const opsPerSec = iterations / (totalMs / 1000);
    const latencyUs = (totalMs * 1000) / iterations;

    console.log(`${name}:`);
    console.log(`  Throughput: ${(opsPerSec / 1000).toFixed(2)}k ops/sec`);
    console.log(`  Latency: ${latencyUs.toFixed(2)} µs/op`);
    console.log();

    return { name, opsPerSec, latencyUs };
}

function createBenchClient() {
    const engine = new SyncEngine('bench', new InMemoryAdapter(), false);
    (engine as any).core = new MockWasmCore();

    const client = new NMeshedClient({
        workspaceId: 'bench',
        serverUrl: 'ws://localhost:9000',
        token: 'test',
        storage: new InMemoryAdapter()
    });

    (client as any).engine = engine;
    (client as any).transport = new NoopTransport();

    return client;
}

function benchMessageParsing() {
    console.log('='.repeat(60));
    console.log('WEBSOCKET MESSAGE PARSING (MsgPack Encode/Decode)');
    console.log('='.repeat(60));
    console.log();

    // Small payload
    const smallValue = { name: 'test', value: 42 };
    benchmark('Encode small object', () => {
        encodeValue(smallValue);
    });

    const encodedSmall = encodeValue(smallValue);
    benchmark('Decode small object', () => {
        decodeValue(encodedSmall);
    });

    // Medium payload (1KB object)
    const mediumValue = {
        items: Array.from({ length: 50 }, (_, i) => ({
            id: i,
            name: `Item ${i}`,
            data: 'x'.repeat(20)
        }))
    };
    benchmark('Encode 1KB object', () => {
        encodeValue(mediumValue);
    }, 5000);

    const encodedMedium = encodeValue(mediumValue);
    benchmark('Decode 1KB object', () => {
        decodeValue(encodedMedium);
    }, 5000);

    // Large payload (10KB object)
    const largeValue = {
        items: Array.from({ length: 500 }, (_, i) => ({
            id: i,
            name: `Item ${i}`,
            data: 'x'.repeat(20)
        }))
    };
    benchmark('Encode 10KB object', () => {
        encodeValue(largeValue);
    }, 1000);

    const encodedLarge = encodeValue(largeValue);
    benchmark('Decode 10KB object', () => {
        decodeValue(encodedLarge);
    }, 1000);
}

function benchSnapshotHydration() {
    console.log('='.repeat(60));
    console.log('SNAPSHOT HYDRATION (Cold Start)');
    console.log('='.repeat(60));
    console.log();

    // Create snapshot data
    const snapshotData: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
        snapshotData[`key_${i}`] = { value: i, data: 'x'.repeat(100) };
    }

    benchmark('Hydrate 100-key snapshot', () => {
        const engine = new SyncEngine('hydrate', new InMemoryAdapter(), false);
        for (const [key, value] of Object.entries(snapshotData)) {
            engine.set(key, value);
        }
    }, 100, 10);

    // 1000 keys
    const largeSnapshot: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) {
        largeSnapshot[`key_${i}`] = { value: i, data: 'x'.repeat(50) };
    }

    benchmark('Hydrate 1000-key snapshot', () => {
        const engine = new SyncEngine('hydrate', new InMemoryAdapter(), false);
        for (const [key, value] of Object.entries(largeSnapshot)) {
            engine.set(key, value);
        }
    }, 20, 5);
}

function benchMemoryPressure() {
    console.log('='.repeat(60));
    console.log('MEMORY PRESSURE (10k Keys)');
    console.log('='.repeat(60));
    console.log();

    const client = createBenchClient();

    // Measure heap before
    const heapBefore = process.memoryUsage().heapUsed;

    // Insert 10k keys
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
        client.set(`key_${i}`, { value: i, data: 'x'.repeat(100) });
    }
    const insertTime = performance.now() - start;

    const heapAfter = process.memoryUsage().heapUsed;
    const heapGrowth = (heapAfter - heapBefore) / 1024 / 1024;

    console.log('Insert 10,000 keys:');
    console.log(`  Time: ${insertTime.toFixed(2)}ms`);
    console.log(`  Throughput: ${(10000 / (insertTime / 1000)).toFixed(0)} ops/sec`);
    console.log(`  Heap Growth: ${heapGrowth.toFixed(2)} MB`);
    console.log(`  Bytes/Key: ${((heapAfter - heapBefore) / 10000).toFixed(0)} bytes`);
    console.log();

    // Random access pattern
    const accessStart = performance.now();
    for (let i = 0; i < 10000; i++) {
        const key = `key_${Math.floor(Math.random() * 10000)}`;
        client.get(key);
    }
    const accessTime = performance.now() - accessStart;

    console.log('Random access 10,000 reads:');
    console.log(`  Time: ${accessTime.toFixed(2)}ms`);
    console.log(`  Throughput: ${(10000 / (accessTime / 1000)).toFixed(0)} ops/sec`);
    console.log();
}

function benchOfflineQueueDrain() {
    console.log('='.repeat(60));
    console.log('OFFLINE QUEUE DRAIN');
    console.log('='.repeat(60));
    console.log();

    const engine = new SyncEngine('drain', new InMemoryAdapter(), false);

    // Simulate offline: queue operations
    for (let i = 0; i < 100; i++) {
        engine.set(`offline_key_${i}`, { value: i });
    }

    benchmark('Drain 100 pending ops', () => {
        // Drain the pending queue
        const ops = engine.drainPending();
        // Refill for next iteration
        for (let i = 0; i < 100; i++) {
            engine.set(`offline_key_${i}`, { value: i });
        }
    }, 100, 10);

    // 1000 pending ops
    for (let i = 0; i < 1000; i++) {
        engine.set(`offline_key_${i}`, { value: i });
    }

    benchmark('Drain 1000 pending ops', () => {
        const ops = engine.drainPending();
        for (let i = 0; i < 1000; i++) {
            engine.set(`offline_key_${i}`, { value: i });
        }
    }, 20, 5);
}

function benchWasmInitTime() {
    console.log('='.repeat(60));
    console.log('WASM INITIALIZATION TIME (Cold Start)');
    console.log('='.repeat(60));
    console.log();

    // Simulate WASM module instantiation by measuring engine creation
    // In production, this would load the actual WASM module

    const iterations = 100;
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
        const start = performance.now();

        // Create a fresh engine (simulates WASM module init + state setup)
        const engine = new SyncEngine(`wasm_init_${i}`, new InMemoryAdapter(), false);
        (engine as any).core = new MockWasmCore();

        // Initialize with some state
        engine.set('init_key', { ready: true });

        const end = performance.now();
        times.push(end - start);
    }

    // Sort for percentile calculation
    times.sort((a, b) => a - b);

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const p50 = times[Math.floor(times.length * 0.5)];
    const p99 = times[Math.floor(times.length * 0.99)];

    console.log('Engine Initialization (simulated WASM cold start):');
    console.log(`  Average: ${avg.toFixed(3)} ms`);
    console.log(`  P50: ${p50.toFixed(3)} ms`);
    console.log(`  P99: ${p99.toFixed(3)} ms`);
    console.log();
}

function benchWebSocketFrameOverhead() {
    console.log('='.repeat(60));
    console.log('WEBSOCKET FRAME OVERHEAD (Binary vs Text)');
    console.log('='.repeat(60));
    console.log();

    // Sample payload representing typical operation
    const sampleOp = {
        key: 'user:123:cursor',
        value: { x: 100, y: 200, color: '#ff0000' },
        timestamp: Date.now(),
        peerId: 'peer_abc123'
    };

    // Binary (MsgPack)
    const binaryPayload = encodeValue(sampleOp);

    // Text (JSON)
    const textPayload = new TextEncoder().encode(JSON.stringify(sampleOp));

    console.log('Payload Size Comparison:');
    console.log(`  MsgPack (binary): ${binaryPayload.byteLength} bytes`);
    console.log(`  JSON (text): ${textPayload.byteLength} bytes`);
    console.log(`  Savings: ${((1 - binaryPayload.byteLength / textPayload.byteLength) * 100).toFixed(1)}%`);
    console.log();

    // Encoding throughput
    benchmark('MsgPack encode (operation)', () => {
        encodeValue(sampleOp);
    });

    benchmark('JSON encode (operation)', () => {
        JSON.stringify(sampleOp);
    });

    // Decoding throughput
    const jsonStr = JSON.stringify(sampleOp);
    benchmark('MsgPack decode (operation)', () => {
        decodeValue(binaryPayload);
    });

    benchmark('JSON decode (operation)', () => {
        JSON.parse(jsonStr);
    });

    // Large batch comparison
    const largeBatch = Array.from({ length: 100 }, (_, i) => ({
        key: `key_${i}`,
        value: { index: i, data: 'x'.repeat(50) },
        timestamp: Date.now() + i
    }));

    const binaryBatch = encodeValue(largeBatch);
    const textBatch = new TextEncoder().encode(JSON.stringify(largeBatch));

    console.log('\nBatch (100 operations):');
    console.log(`  MsgPack: ${binaryBatch.byteLength} bytes`);
    console.log(`  JSON: ${textBatch.byteLength} bytes`);
    console.log(`  Savings: ${((1 - binaryBatch.byteLength / textBatch.byteLength) * 100).toFixed(1)}%`);
    console.log();
}

async function main() {
    console.log('\n' + '='.repeat(60));
    console.log('nMeshed JavaScript SDK Extended Benchmarks');
    console.log('='.repeat(60) + '\n');

    benchMessageParsing();
    benchSnapshotHydration();
    benchMemoryPressure();
    benchOfflineQueueDrain();
    benchWasmInitTime();
    benchWebSocketFrameOverhead();
}

main().catch(console.error);
