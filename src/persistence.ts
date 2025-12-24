/**
 * Persistence layer using IndexedDB to avoid blocking the main thread.
 * This replaces synchronous localStorage calls which cause frame drops.
 */

const DB_NAME = 'nmeshed_db';
const STORE_NAME = 'operation_queue';
const DB_VERSION = 1;

export type PersistentQueueItem = any;

/**
 * Opens the IndexedDB database.
 */
function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
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
 * Saves the queue array for a specific workspace.
 * Uses a readwrite transaction.
 */
export async function saveQueue(workspaceId: string, queue: PersistentQueueItem[]): Promise<void> {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);

            if (queue.length === 0) {
                store.delete(workspaceId);
            } else {
                store.put(queue, workspaceId);
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
        console.warn('[nMeshed] Failed to save queue to IndexedDB:', error);
    }
}

/**
 * Loads the queue for a specific workspace.
 */
export async function loadQueue(workspaceId: string): Promise<PersistentQueueItem[]> {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.get(workspaceId);

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
        console.warn('[nMeshed] Failed to load queue from IndexedDB:', error);
        return [];
    }
}
