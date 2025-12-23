import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadQueue, saveQueue } from './persistence';
import 'fake-indexeddb/auto'; // Automatically mocks global indexedDB

describe('Persistence (Real IndexedDB)', () => {

    // We don't need to manually mock indexedDB anymore because 'fake-indexeddb/auto' does it.
    // However, we should clear the DB between tests to ensure isolation.

    const DB_NAME = 'nmeshed_db';

    afterEach(async () => {
        // Clear database
        const req = indexedDB.deleteDatabase(DB_NAME);
        await new Promise((resolve, reject) => {
            req.onsuccess = resolve;
            req.onerror = reject;
            req.onblocked = resolve; // Resolve even if blocked (usually means open connection)
        });
        vi.restoreAllMocks();
    });

    it('should save and load queue items correctly', async () => {
        const workspaceId = 'ws-test-1';
        const items = [
            { key: 'op1', value: { type: 'set', payload: 123 }, timestamp: 1000 },
            { key: 'op2', value: { type: 'del' }, timestamp: 1001 }
        ];

        // 1. Save
        await saveQueue(workspaceId, items);

        // 2. Load
        const loaded = await loadQueue(workspaceId);

        expect(loaded).toHaveLength(2);
        expect(loaded).toEqual(items);
    });

    it('should return empty array if nothing saved', async () => {
        const loaded = await loadQueue('ws-empty');
        expect(loaded).toEqual([]);
    });

    it('should overwrite existing queue for workspace', async () => {
        const workspaceId = 'ws-overwrite';
        const initial = [{ key: '1', value: 'a', timestamp: 1 }];
        const updated = [{ key: '2', value: 'b', timestamp: 2 }];

        await saveQueue(workspaceId, initial);
        let loaded = await loadQueue(workspaceId);
        expect(loaded).toEqual(initial);

        await saveQueue(workspaceId, updated);
        loaded = await loadQueue(workspaceId);
        expect(loaded).toEqual(updated);
    });

    it('should delete queue if empty list provided', async () => {
        const workspaceId = 'ws-delete';
        await saveQueue(workspaceId, [{ key: '1', value: 'v', timestamp: 1 }]);

        // Verify saved
        let loaded = await loadQueue(workspaceId);
        expect(loaded).toHaveLength(1);

        // Save empty
        await saveQueue(workspaceId, []);

        // Verify deleted
        loaded = await loadQueue(workspaceId);
        expect(loaded).toHaveLength(0); // Should be empty array
    });

    it('should handle different workspaces in isolation', async () => {
        const ws1 = [{ key: '1', value: 1, timestamp: 1 }];
        const ws2 = [{ key: '2', value: 2, timestamp: 2 }];

        await saveQueue('ws-1', ws1);
        await saveQueue('ws-2', ws2);

        const loaded1 = await loadQueue('ws-1');
        const loaded2 = await loadQueue('ws-2');

        expect(loaded1).toEqual(ws1);
        expect(loaded2).toEqual(ws2);
    });

    it('should handle openDB failure gracefully', async () => {
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

        // Mock open to fail
        const originalOpen = indexedDB.open;
        vi.spyOn(indexedDB, 'open').mockImplementation(() => {
            throw new Error('Explosion');
        });

        await saveQueue('ws-fail', []);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to save queue'), expect.any(Error));

        const loaded = await loadQueue('ws-fail');
        expect(loaded).toEqual([]);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to load queue'), expect.any(Error));

        consoleSpy.mockRestore();
    });

    it('should degrade gracefully if indexedDB is missing', async () => {
        // Temporarily remove indexedDB
        const original = globalThis.indexedDB;
        // @ts-ignore
        delete globalThis.indexedDB;

        try {
            const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

            await saveQueue('ws-no-idb', []);
            // Should verify fallback behavior (currently logs warn)
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to save queue'), expect.any(Error));

            const loaded = await loadQueue('ws-no-idb');
            expect(loaded).toEqual([]);
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to load queue'), expect.any(Error));

        } finally {
            globalThis.indexedDB = original;
        }
    });
});
