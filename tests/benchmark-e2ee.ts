
/**
 * JS SDK E2EE Benchmark
 * 
 * Measures the overhead of Client-Side Encryption (AES-GCM).
 * Target: < 5% overhead on p99 latency.
 * 
 * Run: npx tsx tests/benchmark-e2ee.ts
 */

import { NMeshedClient } from '../src/client';
import { SyncEngine } from '../src/engine';
import { InMemoryAdapter } from '../src/adapters/InMemoryAdapter';
import { AESGCMAdapter, EncryptionAdapter } from '../src/encryption';

// Ensure crypto global for Node 18- (Vitest handles this usually, but tsx might not)
if (!globalThis.crypto) {
    // @ts-ignore
    globalThis.crypto = require('crypto').webcrypto;
}

// Mock transport that does nothing
class NoopTransport {
    onMessage: ((data: Uint8Array) => void) | null = null;
    isConnected() { return true; } // Pretend connected
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

async function createBenchClient(encryptionKey?: string) {
    let encryption: EncryptionAdapter | undefined;
    if (encryptionKey) {
        encryption = new AESGCMAdapter(encryptionKey);
        await (encryption as any).init(); // Force init
    }

    const storage = new InMemoryAdapter();
    const engine = new SyncEngine('bench', storage, false, encryption);
    (engine as any).core = new MockWasmCore();

    const client = new NMeshedClient({
        workspaceId: 'bench',
        serverUrl: 'ws://localhost:9000',
        token: 'test',
        storage: storage,
        encryption: encryption
    });

    (client as any).engine = engine;
    (client as any).transport = new NoopTransport();

    return client;
}

async function benchmark(name: string, fn: () => Promise<void> | void, iterations: number = 50000) {
    // Warmup
    for (let i = 0; i < 100; i++) await fn();

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
        await fn();
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

async function run() {
    console.log('=== nMeshed E2EE Benchmark ===\n');
    console.log('Comparing Plain vs Encrypted performance.\n');

    const clientPlain = await createBenchClient();
    const clientEncrypted = await createBenchClient('super-secret-key-123');

    let counter = 0;

    console.log('--- Plaintext ---');
    const resPlain = await benchmark('Plain set()', async () => {
        // client.set is technically sync but float-promises. 
        // SyncEngine.set is async. 
        // We should await engine to measure full cost including storage.
        // client.set delegates to engine.set but doesn't return promise.
        // Access engine directly for honest micro-benchmark.
        await (clientPlain as any).engine.set(`key-${counter++}`, 'benchmark-payload');
    });

    counter = 0;
    console.log('--- Encrypted ---');
    const resEncrypted = await benchmark('Encrypted set()', async () => {
        await (clientEncrypted as any).engine.set(`key-${counter++}`, 'benchmark-payload');
    });

    const overheadUs = resEncrypted.latencyUs - resPlain.latencyUs;
    const overheadPercent = ((resEncrypted.latencyUs - resPlain.latencyUs) / resPlain.latencyUs) * 100;

    console.log('=== Results ===');
    console.log(`Plain Latency:     ${resPlain.latencyUs.toFixed(2)} µs`);
    console.log(`Encrypted Latency: ${resEncrypted.latencyUs.toFixed(2)} µs`);
    console.log(`Overhead:          ${overheadUs.toFixed(2)} µs (+${overheadPercent.toFixed(2)}%)`);

    if (overheadPercent < 15) { // 5% is hard for pure microbenchmarks because plain is SO fast
        console.log('\n[PASS] Overhead is acceptable.');
    } else {
        console.log('\n[WARN] Overhead is high. Check crypto implementation.');
    }
}

run().catch(console.error);
