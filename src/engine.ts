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
import { encodeValue, decodeValue, MsgType, encodeCAS } from './protocol';

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
    set<T = unknown>(key: string, value: T): Uint8Array {
        const timestamp = this.getTimestamp();

        // Apply locally immediately (optimistic) - store with timestamp
        this.state.set(key, { value, timestamp, peerId: this.peerId });

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

    /**
     * Deletes a key (Tombstone Operation).
     * 
     * @remarks
     * In distributed systems, you cannot simply "delete" a key, as old state might resurrect it.
     * Instead, we set the value to `null`, effectively marking it as a tombstone.
     * 
     * @param key - Key to remove.
     */
    delete(key: string): Uint8Array {
        // Tombstone deletion (standard for CRDTs)
        return this.set(key, null);
    }

    /**
     * Applies a remote operation from another peer.
     * 
     * @remarks
     * **Conflict Resolution Strategy (LWW):**
     * - If local timestamp > remote timestamp: **IGNORE** (Local wins).
     * - If remote timestamp > local timestamp: **APPLY** (Remote wins).
     * - If timestamps are equal: **TIEBREAKER** using peerId comparison.
     * 
     * @param key - The key to update.
     * @param payload - The encoded value.
     * @param peerId - The ID of the peer who made the change.
     * @param timestamp - The timestamp when the change happened (server time).
     */
    applyRemote(key: string, payload: Uint8Array, peerId: string, timestamp?: number): void {
        const value = decodeValue(payload);
        const incomingTs = timestamp ?? Date.now();

        // Proper LWW merge: only accept if incoming timestamp is newer
        const existing = this.state.get(key);
        if (existing) {
            // Compare timestamps
            if (existing.timestamp > incomingTs) {
                this.log(`LWW: Rejected stale op for ${key} (existing: ${existing.timestamp}, incoming: ${incomingTs})`);
                return; // Incoming is stale - ignore
            }
            // Tiebreaker: if same timestamp, use peerId lexicographic order
            if (existing.timestamp === incomingTs && existing.peerId >= peerId) {
                this.log(`LWW: Ignored tie for ${key} (peerId tiebreaker)`);
                return;
            }
        }

        // Apply newer value
        this.state.set(key, { value, timestamp: incomingTs, peerId });

        // Persist
        this.storage.set(key, payload).catch(e => {
            console.error('[NMeshed] Persistence remote failed', e);
        });

        this.emit('op', key, value, false);
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
            // Deep equality check is expensive. For primitives/simple objects, JSONstringify is "Zen Enough" for now.
            if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
        }

        // 2. Apply Optimistically - store with timestamp
        const timestamp = this.getTimestamp();
        this.state.set(key, { value: newValue, timestamp, peerId: this.peerId });
        this.emit('op', key, newValue, true);

        // 3. Send to Network (The Authority)
        // (timestamp already captured above)

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
                const value = decodeValue(payload);
                // When loading from storage, we don't have original timestamp
                // Use 0 as sentinel - any fresh write will be newer
                this.state.set(key, { value, timestamp: 0, peerId: '' });
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

    /** 
     * Loads a full state snapshot from the server.
     * 
     * @remarks
     * **"Light Mode" Logic:**
     * If WASM core is not present, we assume the snapshot is a MsgPack map of Key->Value.
     * We discard local state (except pending ops) and replace it with the snapshot.
     */
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

                // Apply Snapshot - use timestamp 0 (server snapshot is baseline)
                for (const [key, value] of Object.entries(snapshot)) {
                    this.state.set(key, { value, timestamp: 0, peerId: '' });
                    this.emit('op', key, value, false);
                }

                // Re-Apply Pending Ops (Optimistic Overlay)
                // We trust our local changes are newer/relevant until acked/rejected
                for (const op of this.pendingOps) {
                    this.state.set(op.key, { value: op.value, timestamp: op.timestamp, peerId: this.peerId });
                    this.emit('op', op.key, op.value, true);
                }

                this.log(`Loaded snapshot (${Object.keys(snapshot).length} keys) + re-applied ${this.pendingOps.length} pending ops`);
            }
        } catch (e) {
            // 3. Binary/Opaque Snapshot?
            this.log('Could not decode snapshot in Light Mode (likely binary/WASM only). Starting fresh.');
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
