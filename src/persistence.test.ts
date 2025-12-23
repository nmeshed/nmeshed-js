import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { saveQueue, loadQueue, PersistentQueueItem } from './persistence';

// Mock IndexedDB types
type MockIDBDatabase = {
    transaction: any;
    objectStoreNames: { contains: (name: string) => boolean };
    createObjectStore: (name: string) => void;
    close: () => void;
};

type MockIDBRequest = {
    result: any;
    error: any;
    onsuccess: ((ev: Event) => void) | null;
    onerror: ((ev: Event) => void) | null;
    onupgradeneeded: ((ev: Event) => void) | null;
};

describe('persistence', () => {
    let mockDB: MockIDBDatabase;
    let mockTx: any;
    let mockStore: any;
    let mockOpenRequest: MockIDBRequest;

    beforeEach(() => {
        // Reset mocks
        mockStore = {
            put: vi.fn(),
            get: vi.fn(),
            delete: vi.fn(),
        };

        mockTx = {
            objectStore: vi.fn(() => mockStore),
            oncomplete: null,
            onerror: null,
            error: null,
        };

        mockDB = {
            transaction: vi.fn(() => mockTx),
            objectStoreNames: { contains: vi.fn(() => false) },
            createObjectStore: vi.fn(),
            close: vi.fn(),
        };

        mockOpenRequest = {
            result: mockDB,
            error: null,
            onsuccess: null,
            onerror: null,
            onupgradeneeded: null,
        };

        // Mock global indexedDB
        const mockIndexedDB = {
            open: vi.fn(() => {
                // Simulate async success
                setTimeout(() => {
                    mockOpenRequest.onsuccess?.({ target: mockOpenRequest } as any);
                }, 0);
                return mockOpenRequest;
            }),
        };

        vi.stubGlobal('indexedDB', mockIndexedDB);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('saves a queue successfully', async () => {
        const queue: PersistentQueueItem[] = [
            { key: 'k1', value: 'v1', timestamp: 1000 },
        ];

        const savePromise = saveQueue('ws1', queue);

        // Simulate tx success
        setTimeout(() => {
            mockTx.oncomplete?.();
        }, 0);

        await savePromise;

        expect(mockStore.put).toHaveBeenCalledWith(queue, 'ws1');
    });

    it('loads a queue successfully', async () => {
        const expectedQueue = [{ key: 'k1', value: 'v1', timestamp: 1000 }];

        // Setup get request mock
        const mockGetRequest = {
            result: expectedQueue,
            error: null,
            onsuccess: null,
            onerror: null,
        };
        mockStore.get.mockReturnValue(mockGetRequest);

        const loadPromise = loadQueue('ws1');

        // Simulate DB open success (handled by open mock above)
        // Simulate get success
        setTimeout(() => {
            mockGetRequest.onsuccess?.({ target: mockGetRequest } as any);
        }, 10);

        const result = await loadPromise;
        expect(result).toEqual(expectedQueue);
    });

    it('deletes entry if queue is empty', async () => {
        const savePromise = saveQueue('ws1', []);

        setTimeout(() => {
            mockTx.oncomplete?.();
        }, 0);

        await savePromise;

        expect(mockStore.delete).toHaveBeenCalledWith('ws1');
        expect(mockStore.put).not.toHaveBeenCalled();
    });

    it('handles DB open errors', async () => {
        // Override open to fail
        (global.indexedDB.open as any).mockImplementation(() => {
            const req = {
                error: new Error('DB Open Failed'),
                onsuccess: null,
                onerror: null,
            };
            setTimeout(() => {
                req.onerror?.({ target: req } as any);
            }, 0);
            return req;
        });

        // Test save failure (should catch and log, not throw)
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        await saveQueue('ws1', []);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to save'), expect.any(Error));

        // Test load failure (should return empty array)
        const result = await loadQueue('ws1');
        expect(result).toEqual([]);

        consoleSpy.mockRestore();
    });

    it('calls onupgradeneeded to create store', async () => {
        // Simulate DB that needs upgrade
        (global.indexedDB.open as any).mockImplementation(() => {
            const req: MockIDBRequest = {
                result: mockDB,
                error: null,
                onsuccess: null,
                onerror: null,
                onupgradeneeded: null,
            };
            setTimeout(() => {
                // Call onupgradeneeded first
                (mockDB.objectStoreNames.contains as any).mockReturnValue(false);
                req.onupgradeneeded?.({ target: req } as any);
                // Then success
                req.onsuccess?.({ target: req } as any);
            }, 0);
            return req;
        });

        const savePromise = saveQueue('ws1', []);
        setTimeout(() => mockTx.oncomplete?.(), 5);
        await savePromise;

        expect(mockDB.createObjectStore).toHaveBeenCalled();
    });
});
