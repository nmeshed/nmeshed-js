
import { describe, it, expect, beforeEach } from 'vitest';
import { SyncEngine } from './SyncEngine';

describe('SyncEngine Cache Behavior (Integration)', () => {
    let engine: SyncEngine;

    beforeEach(async () => {
        // Use real engine with real WASM core.
        // The core requires valid UUIDs for workspaceId.
        const workspaceId = '00000000-0000-0000-0000-000000000001';
        const userId = '00000000-0000-0000-0000-000000000010';
        engine = new SyncEngine(workspaceId, userId);
        await engine.boot();
    });

    it('currently performs global cache invalidation on set()', async () => {
        // 1. Set 'A' with an object (objects are reference types, so we can check identity)
        const initialValueA = { id: 1, name: 'A' };
        engine.set('A', initialValueA);

        // 2. Retrieve 'A'. This should populate the viewCache.
        const cachedObjA1 = engine.get<{ id: number, name: string }>('A');
        expect(cachedObjA1).toEqual(initialValueA);

        // 3. Retrieve 'A' again. Should be the EXACT same instance (cache hit).
        const cachedObjA2 = engine.get('A');
        expect(cachedObjA2).toBe(cachedObjA1);

        // 4. Set 'B'.
        // In the current implementation, this clears the ENTIRE viewCache.
        engine.set('B', { id: 2, name: 'B' });

        // 5. Retrieve 'A' again.
        // CURRENT FLAW: The cache was cleared, so it reconstructs a NEW object from WASM binary.
        const cachedObjA3 = engine.get('A');

        // Verify values are still correct
        expect(cachedObjA3).toEqual(initialValueA);

        // Verify INSTANCE identity.
        // FIXED: Granular invalidation preserves the cache for unrelated keys.
        expect(cachedObjA3).toBe(cachedObjA1);
    });
});
