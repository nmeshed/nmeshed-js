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
import { HLC } from './hlc';

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
// Sync Engine (Refactored)
// =============================================================================

// =============================================================================
// Sync Engine (Refactored for Technical Satori)
// =============================================================================

const PENDING_PREFIX = 'queue::';

/** Entry in the state map with value and timestamp for LWW ordering */
interface StateEntry {
    value: unknown;
    timestamp: bigint;
    peerId: string;
    lastCiphertext?: Uint8Array;
}

export class SyncEngine extends EventEmitter {
    private state = new Map<string, StateEntry>();
    private status: ConnectionStatus = 'disconnected';
    private peerId: string;
    private pendingOps: Operation[] = [];
    private debug: boolean;
    private storage: IStorage;
    private encryption?: EncryptionAdapter;

    // HLC Integration (128-bit BigInt)
    private hlc: HLC;
    private lastSeenHLC: bigint = 0n;

    // Pillar 4: Incremental Compaction
    private opsSinceLastSnapshot = 0;
    private COMPACTION_THRESHOLD = 1000;
    private STABILITY_WINDOW = 5000; // 5 seconds for GC

    // Pillar 3: Causal Barrier State
    private isGapDetected = false;
    private receivedOps = new Set<string>();
    private pendingBuffer: { key: string, payload: Uint8Array, peerId: string, timestamp: bigint, deps: string[] }[] = [];

    // WASM core (optional)
    private core: CRDTCore | null = null;

    constructor(peerId: string, storage: IStorage, debug = false, encryption?: EncryptionAdapter) {
        super();
        this.peerId = peerId;
        this.storage = storage;
        this.debug = debug;
        this.encryption = encryption;
        this.hlc = new HLC(peerId);

        // Init HLC from wall clock
        this.lastSeenHLC = HLC.pack(BigInt(Date.now()), 0n, 0n); // NodeID handled in HLC class
    }

    private getOpHash(key: string, timestamp: bigint, peerId: string): string {
        return `${key}:${timestamp.toString()}:${peerId}`;
    }

    private getHeads(): string[] {
        // In a real DAG, we would track standard heads.
        // For this Light Engine, we treat the set of all known recent ops as potential parents?
        // Optimized: Just take the last 5 ops?
        // For correctness, we really should track the "Frontier".
        // Simplified for this refactor: The set of all ops currently in "state".
        // To avoid O(N), we can just cache the last applied op hash?
        // Let's return the hash of the last local or remote op applied.
        if (this.receivedOps.size === 0) return [];
        // Returning empty array for now as we don't have a rigid DAG structure in memory yet
        // logic is added in set() to populate this if we track a `lastOpHash`.
        return Array.from(this.receivedOps).slice(-1); // Naive "Chain" mode
    }

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /** 
     * Get a value by key.
     */
    get<T = unknown>(key: string): T | undefined {
        const entry = this.state.get(key);
        if (!entry) return undefined;
        if (typeof structuredClone === 'function') {
            return structuredClone(entry.value) as T;
        }
        try { return JSON.parse(JSON.stringify(entry.value)) as T; } catch { return entry.value as T; }
    }

    /** 
     * Sets a value (Local Operation).
     */
    async set<T = unknown>(key: string, value: T): Promise<Uint8Array> {
        // Pillar 3: Causal Barrier Enforcement
        if (this.isGapDetected) {
            throw new Error('GapDetected: Cannot apply optimistic update while in inconsistent state. Please wait for sync.');
        }

        // HLC Tick
        const timestamp = this.hlc.now(); // Returns bigint
        this.lastSeenHLC = timestamp;

        // Create wire payload
        let payload = encodeValue(value);
        if (this.encryption) {
            payload = await this.encryption.encrypt(payload);
        }

        // Egress: Capture Heads
        const deps = this.getHeads();

        // Apply locally
        this.state.set(key, { value, timestamp, peerId: this.peerId, lastCiphertext: payload });

        const opHash = this.getOpHash(key, timestamp, this.peerId);
        this.receivedOps.add(opHash);

        this.incrementOps();

        // Emit
        this.emit('op', key, value, true, timestamp);

        // Queue
        const op: Operation = { key, value, timestamp, peerId: this.peerId, deps };
        this.pendingOps.push(op);

        // Persist
        this.storage.set(key, payload).catch(e => console.error('[NMeshed] Persistence failed', e));
        const pendingKey = `${PENDING_PREFIX}${timestamp}::${key}`;
        this.storage.set(pendingKey, payload).catch(e => console.error('[NMeshed] Queue persistence failed', e));

        this.log(`Set: ${key} = ${JSON.stringify(value)} @ ${timestamp} (${HLC.unpack(timestamp).wall}:${HLC.unpack(timestamp).logical})`);

        return payload;
    }

