import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IndexedDBAdapter } from '../../src/adapters/IndexedDBAdapter';
import { mockIDB, MockIDBKeyRange } from '../mocks/MockIndexedDB';

describe('IndexedDBAdapter', () => {
    beforeEach(() => {
        // Mock global indexedDB
        vi.stubGlobal('indexedDB', mockIDB);
        vi.stubGlobal('IDBKeyRange', MockIDBKeyRange);
    });


    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('should initialize and create object store', async () => {
        const adapter = new IndexedDBAdapter('test-db');
        await adapter.init();
        expect(true).toBe(true);
    });

    it('should set and get values', async () => {
        const adapter = new IndexedDBAdapter('test-db');
        await adapter.init();

        await adapter.set('key1', new Uint8Array([1, 2, 3]));
        const val = await adapter.get('key1');

        expect(val).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('should return undefined for missing keys', async () => {
        const adapter = new IndexedDBAdapter('test-db');
        await adapter.init();
        const val = await adapter.get('missing');
        expect(val).toBeUndefined();
    });

    it('should delete keys', async () => {
        const adapter = new IndexedDBAdapter('test-db');
        await adapter.init();

        await adapter.set('key1', new Uint8Array([1]));
        await adapter.delete('key1');
        const val = await adapter.get('key1');

        expect(val).toBeUndefined();
    });

    it('should scan prefix', async () => {
        const adapter = new IndexedDBAdapter('test-db');
        await adapter.init();

        await adapter.set('a1', new Uint8Array([1]));
        await adapter.set('a2', new Uint8Array([2]));
        await adapter.set('b1', new Uint8Array([3]));

        const results = await adapter.scanPrefix('a');
        expect(results.length).toBe(2);
        expect(results[0][0]).toBe('a1');
        expect(results[1][0]).toBe('a2');
    });

    it('should close db', async () => {
        const adapter = new IndexedDBAdapter('test-db');
        await adapter.init();
        await expect(adapter.close()).resolves.not.toThrow();
    });

    it('should handle open errors', async () => {
        const adapter = new IndexedDBAdapter('test-db-fail');
        // Poison the open mock
        mockIDB.shouldFailOpen = true;
        await expect(adapter.init()).rejects.toThrow();
        mockIDB.shouldFailOpen = false;
    });

    it('should handle get errors', async () => {
        const adapter = new IndexedDBAdapter('test-db');
        await adapter.init();

        const store = mockIDB.dbs.get('test-db')?.stores.get('nmeshed_store');
        if (store) store.shouldFailNext = true;

        await expect(adapter.get('key1')).resolves.toBeUndefined();
    });

    it('should handle set errors', async () => {
        const adapter = new IndexedDBAdapter('test-db');
        await adapter.init();

        const store = mockIDB.dbs.get('test-db')?.stores.get('nmeshed_store');
        if (store) store.shouldFailNext = true;

        await expect(adapter.set('key1', new Uint8Array([1]))).resolves.not.toThrow();
    });

    it('should handle clear errors', async () => {
        const adapter = new IndexedDBAdapter('test-db');
        await adapter.init();

        const store = mockIDB.dbs.get('test-db')?.stores.get('nmeshed_store');
        if (store) store.shouldFailNext = true;

        await expect(adapter.clear('key1')).resolves.not.toThrow();
    });
});
