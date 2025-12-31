/**
 * JS SDK Benchmark (Manual Runner)
 * 
 * Measures local SDK overhead with absolute numbers.
 * 
 * Run: npx tsx tests/benchmark-manual.ts
 */

import { NMeshedClient } from '../src/client';
import { SyncEngine } from '../src/engine';

// Mock transport that does nothing
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

function createBenchClient() {
    const engine = new SyncEngine();
    (engine as any).core = new MockWasmCore();

    const client = new NMeshedClient({
        workspaceId: 'bench',
        serverUrl: 'ws://localhost:9000',
        token: 'test'
    });

    (client as any).engine = engine;
    (client as any).transport = new NoopTransport();

    return client;
}

function benchmark(name: string, fn: () => void, iterations: number = 100000) {
    // Warmup
    for (let i = 0; i < 1000; i++) fn();

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
        fn();
    }
    const end = performance.now();

    const totalMs = end - start;
    const opsPerSec = iterations / (totalMs / 1000);
    const latencyUs = (totalMs * 1000) / iterations;

    console.log(`${name}:`);
    console.log(`  Throughput: ${(opsPerSec / 1000000).toFixed(2)}M ops/sec`);
    console.log(`  Latency: ${latencyUs.toFixed(2)} µs/op`);
    console.log();

    return { name, opsPerSec, latencyUs };
}

console.log('=== nMeshed JS SDK Benchmark ===\n');
console.log('Measuring local SDK overhead (no network).\n');

const client = createBenchClient();
let counter = 0;

const results: Array<{ name: string, opsPerSec: number, latencyUs: number }> = [];

results.push(benchmark('client.set() - small value', () => {
    client.set(`key-${counter++}`, 'small');
}));

counter = 0;
results.push(benchmark('client.set() - 1KB value', () => {
    client.set(`key-${counter++}`, 'x'.repeat(1024));
}));

// Pre-populate for reads
for (let i = 0; i < 100000; i++) {
    client.set(`read-key-${i}`, 'value');
}

let readCounter = 0;
results.push(benchmark('client.get() - cache hit', () => {
    client.get(`read-key-${readCounter++ % 100000}`);
}));

// Output JSON for documentation
console.log('=== JSON Results ===');
console.log(JSON.stringify(results, null, 2));
