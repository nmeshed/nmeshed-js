/**
 * @module Engine
 * @description
 * The `SyncEngine` is the heart of nMeshed. It implements a "Light CRDT" (Conflict-Free Replicated Data Type)
 * using Last-Write-Wins (LWW) Register semantics.
 * 
 * ## Synchronization Model
 * 
 * ```mermaid
 * flowchart LR
 *     User[User Interaction] -->|Local Mutate| Engine
 *     Engine -->|Optimistic Update| UI[UI State]
 *     Engine -->|Persist| Storage[IndexedDB]
 *     Engine -->|Queue Op| Buffer[Pending Op Queue]
 *     Buffer -->|Flush| Network[WebSocket]
 *     Network -->|Remote Op| Engine
 *     Engine -->|Reconcile (LWW)| UI
 * ```
 * 
 * ## Conflict Resolution (LWW)
 * 1. **Timestamp**: Higher timestamp wins.
 * 2. **Peer ID**: Lexicographical tie-breaker if timestamps are identical.
 * 
 * This ensures eventual consistency across all distributed peers without requiring a central coordinator.
 */

import type { CRDTCore, Operation, ConnectionStatus, ClientEvents, EventHandler, IStorage } from './types';
import type { EncryptionAdapter } from './encryption';
import { encodeValue, decodeValue, MsgType, encodeCAS } from './protocol';

/**
 * Deep equality check for CAS operations.
 * Unlike JSON.stringify, this is order-independent for object keys.
 */
function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== typeof b) return false;

    if (typeof a !== 'object') return a === b;

    // Arrays
    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) return false;
        return a.every((item, i) => deepEqual(item, b[i]));
    }

    // Objects - order-independent comparison
    const keysA = Object.keys(a as object);
    const keysB = Object.keys(b as object);
    if (keysA.length !== keysB.length) return false;

    return keysA.every(key =>
        key in (b as object) &&
        deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    );
}

// =============================================================================
// Event Emitter
// =============================================================================

type ListenerMap = {
    [K in keyof ClientEvents]: Set<ClientEvents[K]>;
};

/**
 * A type-safe implementation of the Event Emitter pattern.
 * Used internally for plumbing op/status events.
 */
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

/** Entry in the state map with value and timestamp for LWW ordering */
interface StateEntry {
    value: unknown;
    timestamp: number;
    peerId: string;
    lastCiphertext?: Uint8Array;
}

export class SyncEngine extends EventEmitter {
    // State now stores timestamps for proper LWW ordering
    private state = new Map<string, StateEntry>();
    private status: ConnectionStatus = 'disconnected';
    private peerId: string;
    private pendingOps: Operation[] = [];
    private debug: boolean;
    private storage: IStorage;
    private clockOffset = 0; // Difference between server and local time
    private encryption?: EncryptionAdapter;

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

    constructor(peerId: string, storage: IStorage, debug = false, encryption?: EncryptionAdapter) {
        super();
        this.peerId = peerId;
        this.storage = storage;
        this.debug = debug;
        this.encryption = encryption;
    }

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /** Get a value by key */
    get<T = unknown>(key: string): T | undefined {
        const entry = this.state.get(key);
        return entry?.value as T | undefined;
    }