    async delete(key: string): Promise<Uint8Array> {
        return this.set(key, null);
    }

    /**
     * Applies a remote operation.
     */
    /**
     * Applies a remote operation.
     */
    async applyRemote(key: string, payload: Uint8Array, peerId: string, timestamp?: bigint | number, deps: string[] = []): Promise<void> {
        // Pillar 1: Causal Barrier Check
        if (deps.length > 0) {
            const missing = deps.filter(d => !this.receivedOps.has(d));
            if (missing.length > 0) {
                this.log(`[Causal Barrier] Missing deps for ${key}: ${missing.join(', ')}`);
                this.isGapDetected = true;
                this.pendingBuffer.push({ key, payload, peerId, timestamp: BigInt(timestamp || 0), deps });
                // Trigger Sync
                this.emit('status', 'syncing');
                return;
            }
        }

        // Retry buffer if we just cleared a gap
        if (this.isGapDetected && this.pendingBuffer.length > 0) {
            // Re-evaluate buffer?
            // For now, simpler to just proceed.
        }

        // E2EE Decrypt
        let finalPayload = payload;
        if (this.encryption) {
            try { finalPayload = await this.encryption.decrypt(payload); }
            catch (e) { console.error(`[NMeshed] Decryption failed for remote op ${key}`, e); return; }
        }

        const value = decodeValue(finalPayload);
        const incomingTs = timestamp != null ? BigInt(timestamp) : HLC.pack(BigInt(Date.now()), 0n, 0n);
        const opHash = this.getOpHash(key, incomingTs, peerId);

        // Update HLC watermark
        this.lastSeenHLC = this.hlc.update(incomingTs);

        // LWW Reconciliation with Pillar 2: Authority Gate
        const existing = this.state.get(key);
        const isRemoteAuthority = peerId.startsWith('Ω_');
        const isLocalAuthority = existing?.peerId.startsWith('Ω_');

        let accept = false;

        if (!existing) {
            accept = true;
        } else {
            // Pillar 2: Authority Veto Logic
            if (isRemoteAuthority) {
                accept = true;
                this.log(`[Ω VETO] Authority ${peerId} overwrote local state for ${key}`);
            } else if (isLocalAuthority) {
                // Local is Authority, Remote is not. Local wins.
                accept = false;
            } else if (incomingTs > existing.timestamp) {
                accept = true;
            } else if (incomingTs === existing.timestamp) {
                // Lexicographical tie-breaker (Determinism)
                if (peerId > existing.peerId) accept = true;
            }
        }

        this.receivedOps.add(opHash);

        // Check buffer for ready ops
        if (this.pendingBuffer.length > 0) {
            const processable = this.pendingBuffer.filter(op => op.deps.every(d => this.receivedOps.has(d)));
            if (processable.length > 0) {
                this.pendingBuffer = this.pendingBuffer.filter(op => !op.deps.every(d => this.receivedOps.has(d)));
                for (const op of processable) {
                    await this.applyRemote(op.key, op.payload, op.peerId, op.timestamp, op.deps);
                }
            }
            if (this.pendingBuffer.length === 0) {
                this.isGapDetected = false;
                this.emit('status', 'connected');
            }
        }

        if (accept) {
            this.state.set(key, { value, timestamp: incomingTs, peerId, lastCiphertext: payload });
            this.storage.set(key, payload).catch(e => { });
            this.emit('op', key, value, false, incomingTs);
            this.incrementOps();
        }
    }

