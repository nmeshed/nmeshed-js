/**
 * NMeshed v2 - CRDT Engine
 * 
 * Action through Inaction: Prediction and reconciliation happen invisibly.
 * This is the heart of the sync engine - CRDT operations without the noise.
 */

import type { CRDTCore, Operation, ConnectionStatus, ClientEvents, EventHandler, IStorage } from './types';
import { encodeValue, decodeValue, MsgType, encodeCAS } from './protocol';

// =============================================================================
// Event Emitter
// =============================================================================

type ListenerMap = {
    [K in keyof ClientEvents]: Set<ClientEvents[K]>;
};

class EventEmitter {
    private listeners: ListenerMap = {
        op: new Set(),
        status: new Set(),
        error: new Set(),
        peerJoin: new Set(),
        peerLeave: new Set(),
        ready: new Set(),
        cas: new Set(),
    };

    on<K extends keyof ClientEvents>(event: K, handler: EventHandler<K>): () => void {
        (this.listeners[event] as Set<EventHandler<K>>).add(handler);
        return () => (this.listeners[event] as Set<EventHandler<K>>).delete(handler);
    }

    emit<K extends keyof ClientEvents>(event: K, ...args: Parameters<ClientEvents[K]>): void {
        (this.listeners[event] as Set<ClientEvents[K]>).forEach((handler) => {
            try {
                (handler as (...args: Parameters<ClientEvents[K]>) => void)(...args);
            } catch (error) {
                console.error(`[NMeshed] Error in ${event} handler:`, error);
            }
        });
    }

    clear(): void {
        Object.values(this.listeners).forEach((set) => set.clear());
    }
}

// =============================================================================
// =============================================================================
// Sync Engine
// =============================================================================

const PENDING_PREFIX = 'queue::';

export class SyncEngine extends EventEmitter {
    private state = new Map<string, unknown>();
    private status: ConnectionStatus = 'disconnected';
    private peerId: string;
    private pendingOps: Operation[] = [];
    private debug: boolean;
    private storage: IStorage;
    private clockOffset = 0; // Difference between server and local time

    // ...

    /** Set clock offset for drift correction */
    setClockOffset(offset: number): void {
        const previous = this.clockOffset;
        this.clockOffset = offset;
        this.log(`Clock offset adjusted: ${previous}ms -> ${offset}ms`);
    }

    /** Get corrected timestamp */
    private getTimestamp(): number {
        return Date.now() + this.clockOffset;
    }

    // WASM core (optional - for CRDT merge logic)
    private core: CRDTCore | null = null;

    constructor(peerId: string, storage: IStorage, debug = false) {
        super();
        this.peerId = peerId;
        this.storage = storage;
        this.debug = debug;
    }

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /** Get a value by key */
    get<T = unknown>(key: string): T | undefined {
        return this.state.get(key) as T | undefined;
    }

    /** Set a key-value pair (local operation) */
    set<T = unknown>(key: string, value: T): Uint8Array {
        const timestamp = this.getTimestamp();

        // Apply locally immediately (optimistic)
        this.state.set(key, value);

        // Emit change event
        this.emit('op', key, value, true);

        // Create wire payload
        const payload = encodeValue(value);

        // Queue for network send
        const op: Operation = { key, value, timestamp, peerId: this.peerId };
        this.pendingOps.push(op);

        // Persist Data (Async, Non-Blocking)
        this.storage.set(key, payload).catch(e => {
            console.error('[NMeshed] Persistence failed', e);
        });

        // Persist Queue (Offline Safety)
        const pendingKey = `${PENDING_PREFIX}${timestamp}::${key}`;
        this.storage.set(pendingKey, payload).catch(e => {
            console.error('[NMeshed] Queue persistence failed', e);
        });

        this.log(`Set: ${key} = ${JSON.stringify(value)}`);

        return payload;
    }

    /** Delete a key */
    delete(key: string): Uint8Array {
        // ... (similar to set, but let's reuse set logic if possible, or duplicate safely)
        // Existing delete implementation calls this.set at the end.
        // But it also calls storage.delete(key).
        // If we call set(key, null), it persists 'null' payload.
        // It ALSO adds to pendingOps.
        // It ALSO persists to queue.
        // So `delete` calling `set` handles queue logic correctly.
        // But `storage.delete(key)` removes the data key. `set` puts it back (as null).
        // If we want "tombstone" (null), then `set` is correct.
        // If we want "gone", `storage.delete` is correct.
        // Current implementation:
        /*
        this.state.delete(key);
        this.emit('op', key, null, true);
        this.storage.delete(key)...
        return this.set(key, null);
        */
        // This is double handling.
        // I will simplify `delete` to just call `set(key, null)` (Tombstone).
        // But checking previous implementation:
        /*
        this.state.delete(key);
        this.emit('op', key, null, true);
        this.storage.delete(key)...
        return this.set(key, null as unknown);
        */
        // This is messy. I will replace it.

        // Tombstone deletion (standard for CRDTs)
        return this.set(key, null);
    }