    /** 
     * Sets a value for a key (Local Operation).
     * 
     * @remarks
     * **Optimistic Execution Flow:**
     * 1. **Apply to Memory**: Updates `this.state` immediately so the UI reflects the change.
     * 2. **Persist Data**: Saves the new value to Storage (e.g. IndexedDB) for offline availability.
     * 3. **Queue Op**: Adds the op to `pendingOps` and persists any pending queue to ensuring it survives a reload.
     * 4. **Emit Event**: Triggers 'op' event for the Transport to broadcast (if connected).
     * 
     * @param key - The key identifier.
     * @param value - The value to store.
     * @returns The encoded payload (Uint8Array) ready for wire transmission.
     */
    async set<T = unknown>(key: string, value: T): Promise<Uint8Array> {
        const timestamp = this.getTimestamp();

        // Create wire payload
        // E2EE: If encryption is enabled, encrypt the payload
        let payload = encodeValue(value);
        if (this.encryption) {
            payload = await this.encryption.encrypt(payload);
        }

        // Apply locally immediately (optimistic) - store with timestamp and ciphertext
        this.state.set(key, { value, timestamp, peerId: this.peerId, lastCiphertext: payload });

        // Emit change event
        this.emit('op', key, value, true, timestamp);

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

    /**
     * Deletes a key (Tombstone Operation).
     * 
     * @remarks
     * In distributed systems, you cannot simply "delete" a key, as old state might resurrect it.
     * Instead, we set the value to `null`, effectively marking it as a tombstone.
     * 
     * @param key - Key to remove.
     */
    async delete(key: string): Promise<Uint8Array> {
        // Tombstone deletion (standard for CRDTs)
        return this.set(key, null);
    }

    /**
     * Applies a remote operation from another peer.
     * ...
     */
    async applyRemote(key: string, payload: Uint8Array, peerId: string, timestamp?: number): Promise<void> {
        // E2EE: Decrypt if needed
        let finalPayload = payload;
        if (this.encryption) {
            try {
                finalPayload = await this.encryption.decrypt(payload);
            } catch (e) {
                console.error(`[NMeshed] Decryption failed for remote op ${key}`, e);
                return; // Drop invalid data
            }
        }

        const value = decodeValue(finalPayload);
        const incomingTs = timestamp ?? Date.now();

        // Proper LWW merge: only accept if incoming timestamp is newer
        const existing = this.state.get(key);
        if (existing) {
            if (existing.timestamp > incomingTs) {
                this.log(`LWW: Rejected stale op for ${key}`);
                return;
            }
            if (existing.timestamp === incomingTs && existing.peerId >= peerId) {
                return;
            }
        }

        // Apply newer value
        this.state.set(key, { value, timestamp: incomingTs, peerId, lastCiphertext: payload });

        // Persist (store ENCRYPTED payload if usage implies generic persistence of what was received)
        // Wait: The storage expects the serialized format. If we received encrypted bytes, we should store encrypted bytes.
        // The persistence logic uses `payload`. `payload` is the raw incoming bytes.
        // If we have encryption, `payload` IS encrypted. So we store it as is. Correct.
        this.storage.set(key, payload).catch(e => {
            console.error('[NMeshed] Persistence remote failed', e);
        });

        this.emit('op', key, value, false, incomingTs);
        this.log(`Remote: ${key} from ${peerId} (ts: ${incomingTs})`);
    }

    /** 
     * Performs an Atomic Compare-And-Swap (CAS).
     * 
     * @remarks
     * Unlike `set`, `cas` creates a special operation that the Server validates.
     * Ideally, we would wait for the server ack. However, for UX responsiveness,
     * we perform an **Optimistic Check** locally. if the local state matches expectation,
     * we apply the change immediately and presume valid.
     * 
     * If the server rejects it (due to race condition), the correction will arrive as a remote sync op.
     * 
     * @returns `true` if locally successful (optimistic), `false` if local check failed.
     */
    async cas<T = unknown>(key: string, expected: T | null, newValue: T): Promise<boolean> {
        const entry = this.state.get(key);
        const current = entry?.value as T | undefined;

        // 1. Optimistic Local Check
        // If local state doesn't match, we fail immediately (Fast Fail).
        if (expected === null) {
            if (current !== undefined && current !== null) return false;
        } else {
            if (!deepEqual(current, expected)) return false;
        }

        // 2. Prepare Payloads
        const plainNew = encodeValue(newValue);
        let expectedPayload: Uint8Array | null = null;
        let newPayload: Uint8Array = plainNew;

        if (this.encryption) {
            // STRICT E2EE CAS:
            // To ensure the server's comparison works with randomized IVs,
            // we MUST send the exact ciphertext we currently have for 'expected'.
            if (expected !== null) {
                expectedPayload = entry?.lastCiphertext || null;
                // Defensive: if we don't have ciphertext for some reason, we can't do safe CAS
                if (!expectedPayload) return false;
            }
            newPayload = await this.encryption.encrypt(plainNew);
        } else {
            if (expected !== null) {
                expectedPayload = encodeValue(expected);
            }
        }

        // 3. Apply Optimistically - store with timestamp
        const timestamp = this.getTimestamp();
        this.state.set(key, { value: newValue, timestamp, peerId: this.peerId, lastCiphertext: newPayload });
        this.emit('op', key, newValue, true, timestamp);

        // 4. Queue Op for network sync
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

    /**
     * Rehydrates state from persistent storage (IndexedDB).
     * 
     * @remarks
     * Also restores pending operations that were queued but not sent (Offline -> Reload -> Online scenario).
     */
    async loadFromStorage(): Promise<void> {
        const items = await this.storage.scanPrefix('');
        const queueItems: { key: string, payload: Uint8Array }[] = [];

        for (const [key, payload] of items) {
            if (key.startsWith(PENDING_PREFIX)) {
                queueItems.push({ key, payload });
                continue;
            }

            try {
                let finalPayload = payload;
                if (this.encryption) {
                    finalPayload = await this.encryption.decrypt(payload);
                }
                const value = decodeValue(finalPayload);
                this.state.set(key, { value, timestamp: 1, peerId: '', lastCiphertext: payload });
            } catch (e) {
                this.log(`Failed to decode stored key ${key}`, e);
            }
        }

        // Reconstruct Pending Ops
        queueItems.sort((a, b) => a.key.localeCompare(b.key));

        for (const item of queueItems) {
            try {
                const parts = item.key.split('::');
                if (parts.length < 3) continue;

                const timestamp = parseInt(parts[1], 10);
                const realKey = parts.slice(2).join('::');

                let finalPayload = item.payload;
                if (this.encryption) {
                    finalPayload = await this.encryption.decrypt(item.payload);
                }

                const value = decodeValue(finalPayload);

                this.pendingOps.push({
                    key: realKey,
                    value,
                    timestamp,
                    peerId: this.peerId
                });
            } catch (e) {
                this.log('Failed to rehydrate pending op', e);
            }
        }

        this.log(`Loaded ${this.state.size} items and ${this.pendingOps.length} pending ops from storage`);
    }

    /** 
     * Loads a full state snapshot from the server.
     * 
     * @remarks
     * **"Light Mode" Logic:**
     * If WASM core is not present, we assume the snapshot is a MsgPack map of Key->Value.
     * We discard local state (except pending ops) and replace it with the snapshot.
     */
    /** 
     * Loads a full state snapshot from the server.
     * 
     * @remarks
     * **"Light Mode" Logic:**
     * If WASM core is not present, we assume the snapshot is a MsgPack map of Key->Value.
     * We discard local state (except pending ops) and replace it with the snapshot.
     * 
     * **E2EE Handling**:
     * If encryption is enabled, the values in the snapshot are assumed to be Encrypted Blobs (Uint8Array).
     * We decrypt them before updating the in-memory state, but we store the **raw ciphertext** 
     * in the persistent storage to maintain consistency (storage always holds what the server has).
     */
    /** 
     * Loads a full state snapshot from the server.
     * 
     * @remarks
     * **"Light Mode" Logic:**
     * If WASM core is not present, we assume the snapshot is a MsgPack map of Key->Value.
     * We discard local state (except pending ops) and replace it with the snapshot.
     */
    async loadSnapshot(data: Uint8Array, serverTime?: number): Promise<void> {
        try {
            const snapshot = decodeValue<Record<string, unknown>>(data);
            if (!snapshot || typeof snapshot !== 'object') return;

            // Clear storage to match server state (Authoritative Sync)
            await this.storage.clearAll();

            // 1. Process Snapshot (Decrypt & Persist)
            const entries = await this.processSnapshotEntries(snapshot);

            // 2. Persist Pending Queue (Restore it)
            await this.restorePendingOps();

            // 3. Update In-Memory State (Atomic Swap)
            this.applySnapshotToMemory(entries, serverTime);

            this.log(`Loaded snapshot (${entries.length} items) | E2EE: ${!!this.encryption}`);

        } catch (e) {
            this.log('Could not decode snapshot', e);
        }
    }

    /** Helper: Process snapshot entries, handling E2EE decryption and Persistence */
    private async processSnapshotEntries(snapshot: Record<string, unknown>): Promise<[string, any][]> {
        const entries: [string, any][] = [];

        for (const [key, rawValue] of Object.entries(snapshot)) {
            let val = rawValue;
            let storedValue = rawValue; // Default: store what we received

            if (this.encryption) {
                try {
                    // In E2EE mode, rawValue MUST be a Uint8Array (Ciphertext)
                    if (rawValue instanceof Uint8Array) {
                        const clearText = await this.encryption.decrypt(rawValue);
                        val = decodeValue(clearText);
                        // storedValue is already ciphertext (rawValue), so we keep it.
                    }
                } catch (e) {
                    console.error(`[NMeshed] Failed to decrypt snapshot key ${key}`, e);
                    continue; // Skip invalid keys
                }
            } else {
                // Plain Text Mode: We need to encode it back to bytes for storage if it isn't already
                // (Although typically snapshot values are effectively structural, the storage expects Uint8Array usually)
                // Wait: storage.set expects Uint8Array. 
                storedValue = encodeValue(rawValue);
            }

            // Memory: Store Decrypted Value
            entries.push([key, val]);

            // Disk: Store (Ciphertext if E2EE, Encoded if Plain)
            await this.storage.set(key, storedValue as Uint8Array).catch(e => {
                this.log(`Failed to persist key ${key}`, e);
            });
        }
        return entries;
    }

    /** Helper: Re-persist pending ops */
    private async restorePendingOps(): Promise<void> {
        for (const op of this.pendingOps) {
            const pendingKey = `${PENDING_PREFIX}${op.timestamp}::${op.key}`;

            // Pending Ops in memory are decrypted/clean.
            // We must encrypt them before persisting to the queue.
            let p = encodeValue(op.value);
            if (this.encryption) {
                p = await this.encryption.encrypt(p);
            }
            await this.storage.set(pendingKey, p);
        }
    }

    /** Helper: Update in-memory state */
    private applySnapshotToMemory(entries: [string, any][], serverTime?: number): void {
        this.state.clear();
        // We use the serverTime (or fallback) for snapshots to ensure they are authoritative
        const baseTs = serverTime || 1;

        for (const [key, val] of entries) {
            // If val is a Uint8Array and we are in E2EE mode, it might be that we want to store the ciphertext
            // in 'lastCiphertext' for CAS operations later.
            // In `processSnapshotEntries`, we derived `val` (decrypted). 
            // Ideally we should track the ciphertext too if we want perfect CAS support.
            // For now, we reconstruct it if needed or accept null.
            // Re-encoding for CAS is acceptable for now.
            this.state.set(key, { value: val, timestamp: baseTs, peerId: '' });
            this.emit('op', key, val, false, baseTs);
        }

        // Re-Apply Pending Ops (Optimistic Updates on top of Snapshot)
        for (const op of this.pendingOps) {
            this.state.set(op.key, { value: op.value, timestamp: op.timestamp, peerId: this.peerId });
            // Mark as replay so client doesn't double-send
            this.emit('op', op.key, op.value, true, op.timestamp, true);
        }
    }

    /** Export current state as snapshot (values only, without timestamps) */
    getSnapshot(): Record<string, unknown> {
        const snapshot: Record<string, unknown> = {};
        this.state.forEach((entry, key) => {
            snapshot[key] = entry.value;
        });
        return snapshot;
    }

    /** Get all values */
    getAllValues(): Record<string, unknown> {
        return this.getSnapshot();
    }

    /** Iterate over all entries */
    forEach(callback: (value: unknown, key: string) => void): void {
        this.state.forEach((entry, key) => callback(entry.value, key));
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
                this.log(`Failed to clear pending key ${pendingKey}:`, e);
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
