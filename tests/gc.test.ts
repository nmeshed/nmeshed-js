import { SyncEngine } from '../src/engine';
import { IStorage } from '../src/types';
import { HLC } from '../src/hlc';

// Mock Storage
class MockStorage implements IStorage {
    public data = new Map<string, Uint8Array>();
    async init() { }
    async get(key: string) { return this.data.get(key); }
    async set(key: string, value: Uint8Array) { this.data.set(key, value); }
    async delete(key: string) { this.data.delete(key); }
    async scanPrefix() { return []; }
    async clear() { }
    async clearAll() { this.data.clear(); }
    async close() { }
}

describe('Tombstone GC Verification', () => {
    let engine: SyncEngine;
    let storage: MockStorage;

    beforeEach(() => {
        storage = new MockStorage();
        engine = new SyncEngine('NODE_GC', storage, false);
    });

    test('should prune tombstones older than stability window', async () => {
        const keyOld = 'deleted-long-ago';
        const keyRecent = 'deleted-just-now';
        const keyActive = 'active-value';

        // Helper to bake a tombstone into state directly
        const bakeState = (key: string, val: any, tsOffset: number) => {
            const now = Date.now();
            const ts = HLC.pack(BigInt(now + tsOffset), 0n, 123n);
            (engine as any).state.set(key, {
                value: val,
                timestamp: ts,
                peerId: 'NODE_GC',
                lastCiphertext: new Uint8Array()
            });
        };

        // Window is 5000ms.
        // 1. Old Tombstone (-6000ms)
        bakeState(keyOld, null, -6000);

        // 2. Recent Tombstone (-1000ms)
        bakeState(keyRecent, null, -1000);

        // 3. Active Value (-10000ms, should stay)
        bakeState(keyActive, "alive", -10000);

        // Run Compact
        await engine.compact();

        // Verify
        const state = (engine as any).state;
        expect(state.has(keyOld)).toBe(false);   // Pruned
        expect(state.has(keyRecent)).toBe(true); // Kept
        expect(state.has(keyActive)).toBe(true); // Kept (not tombstone)
    });
});