    /** Apply a remote operation */
    applyRemote(key: string, payload: Uint8Array, peerId: string): void {
        const value = decodeValue(payload);

        // Simple LWW merge (last-write-wins based on receipt order)
        // In production, the WASM core handles proper CRDT merge
        this.state.set(key, value);

        // Persist
        this.storage.set(key, payload).catch(e => {
            console.error('[NMeshed] Persistence remote failed', e);
        });

        this.emit('op', key, value, false);
        this.log(`Remote: ${key} from ${peerId}`);
    }

    /** 
     * Perform CAS operation
     * If optimistic, we check local state. 
     * Ideally, CAS should only be confirmed by server, but we can do optimistic check.
     */
    async cas<T = unknown>(key: string, expected: T | null, newValue: T): Promise<boolean> {
        const current = this.state.get(key) as T | undefined;

        // 1. Optimistic Local Check
        // If local state doesn't match, we fail immediately (Fast Fail).
        if (expected === null) {
            if (current !== undefined && current !== null) return false;
        } else {
            // Deep equality check is expensive. For primitives/simple objects, JSONstringify is "Zen Enough" for now.
            if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
        }

        // 2. Apply Optimistically
        this.state.set(key, newValue);
        this.emit('op', key, newValue, true);

        // 3. Send to Network (The Authority)
        const timestamp = this.getTimestamp();

        // Create Payload
        const newPayload = encodeValue(newValue);
        let expectedPayload: Uint8Array | null = null;
        if (expected !== null) {
            expectedPayload = encodeValue(expected);
        }

        // Queue Op
        const op: Operation = { key, value: newValue, timestamp, peerId: this.peerId };
        this.pendingOps.push(op);

        // Persist Data & Queue
        this.storage.set(key, newPayload).catch(e => console.error('[NMeshed] CAS Persistence failed', e));

        const pendingKey = `${PENDING_PREFIX}${timestamp}::${key}`;
        this.storage.set(pendingKey, newPayload).catch(e => console.error('[NMeshed] CAS Queue failed', e));

        // Emit CAS event for Client to send
        const wireData = encodeCAS(key, expectedPayload, newPayload, this.peerId);
        this.emit('cas', wireData);

        return true;
    }

    /** Load state from local storage */
    async loadFromStorage(): Promise<void> {
        const items = await this.storage.scanPrefix('');
        const queueItems: { key: string, payload: Uint8Array }[] = [];

        for (const [key, payload] of items) {
            if (key.startsWith(PENDING_PREFIX)) {
                queueItems.push({ key, payload });
                continue;
            }

            try {
                const value = decodeValue(payload);
                this.state.set(key, value);
            } catch (e) {
                this.log(`Failed to decode stored key ${key}`, e);
            }
        }

        // Reconstruct Pending Ops (Sorted by Timestamp in Key)
        // Key format: queue::TIMESTAMP::KEY
        queueItems.sort((a, b) => a.key.localeCompare(b.key));

        for (const item of queueItems) {
            try {
                const parts = item.key.split('::'); // ['queue', 'timestamp', 'key']
                if (parts.length < 3) continue;

                const timestamp = parseInt(parts[1], 10);
                const realKey = parts.slice(2).join('::'); // Join back in case key has ::
                const value = decodeValue(item.payload);

                this.pendingOps.push({
                    key: realKey,
                    value,
                    timestamp,
                    peerId: this.peerId // We assume we wrote it
                });
            } catch (e) {
                this.log('Failed to rehydrate pending op', e);
            }
        }

        this.log(`Loaded ${this.state.size} items and ${this.pendingOps.length} pending ops from storage`);
    }