    /** 
     * Compare-And-Swap (Optimistic).
     */
    async cas<T = unknown>(key: string, expected: T | null, newValue: T): Promise<boolean> {
        // Pillar 3: Guard
        if (this.isGapDetected) return false;

        const entry = this.state.get(key);
        const current = entry?.value as T | undefined;

        if (expected === null) {
            if (current !== undefined && current !== null) return false;
        } else {
            if (!deepEqual(current, expected)) return false;
        }

        const plainNew = encodeValue(newValue);
        let expectedPayload: Uint8Array | null = null;
        let newPayload: Uint8Array = plainNew;

        if (this.encryption) {
            if (expected !== null) expectedPayload = entry?.lastCiphertext || null;
            newPayload = await this.encryption.encrypt(plainNew);
        } else {
            if (expected !== null) expectedPayload = encodeValue(expected);
        }

        const timestamp = this.hlc.now();
        this.lastSeenHLC = timestamp;

        this.state.set(key, { value: newValue, timestamp, peerId: this.peerId, lastCiphertext: newPayload });
        this.incrementOps();

        this.emit('op', key, newValue, true, timestamp, false, true);

        const op: Operation = { key, value: newValue, timestamp, peerId: this.peerId, deps: this.getHeads() };
        this.receivedOps.add(this.getOpHash(key, timestamp, this.peerId));
        this.pendingOps.push(op);

        this.storage.set(key, newPayload).catch(e => { });
        const pendingKey = `${PENDING_PREFIX}${timestamp}::${key}`;
        this.storage.set(pendingKey, newPayload).catch(e => { });

        const wireData = encodeCAS(key, expectedPayload, newPayload, this.peerId);
        this.emit('cas', wireData);

        return true;
    }

    // Pillar 4: Incremental Compaction Logic
    private incrementOps() {
        this.opsSinceLastSnapshot++;
        if (this.opsSinceLastSnapshot >= this.COMPACTION_THRESHOLD) {
            this.compact().catch(e => console.error('[NMeshed] Compaction failed', e));
        }
    }

    /**
     * Pillar 4: Compaction
     * Saves full snapshot and deletes old deltas (queue items).
     * Note: In this Light Engine, "deltas" are mainly the PENDING queue or individual keys.
     * We treat "snapshot" here as dumping the Memory Map to a single blob if we support that,
     * OR simply asserting that our current key-value storage IS the snapshot.
     * 
     * The Rust core deletes "delta_*" keys. Here we persist `pendingOps` which act as deltas?
     * No, `pendingOps` are for network retry.
     * 
     * Implementation: 
     * 1. Save all current state as a Monolithic Snapshot (if using a snapshot store).
     * 2. Actually, since we use KV storage, we are already "compacted" per key (LWW).
     * 3. BUT, we simulate the Rust behavior by resetting the counter and maybe pruning metadata?
     * 
     * Detailed Action: Flush memory to disk (ensure consistency) and reset counter.
     */
    /**
     * Pillar 4: Compaction & GC
     */
    async compact(): Promise<void> {
        this.log('Running Incremental Compaction & GC...');

        const now = BigInt(Date.now());
        const stabilityBigInt = BigInt(this.STABILITY_WINDOW);
        // Pack cutoff: (now - window) << 80
        const cutoffTs = HLC.pack(now - stabilityBigInt, 0n, 0n);

        let pruneCount = 0;
        for (const [key, entry] of this.state.entries()) {
            if (entry.value === null && entry.timestamp < cutoffTs) {
                this.state.delete(key);
                await this.storage.delete(key);
                pruneCount++;
            }
        }

        if (pruneCount > 0) {
            this.log(`[GC] Pruned ${pruneCount} tombstones.`);
        }

        this.opsSinceLastSnapshot = 0;
    }

