import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadQueue, saveQueue } from './persistence';
import 'fake-indexeddb/auto';

describe('Persistence (Real IndexedDB)', () => {
    // Enable "real" IDB path (using fake-indexeddb) in tests
    process.env.USE_REAL_IDB = 'true';

    const DB_NAME = 'nmeshed_db';

    afterEach(async () => {
        // Clear database
        const req = indexedDB.deleteDatabase(DB_NAME);
        await new Promise((resolve, reject) => {
            req.onsuccess = resolve;
            req.onerror = reject;
            req.onblocked = resolve;
        });
        vi.restoreAllMocks();
    });

    it('should save and load queue items correctly', async () => {
        const workspaceId = 'ws-test-1';
        const items = [
            { key: 'op1', value: { type: 'set', payload: 123 }, timestamp: 1000 },
            { key: 'op2', value: { type: 'del' }, timestamp: 1001 }
        ];

        await saveQueue(workspaceId, items);
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

        let loaded = await loadQueue(workspaceId);
        expect(loaded).toHaveLength(1);

        await saveQueue(workspaceId, []);
        loaded = await loadQueue(workspaceId);
        expect(loaded).toHaveLength(0);
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

    it('should handle openDB failure gracefully with silent fallback', async () => {
        vi.spyOn(indexedDB, 'open').mockImplementation(() => {
            throw new Error('Explosion');
        });

        const testData = [{ key: '1', value: 'v', timestamp: 1 }];
        await saveQueue('ws-fail', testData);
        const loaded = await loadQueue('ws-fail');
        expect(loaded).toEqual(testData);
    });

    it('should degrade gracefully if indexedDB is missing with silent fallback', async () => {
        const original = globalThis.indexedDB;
        // @ts-ignore
        delete globalThis.indexedDB;

        try {
            const testData = [{ key: '1', value: 'v', timestamp: 1 }];
            await saveQueue('ws-no-idb', testData);
            const loaded = await loadQueue('ws-no-idb');
            expect(loaded).toEqual(testData);
        } finally {
            globalThis.indexedDB = original;
        }
    });

    it('handles transaction errors in saveQueue', async () => {
        const originalTx = IDBDatabase.prototype.transaction;
        vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: any[]) {
            const tx = originalTx.apply(this, args as any);
            setTimeout(() => {
                // @ts-ignore
                if (tx.onerror) tx.onerror({ target: tx });
            }, 0);
            return tx;
        });

        const testData = [{ key: '1', value: 'tx-fail', timestamp: 1 }];
        await saveQueue('ws-tx-fail', testData);
        const loaded = await loadQueue('ws-tx-fail');
        expect(loaded).toEqual(testData);
    });

    it('handles request errors in loadQueue', async () => {
        const originalTx = IDBDatabase.prototype.transaction;
        vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: any[]) {
            const tx = originalTx.apply(this, args as any);
            const originalStore = tx.objectStore;
            tx.objectStore = function (name: string) {
                const store = originalStore.call(tx, name);
                const originalGet = store.get;
                store.get = function (key: any) {
                    const req = originalGet.call(store, key);
                    setTimeout(() => {
                        // @ts-ignore
                        if (req.onerror) req.onerror({ target: req });
                    }, 0);
                    return req;
                };
                return store;
            };
            return tx;
        });

        const result = await loadQueue('ws-req-fail-new');
        expect(result).toEqual([]);

        vi.restoreAllMocks();
    });
});
