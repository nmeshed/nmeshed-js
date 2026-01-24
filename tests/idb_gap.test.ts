
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IndexedDBAdapter } from '../src/adapters/IndexedDBAdapter';

// Mock IndexedDB globally
const mockDB = {
    transaction: vi.fn(),
    createObjectStore: vi.fn(),
    objectStoreNames: { contains: vi.fn() },
    close: vi.fn(),
} as any;

const mockRequest = {
    error: null,
    result: mockDB,
    onsuccess: null as any,
    onerror: null as any,
    onupgradeneeded: null as any,
} as any;

const mockOpen = vi.fn().mockReturnValue(mockRequest);

// Helper must be defined
const triggerSuccess = () => {
    if (mockRequest.onsuccess) mockRequest.onsuccess({ target: mockRequest });
};

describe('IndexedDB Coverage Gaps', () => {
    beforeEach(() => {
        vi.stubGlobal('indexedDB', { open: mockOpen });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('should handle transaction errors gracefully', async () => {
        const adapter = new IndexedDBAdapter('fail-test');
        const initPromise = adapter.init();

        // Trigger success for init
        triggerSuccess();
        await initPromise;

        // Spy on transaction creation to fail
        mockDB.transaction.mockImplementation(() => {
            throw new Error('Transaction Failed');
        });

        await expect(adapter.set('k', new Uint8Array())).rejects.toThrow('Transaction Failed');
        await expect(adapter.get('k')).rejects.toThrow('Transaction Failed');
        await expect(adapter.delete('k')).rejects.toThrow('Transaction Failed');
        await expect(adapter.clearAll()).rejects.toThrow('Transaction Failed');
    });

    it('should handle clear(key) alias', async () => {
        const adapter = new IndexedDBAdapter('alias-test');
        // Mock set implementation to succeed
        const mockStore = {
            put: vi.fn().mockReturnValue({ onsuccess: null, onerror: null }),
            delete: vi.fn().mockReturnValue({ onsuccess: null, onerror: null }),
            get: vi.fn().mockReturnValue({ onsuccess: null, onerror: null, result: undefined }),
        };
        mockDB.transaction.mockReturnValue({
            objectStore: () => mockStore
        });

        const initPromise = adapter.init();
        triggerSuccess();
        await initPromise;

        // Spy on delete
        const deleteSpy = vi.spyOn(adapter, 'delete').mockResolvedValue(undefined);

        await adapter.clear('k');

        expect(deleteSpy).toHaveBeenCalledWith('k');
    });

    it('should return undefined for corrupted (non-Uint8Array) data in get', async () => {
        const adapter = new IndexedDBAdapter('corrupt-test');
        // Mock get to return a string instead of Uint8Array
        const mockStore = {
            get: vi.fn().mockReturnValue({ onsuccess: null, onerror: null, result: "valid-string-but-invalid-type" }),
        };
        mockDB.transaction.mockReturnValue({
            objectStore: () => mockStore
        });

        const initPromise = adapter.init();
        triggerSuccess();
        await initPromise;

        let capturedRequest: any;
        mockStore.get.mockImplementation(() => {
            capturedRequest = { result: "corrupt", onsuccess: null, onerror: null };
            // Trigger success async
            setTimeout(() => {
                if (capturedRequest.onsuccess) capturedRequest.onsuccess({ target: { result: "corrupt" } });
            }, 0);
            return capturedRequest;
        });

        const val = await adapter.get('k');
        expect(val).toBeUndefined();
    });
});