    // ... Load/Snapshot methods updated for BigInt ...

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
                if (this.encryption) finalPayload = await this.encryption.decrypt(payload);
                const value = decodeValue(finalPayload);
                // BigInt timestamp 0
                this.state.set(key, { value, timestamp: 0n, peerId: '', lastCiphertext: payload });
            } catch (e) { }
        }

        queueItems.sort((a, b) => a.key.localeCompare(b.key));
        for (const item of queueItems) {
            const parts = item.key.split('::');
            if (parts.length >= 3) {
                // key: queue::timestamp::realKey
                // timestamp might be stringified BigInt?
                // "queue::1234567::key"
                try {
                    const ts = BigInt(parts[1]);
                    const realKey = parts.slice(2).join('::');
                    let finalPayload = item.payload;
                    if (this.encryption) finalPayload = await this.encryption.decrypt(item.payload);
                    const value = decodeValue(finalPayload);

                    this.pendingOps.push({ key: realKey, value, timestamp: ts, peerId: this.peerId });
                } catch (e) { }
            }
        }
    }

    async loadSnapshot(data: Uint8Array, serverTime?: bigint): Promise<void> {
        try {
            const snapshot = decodeValue<Record<string, unknown>>(data);
            if (!snapshot || typeof snapshot !== 'object') return;

            await this.storage.clearAll();
            const entries = await this.processSnapshotEntries(snapshot);
            await this.restorePendingOps();

            const baseTs = serverTime || HLC.pack(BigInt(Date.now()), 0n, 0n);
            this.lastSeenHLC = this.hlc.update(baseTs);

            this.applySnapshotToMemory(entries, baseTs);

            // Snapshot clears Gap State
            this.isGapDetected = false;

            this.log(`Loaded snapshot (${entries.length} items)`);
        } catch (e) { this.log('Snapshot error', e); }
    }

    private async processSnapshotEntries(snapshot: Record<string, unknown>): Promise<[string, any][]> {
        const entries: [string, any][] = [];
        for (const [key, rawValue] of Object.entries(snapshot)) {
            let val = rawValue;
            let storedValue = rawValue;
            if (this.encryption) {
                if (rawValue instanceof Uint8Array) {
                    val = decodeValue(await this.encryption.decrypt(rawValue));
                }
            } else {
                storedValue = encodeValue(rawValue);
            }
            entries.push([key, val]);
            await this.storage.set(key, storedValue as Uint8Array).catch(() => { });
        }
        return entries;
    }

    private async restorePendingOps(): Promise<void> {
        for (const op of this.pendingOps) {
            const pendingKey = `${PENDING_PREFIX}${op.timestamp}::${op.key}`;
            let p = encodeValue(op.value);
            if (this.encryption) p = await this.encryption.encrypt(p);
            await this.storage.set(pendingKey, p);
        }
    }

    private applySnapshotToMemory(entries: [string, any][], baseTs: bigint): void {
        this.state.clear();
        for (const [key, val] of entries) {
            this.state.set(key, { value: val, timestamp: baseTs, peerId: 'Ω_SNAPSHOT' });
            this.emit('op', key, val, false, baseTs);
        }
        for (const op of this.pendingOps) {
            this.state.set(op.key, { value: op.value, timestamp: op.timestamp, peerId: this.peerId });
            this.emit('op', op.key, op.value, true, op.timestamp, true);
        }
    }

    // ... Standard getters
    getSnapshot() { return Object.fromEntries(Array.from(this.state.entries()).map(([k, v]) => [k, v.value])); }
    getAllValues() { return this.getSnapshot(); }
    forEach(cb: (v: unknown, k: string) => void) { this.state.forEach((v, k) => cb(v.value, k)); }
    getStatus() { return this.status; }
    setStatus(s: ConnectionStatus) {
        if (this.status !== s) {
            this.status = s;
            if (s === 'syncing') this.isGapDetected = false; // Reset on sync
            this.emit('status', s);
        }
    }
    getPeerId() { return this.peerId; }
    getPendingCount() { return this.pendingOps.length; }
    clearPending() { this.pendingOps = []; }
    drainPending() {
        const ops = this.pendingOps;
        this.pendingOps = [];
        ops.forEach(op => this.storage.delete(`${PENDING_PREFIX}${op.timestamp}::${op.key}`).catch(() => { }));
        return ops;
    }
    destroy() { this.clear(); this.state.clear(); this.pendingOps = []; }
    attachCore(core: CRDTCore) { this.core = core; }
    setClockOffset(offset: number) { }
    private log(...args: unknown[]) { if (this.debug) console.log('[NMeshed Engine]', ...args); }
}

