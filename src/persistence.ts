/**
 * Persistence layer using IndexedDB to avoid blocking the main thread.
 * This replaces synchronous localStorage calls which cause frame drops.
 */

const DB_NAME = 'nmeshed_db';
const STORE_NAME = 'operation_queue';
const DB_VERSION = 1;

/**
 * Represents an item stored in the persistence queue.
 * Intentionally typed as `any` to support heterogeneous operation formats:
 * - Pre-connect state entries: `{ type: 'pre', k: string, v: any }`
 * - Operation queue entries: Uint8Array binary deltas
 * - Legacy migration entries: JSON objects
 * 
 * This flexibility is critical for backward compatibility and offline-first recovery.
 */
export type PersistentQueueItem = any;
const memoryStore = new Map<string, PersistentQueueItem[]>();

/**
 * Opens the IndexedDB database.
 */
function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined' || (typeof process !== 'undefined' && process.env.NODE_ENV === 'test' && !process.env.USE_REAL_IDB)) {
            reject(new Error('IndexedDB not available'));
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);

        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME); // Key is workspaceId
            }
        };
    });
}


/**
 * Saves the queue array for a specific storage key.
 * Uses a readwrite transaction.
 */
export async function saveQueue(storageKey: string, queue: PersistentQueueItem[]): Promise<void> {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);

            if (queue.length === 0) {
                store.delete(storageKey);
            } else {
                store.put(queue, storageKey);
            }

            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                db.close();
                reject(tx.error);
            };
        });
    } catch (error) {
        // Silent In-Memory Fallback for Node/Tests
        memoryStore.set(storageKey, queue);
    }
}

/**
 * Loads the queue for a specific storage key.
 */
export async function loadQueue(storageKey: string): Promise<PersistentQueueItem[]> {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.get(storageKey);

            request.onsuccess = () => {
                db.close();
                resolve(request.result || []);
            };
            request.onerror = () => {
                db.close();
                reject(request.error);
            };
        });
    } catch (error) {
        // Silent In-Memory Fallback for Node/Tests
        return memoryStore.get(storageKey) || [];
    }
}
