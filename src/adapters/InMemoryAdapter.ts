import { IStorage } from '../types';

/**
 * In-Memory Storage Adapter
 * Used for testing and fallback when IndexedDB is unavailable (e.g. Node.js environment without polyfill).
 */
export class InMemoryAdapter implements IStorage {
    private data: Map<string, Uint8Array> = new Map();

    init(): Promise<void> {
        return Promise.resolve();
    }

    get(key: string): Promise<Uint8Array | undefined> {
        return Promise.resolve(this.data.get(key));
    }

    set(key: string, value: Uint8Array): Promise<void> {
        this.data.set(key, value);
        return Promise.resolve();
    }

    delete(key: string): Promise<void> {
        this.data.delete(key);
        return Promise.resolve();
    }

    scanPrefix(prefix: string): Promise<Array<[string, Uint8Array]>> {
        const results: Array<[string, Uint8Array]> = [];
        for (const [key, value] of this.data.entries()) {
            if (key.startsWith(prefix)) {
                results.push([key, value]);
            }
        }
        // Sort by key to match IDB behavior (lexicographical)
        results.sort((a, b) => a[0].localeCompare(b[0]));
        return Promise.resolve(results);
    }

    clear(key: string): Promise<void> {
        return this.delete(key);
    }

    clearAll(): Promise<void> {
        this.data.clear();
        return Promise.resolve();
    }

    close(): Promise<void> {
        this.data.clear();
        return Promise.resolve();
    }
}
