import { SyncEngine } from '../src/engine';
import { IStorage } from '../src/types';
import { HLC } from '../src/hlc';
import { encodeValue } from '../src/protocol';

// Mock Storage
class MockStorage implements IStorage {
    private data = new Map<string, Uint8Array>();
    async init() { }
    async get(key: string) { return this.data.get(key); }
    async set(key: string, value: Uint8Array) { this.data.set(key, value); }
    async delete(key: string) { this.data.delete(key); }
    async scanPrefix() { return []; }
    async clear() { }
    async clearAll() { this.data.clear(); }
    async close() { }
}

describe('Causal Barrier Verification', () => {
    let engine: SyncEngine;
    let storage: MockStorage;

    beforeEach(() => {
        storage = new MockStorage();
        engine = new SyncEngine('NODE_A', storage, false);
    });

    test('should reject operation with missing dependencies', async () => {
        const key = 'test-key';
        const payload = encodeValue({ data: 'test-value' });
        const timestamp = BigInt(Date.now()) << 80n; // Basic future TS

        // Define a dependency that doesn't exist
        const unknownDep = 'MISSING_OP_HASH';

        // Listen for sync status
        let syncTriggered = false;
        engine.on('status', (s) => {
            if (s === 'syncing') syncTriggered = true;
        });

        // Apply remote op with missing deps
        await engine.applyRemote(key, payload, 'NODE_B', timestamp, [unknownDep]);

        // Verify:
        // 1. Value should NOT be applied (Gap Detected)
        expect(engine.get(key)).toBeUndefined();

        // 2. Sync should be triggered
        expect(syncTriggered).toBe(true);
    });

    test('should accept operation when dependencies are satisfied', async () => {
        // 1. Create Op1 (The dependency)
        const key1 = 'op-1';
        await engine.set(key1, { data: 'parent' });

        // Capture hash
        let op1Hash = '';
        const op1Ts = (engine as any).lastSeenHLC;
        op1Hash = `${key1}:${op1Ts.toString()}:${engine.getPeerId()}`;

        // 2. Create Op2 (Dependent on Op1)
        const key2 = 'op-2';
        const op2Payload = encodeValue({ data: 1 });
        const op2Ts = op1Ts + 1n; // Successor

        await engine.applyRemote(key2, op2Payload, 'NODE_B', op2Ts, [op1Hash]);

        // Verify Op2 applied
        expect(engine.get(key2)).toBeDefined();
    });

    test('should buffer out-of-order operations and apply when deps arrive', async () => {
        const keyA = 'A';
        const keyB = 'B';

        // Op A (Parent) properties
        const tsA = HLC.pack(BigInt(Date.now()), 0n, 1n);
        const hashA = `${keyA}:${tsA.toString()}:NODE_B`;
        const payloadA = encodeValue({ val: 'A' });

        // Op B (Child) properties
        const tsB = tsA + 1n;
        const payloadB = encodeValue({ val: 'B' });

        // 1. Apply Op B first (Missing Dep A)
        await engine.applyRemote(keyB, payloadB, 'NODE_B', tsB, [hashA]);

        // Should be buffered
        expect(engine.get(keyB)).toBeUndefined();

        // 2. Apply Op A (Satisfies Dep)
        await engine.applyRemote(keyA, payloadA, 'NODE_B', tsA, []);

        // 3. Check consistency
        // A should be applied
        expect(engine.get(keyA)).toBeDefined();
        // B should be unbuffered and applied
        expect(engine.get(keyB)).toBeDefined();
    });
});
