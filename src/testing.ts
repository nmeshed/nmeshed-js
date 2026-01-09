/**
 * nMeshed Testing Utilities
 * 
 * "A library without test utilities is a library that hates its users."
 * 
 * Ship these as first-class exports so developers don't have to build
 * 200+ LOC of mock infrastructure just to test CAS operations.
 */

import type { INMeshedClient, ClientEvents, ConnectionStatus } from './types';

/** Mock client for unit testing. No network, no WASM, no surprises. */
export class MockNMeshedClient implements INMeshedClient {
    private _store = new Map<string, unknown>();
    private _listeners = new Map<keyof ClientEvents, Set<Function>>();
    private _status: ConnectionStatus = 'ready';
    private _peerId: string;

    constructor(peerId = 'mock-peer') {
        this._peerId = peerId;
    }

    get<T = unknown>(key: string): T | undefined {
        return this._store.get(key) as T | undefined;
    }

    set<T = unknown>(key: string, value: T): void {
        this._store.set(key, value);
        this.emit('op', key, value, true);
    }

    delete(key: string): void {
        this._store.delete(key);
        this.emit('op', key, undefined, true);
    }

    cas<T = unknown>(key: string, expected: T | null, newValue: T): Promise<boolean> {
        const current = this.get<T>(key);
        const currentIsEmpty = current === undefined;
        const expectsEmpty = expected === null;

        if ((currentIsEmpty && expectsEmpty) || current === expected) {
            this.set(key, newValue);
            return Promise.resolve(true);
        }
        return Promise.resolve(false);
    }

    on<K extends keyof ClientEvents>(event: K, handler: ClientEvents[K]): () => void {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set());
        }
        this._listeners.get(event)!.add(handler);
        return () => this._listeners.get(event)?.delete(handler);
    }

    /** Test utility: emit an event to all listeners */
    emit<K extends keyof ClientEvents>(event: K, ...args: Parameters<ClientEvents[K]>): void {
        this._listeners.get(event)?.forEach(fn => (fn as Function)(...args));
    }

    getStatus(): ConnectionStatus {
        return this._status;
    }

    getPeerId(): string {
        return this._peerId;
    }

    disconnect(): void {
        this._status = 'disconnected';
        this.emit('status', 'disconnected');
    }

    awaitReady(): Promise<void> {
        return Promise.resolve();
    }

    store<T = any>(key: string): T {
        const existing = this.get<T>(key);
        if (existing !== undefined) return existing;
        // Return empty object as proxy target for writes
        const obj = {} as T;
        this.set(key, obj);
        return obj;
    }

    /** Subscribe to key changes (simplified for testing) */
    subscribe(key: string, callback: () => void): () => void {
        return this.on('op', (changedKey) => {
            if (changedKey === key || changedKey.startsWith(`${key}.`)) {
                callback();
            }
        });
    }

    // =========================================================================
    // Test Utilities
    // =========================================================================

    /** Get all stored data (for assertions) */
    getAllData(): Map<string, unknown> {
        return new Map(this._store);
    }

    /** Clear all stored data */
    clearAll(): void {
        this._store.clear();
    }

    /** Set status for testing reconnection flows */
    setStatus(status: ConnectionStatus): void {
        this._status = status;
        this.emit('status', status);
    }
}

/** Factory for creating configured mock clients */
export function createMockClient(options?: {
    peerId?: string;
    initialData?: Record<string, unknown>;
    status?: ConnectionStatus;
}): MockNMeshedClient {
    const client = new MockNMeshedClient(options?.peerId);

    if (options?.initialData) {
        Object.entries(options.initialData).forEach(([key, value]) => {
            client.set(key, value);
        });
    }

    if (options?.status) {
        client.setStatus(options.status);
    }

    return client;
}
