import { vi } from 'vitest';

// Golfed Request Mocks
export class MockIDBRequest {
    readyState = 'pending';
    result: any; error: any; source: any; transaction: any;
    onsuccess: ((e: any) => void) | null = null;
    onerror: ((e: any) => void) | null = null;

    trigger(type: 'Success' | 'Error', val: any) {
        this.readyState = 'done';
        this[type === 'Success' ? 'result' : 'error'] = val;
        if (type === 'Success') this.onsuccess?.({ target: this } as any);
        else this.onerror?.({ target: this } as any);
    }
}
export class MockIDBOpenDBRequest extends MockIDBRequest {
    onupgradeneeded: ((e: any) => void) | null = null;
}

// Helper to collapse 6 lines into 1
const asyncReq = <T>(fn: () => T, req = new MockIDBRequest()) => {
    setTimeout(() => {
        try { req.trigger('Success', fn()); }
        catch (e) { req.trigger('Error', e); }
    }, 0);
    return req;
};

export class MockIDBObjectStore {
    data = new Map<any, any>();
    shouldFailNext = false;
    constructor(public name: string) { }

    private req<T>(fn: () => T) {
        return asyncReq(() => {
            if (this.shouldFailNext) {
                this.shouldFailNext = false;
                throw new Error('MockIndexedDB Error');
            }
            return fn();
        });
    }

    put(v: any, k?: any) {
        return this.req(() => {
            const key = k || v.id || 'auto';
            this.data.set(key, v);
            return key;
        });
    }
    get(k: any) { return this.req(() => this.data.get(k)); }
    getAll() { return this.req(() => Array.from(this.data.values())); }
    getAllKeys() { return this.req(() => Array.from(this.data.keys())); }
    delete(k: any) { return this.req(() => this.data.delete(k)); }
    clear() { return this.req(() => this.data.clear()); }

    openCursor(range?: any) {
        const req = new MockIDBRequest();
        setTimeout(() => {
            const keys = Array.from(this.data.keys()).sort();
            let idx = 0;
            const next = () => {
                if (idx >= keys.length) return req.trigger('Success', null);
                const key = keys[idx];
                // Tiny implementation of range check
                if (range && ((range.lower && key < range.lower) || (range.upper && key > range.upper))) {
                    if (range.upper && key > range.upper) return req.trigger('Success', null);
                    idx++; return next();
                }
                req.trigger('Success', { key, value: this.data.get(key), continue: () => { idx++; setTimeout(next, 0); } });
            };
            next();
        }, 0);
        return req;
    }
}

export class MockIDBTransaction {
    db: MockIDBDatabase;
    oncomplete: ((e: any) => void) | null = null;
    constructor(db: MockIDBDatabase, public objectStoreNames: string[], public mode: string) {
        this.db = db;
        setTimeout(() => this.oncomplete?.({ target: this }), 0);
    }
    objectStore(name: string) { return this.db.stores.get(name); }
}

export class MockIDBDatabase {
    stores = new Map<string, MockIDBObjectStore>();
    objectStoreNames = {
        contains: (n: string) => this.stores.has(n),
        item: (i: number) => Array.from(this.stores.keys())[i],
        length: 0, [Symbol.iterator]: function* () { yield* [] }
    } as any;

    constructor(public name: string, public version: number) { }
    createObjectStore(name: string) {
        const store = new MockIDBObjectStore(name);
        this.stores.set(name, store);
        return store;
    }
    transaction(storeNames: string | string[], mode: string) {
        return new MockIDBTransaction(this, Array.isArray(storeNames) ? storeNames : [storeNames], mode);
    }
    close() { }
}

export class MockIndexedDB {
    dbs = new Map<string, MockIDBDatabase>();
    shouldFailOpen = false;
    open(name: string, ver: number) {
        const req = new MockIDBOpenDBRequest();
        setTimeout(() => {
            if (this.shouldFailOpen) {
                req.trigger('Error', new Error('Failed to open'));
                return;
            }
            let db = this.dbs.get(name);
            if (!db || db.version < ver) {
                const oldVer = db?.version || 0;
                db = new MockIDBDatabase(name, ver);
                this.dbs.set(name, db);
                req.onupgradeneeded?.({ target: { result: db, transaction: new MockIDBTransaction(db, [], 'versionchange') }, oldVersion: oldVer, newVersion: ver });
            }
            req.trigger('Success', db);
        }, 0);
        return req;
    }
}
export const mockIDB = new MockIndexedDB();

export class MockIDBKeyRange {
    static bound(lower: any, upper: any, lowerOpen?: boolean, upperOpen?: boolean) {
        return { lower, upper, lowerOpen, upperOpen };
    }
}