    /** Load initial state from snapshot */
    loadSnapshot(data: Uint8Array): void {
        // Zen Principle: The State Machine knows its capabilities.

        // 1. If we have the Core (WASM), we delegate immediately.
        if (this.core) {
            this.core.loadSnapshot(data);
            return;
        }

        // 2. "Light Mode": Try to decode as a JS Object (MsgPack/JSON)
        try {
            const snapshot = decodeValue<Record<string, unknown>>(data);
            if (snapshot && typeof snapshot === 'object') {
                // Clear storage but PRESERVE Queue
                // Inefficient but safe: Clear all, then re-save queue.
                this.storage.clearAll().then(() => {
                    // 1. Persist Snapshot Data
                    for (const [key, value] of Object.entries(snapshot)) {
                        const payload = encodeValue(value);
                        this.storage.set(key, payload);
                    }
                    // 2. Persist Pending Queue (Restore it)
                    for (const op of this.pendingOps) {
                        const pendingKey = `${PENDING_PREFIX}${op.timestamp}::${op.key}`;
                        const payload = encodeValue(op.value);
                        this.storage.set(pendingKey, payload);
                    }
                });

                // Update Memory State
                this.state.clear();

                // Apply Snapshot
                for (const [key, value] of Object.entries(snapshot)) {
                    this.state.set(key, value);
                    this.emit('op', key, value, false);
                }

                // Re-Apply Pending Ops (Optimistic Overlay)
                // We trust our local changes are newer/relevant until acked/rejected
                for (const op of this.pendingOps) {
                    this.state.set(op.key, op.value);
                    this.emit('op', op.key, op.value, true);
                    // Should we emit? UI might need to know "Value is back to local version"
                    // Yes.
                }

                this.log(`Loaded snapshot (${Object.keys(snapshot).length} keys) + re-applied ${this.pendingOps.length} pending ops`);
            }
        } catch (e) {
            // 3. Binary/Opaque Snapshot?
            this.log('Could not decode snapshot in Light Mode (likely binary/WASM only). Starting fresh.');
        }
    }

    private isJson(data: Uint8Array): boolean {
        // Simple heuristic: Look for '{' (0x7B) or '[' (0x5B)
        // In a perfect world, we'd have a Content-Type header, 
        // but bytes are precious, so we infer from content.
        if (data.length === 0) return false;

        // Skip BOM/Whitespace if needed (simplified for Zen clarity)
        const firstByte = data[0];
        return firstByte === 0x7B || firstByte === 0x5B;
    }

    /** Export current state as snapshot */
    getSnapshot(): Record<string, unknown> {
        const snapshot: Record<string, unknown> = {};
        this.state.forEach((value, key) => {
            snapshot[key] = value;
        });
        return snapshot;
    }

    /** Get all values */
    getAllValues(): Record<string, unknown> {
        return this.getSnapshot();
    }

    /** Iterate over all entries */
    forEach(callback: (value: unknown, key: string) => void): void {
        this.state.forEach((value, key) => callback(value, key));
    }

    /** Get current status */
    getStatus(): ConnectionStatus {
        return this.status;
    }

    /** Update connection status */
    setStatus(status: ConnectionStatus): void {
        if (this.status !== status) {
            this.status = status;
            this.emit('status', status);
            this.log(`Status: ${status}`);
        }
    }

    /** Get peer ID */
    getPeerId(): string {
        return this.peerId;
    }

    /** Get pending operations count */
    getPendingCount(): number {
        return this.pendingOps.length;
    }

    /** Clear pending operations */
    clearPending(): void {
        this.pendingOps = [];
    }

    /** Drain pending operations */
    drainPending(): Operation[] {
        const ops = this.pendingOps;
        this.pendingOps = [];

        // Clear from storage
        for (const op of ops) {
            const pendingKey = `${PENDING_PREFIX}${op.timestamp}::${op.key}`;
            this.storage.delete(pendingKey).catch(e => {
                // Non-critical if delete fails (will just come back as ghost pending, handled by dedupe eventually)
                // But we should try.
            });
        }

        return ops;
    }

    /** Clean up */
    destroy(): void {
        this.clear();
        this.state.clear();
        this.pendingOps = [];
    }

    // ---------------------------------------------------------------------------
    // WASM Core Integration
    // ---------------------------------------------------------------------------

    /** Attach WASM core for proper CRDT operations */
    attachCore(core: CRDTCore): void {
        this.core = core;
        this.log('WASM core attached');
    }

    // ---------------------------------------------------------------------------
    // Private
    // ---------------------------------------------------------------------------

    private log(...args: unknown[]): void {
        if (this.debug) {
            console.log('[NMeshed Engine]', ...args);
        }
    }
}
