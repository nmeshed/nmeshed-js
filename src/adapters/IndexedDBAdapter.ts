import { IStorage } from '../types';

/**
 * Zen IndexedDB Adapter
 * 
 * "Essence of Data": Storing only what is needed, where it is needed.
 * "Non-Resistance": Using native browser capabilities without heavy wrappers.
 * 
 * Implements IStorage using raw IndexedDB for maximum performance and zero dependencies.
 */
export class IndexedDBAdapter implements IStorage {
    private dbName: string;
    private storeName: string = 'nmeshed_data';
    private db: IDBDatabase | null = null;
    private readyPromise: Promise<void> | null = null;

    constructor(workspaceId: string) {
        this.dbName = `nmeshed_${workspaceId}`;
    }

    init(): Promise<void> {
        if (this.readyPromise) return this.readyPromise;

        this.readyPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);

            request.onerror = () => {
                reject(new Error(`Failed to open IndexedDB: ${request.error?.message}`));
            };

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName);
                }
            };

            request.onsuccess = (event) => {
                this.db = (event.target as IDBOpenDBRequest).result;
                resolve();
            };
        });

        return this.readyPromise;
    }

    async get(key: string): Promise<Uint8Array | undefined> {
        await this.init();
        return new Promise((resolve, reject) => {
            if (!this.db) return reject(new Error("DB not initialized"));

            const tx = this.db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const request = store.get(key);

            request.onsuccess = () => {
                const result = request.result;
                if (result instanceof Uint8Array || result === undefined) {
                    resolve(result);
                } else {
                    // Should verify type safety if needed, but we assume Uint8Array
                    resolve(undefined);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    async set(key: string, value: Uint8Array): Promise<void> {
        await this.init();
        return new Promise((resolve, reject) => {
            if (!this.db) return reject(new Error("DB not initialized"));

            const tx = this.db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.put(value, key);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async delete(key: string): Promise<void> {
        await this.init();
        return new Promise((resolve, reject) => {
            if (!this.db) return reject(new Error("DB not initialized"));

            const tx = this.db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.delete(key);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async scanPrefix(prefix: string): Promise<Array<[string, Uint8Array]>> {
        await this.init();
        return new Promise((resolve, reject) => {
            if (!this.db) return reject(new Error("DB not initialized"));

            const results: Array<[string, Uint8Array]> = [];
            const tx = this.db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);

            // Create a key range for the prefix
            // Start: "prefix"
            // End: "prefix" + "\uffff" (lexicographically last char)
            const range = IDBKeyRange.bound(prefix, prefix + '\uffff', false, false);

            const request = store.openCursor(range);

            request.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest).result as IDBCursorWithValue;
                if (cursor) {
                    if (cursor.value instanceof Uint8Array) {
                        results.push([cursor.key as string, cursor.value]);
                    }
                    cursor.continue();
                } else {
                    resolve(results);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    async clear(key: string): Promise<void> {
        return this.delete(key);
    }

    async clearAll(): Promise<void> {
        await this.init();
        return new Promise((resolve, reject) => {
            if (!this.db) return reject(new Error("DB not initialized"));

            const tx = this.db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.clear();

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async close(): Promise<void> {
        if (this.db) {
            this.db.close();
        }
        this.db = null;
        this.readyPromise = null;
    }
}
