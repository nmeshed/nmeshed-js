import { NMeshedClientCore } from '../wasm/nmeshed_core';
import * as wasmModule from '../wasm/nmeshed_core';
import { EventEmitter } from '../utils/EventEmitter';
import { encodeValue, decodeValue } from '../codec';
import { saveQueue, loadQueue } from '../persistence';
import type { Schema } from '../schema/SchemaBuilder';
import { findSchema } from '../schema/SchemaBuilder';
import { SystemSchemas } from '../schema/SystemSchema';
import { Logger } from '../utils/Logger';
import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { SyncPacket } from '../schema/nmeshed/sync-packet';
import { MessageRouter, IncomingMessage, OpMessage, SyncMessage, InitMessage, SignalMessage } from './MessageRouter';


/**
 * Reconstructs a Uint8Array from values that may have been serialized
 * as objects with numeric keys across the WASM boundary.
 */
export function reconstructBinary(val: unknown): Uint8Array | null {
    if (val instanceof Uint8Array) return val;
    if (val instanceof ArrayBuffer) return new Uint8Array(val);

    // WASM-JS boundary sometimes returns plain objects for TypedArrays
    if (val && typeof val === 'object' && !Array.isArray(val)) {
        const obj = val as Record<string, any>;
        if (obj[0] !== undefined && typeof obj[0] === 'number') {
            // Fast path for length check if 'length' property exists (some bridges provide it)
            const len = typeof obj.length === 'number' ? obj.length : undefined;
            if (len !== undefined) {
                const arr = new Uint8Array(len);
                for (let i = 0; i < len; i++) arr[i] = obj[i];
                return arr;
            }

            // Fallback: search for max index
            let maxIndex = -1;
            for (const k in obj) {
                const idx = parseInt(k, 10);
                if (!isNaN(idx) && idx > maxIndex) maxIndex = idx;
            }
            if (maxIndex >= 0) {
                const arr = new Uint8Array(maxIndex + 1);
                for (let i = 0; i <= maxIndex; i++) arr[i] = obj[i];
                return arr;
            }
        }
    }
    return null;
}

export interface SyncEngineEvents {
    op: [string, unknown, boolean]; // key, value, isOptimistic
    queueChange: [number];
    snapshot: [];
    ephemeral: [unknown, string];   // payload, from
    [key: string]: any[];
}

/**
 * SyncEngine: The Orchestration Layer for nMeshed Synchronization.
 * 
 * This class serves as the bridge between the high-level NMeshedClient and the 
 * underlying WASM-based CRDT core. It manages:
 * 1. WASM Lifecycle: Bootstrapping and managing the NMeshedClientCore.
 * 2. Operation Queuing: Ensuring updates are persisted and sent in order, 
 *    with support for offline/pre-connect operations.
 * 3. Schema Integration: Transparently encoding and decoding binary payloads
 *    during state transitions.
 * 4. Persistence: Backing the operation queue to local storage/IDB to 
 *    prevent data loss across sessions.
 * 
 * @internal
 */
export class SyncEngine extends EventEmitter<SyncEngineEvents> {
    private core: NMeshedClientCore | null = null;
    private workspaceId: string;
    private mode: 'crdt' | 'lww';
    private dbName: string;
    private isDestroyed = false;
    private logger: Logger;

    // State Tracking
    private confirmedState = new Map<string, unknown>();
    private optimisticState = new Map<string, unknown>();

    // Manual State/Queue management
    private preConnectState: Record<string, unknown> = {};
    private operationQueue: Uint8Array[] = [];
    private maxQueueSize: number;
    private isQueueDirty = false;
    private persistenceTimer: any = null;
    private bootQueue: { type: 'delta' | 'sync', data: any }[] = [];

    // Schema registry for automatic encoding/decoding
    private schemaRegistry = new Map<string, Schema<any>>();

    // The Single Parsing Gateway
    private router: MessageRouter;

    constructor(workspaceId: string, mode: string = 'crdt', maxQueueSize: number = 1000, debug: boolean = false) {
        super();
        this.workspaceId = workspaceId;
        this.mode = mode as any;
        this.maxQueueSize = maxQueueSize;
        this.dbName = `nmeshed_q_${workspaceId}`;
        this.logger = new Logger('SyncEngine', debug);
        this.router = new MessageRouter(debug);
    }

    public async boot(): Promise<void> {
        if (this.core) return;

        // Auto-initialize WASM in browser environment
        if (typeof window !== 'undefined' && (wasmModule as any).default) {
            try {
                // Try initializing with standard location, but ignore "already initialized" errors
                await (wasmModule as any).default('/nmeshed_core_bg.wasm');
            } catch (e: any) {
                if (!e.message?.includes('already allocated') && !e.message?.includes('already initialized')) {
                    this.logger.warn('WASM implicit init warning:', e);
                }
            }
        }

        this.core = new NMeshedClientCore(this.workspaceId, this.mode);

        // Auto-register System Schemas for platform features (tick, stats, presence)
        for (const [key, schema] of Object.entries(SystemSchemas)) {
            this.registerSchema(key, schema);
        }

        // Apply pre-connect state to core and queue for transmission
        for (const [key, value] of Object.entries(this.preConnectState)) {
            const valBytes = encodeValue(value);
            const res = this.core.apply_local_op(key, valBytes, BigInt(Date.now() * 1000)) as any;
            if (res) {
                const delta = reconstructBinary(res);
                if (delta) this.addToQueue(delta);
            }
        }

        // Load persisted state
        await this.loadPersistedState();

        // Clear pre-connect state only after loading is done to maintain reported queue size
        this.preConnectState = {};

        // Flush boot queue
        if (this.bootQueue.length > 0) {
            this.logger.info(`Flushing ${this.bootQueue.length} messages from boot queue`);
            const queue = [...this.bootQueue];
            this.bootQueue = [];
            for (const item of queue) {
                if (item.type === 'delta') {
                    this.applyRemoteDelta(item.data);
                } else {
                    this.handleBinarySync(item.data);
                }
            }
        }
    }

    /**
     * Registers a schema for a key pattern. When values are received for matching keys,
     * they will be automatically decoded using the schema.
     */
    public registerSchema(keyPattern: string, schema: Schema<any>): void {
        this.schemaRegistry.set(keyPattern, schema);
    }

    /**
     * Gets the registered schema for a key, if any.
     */
    public getSchemaForKey(key: string): Schema<any> | undefined {
        if (this.schemaRegistry.has(key)) {
            return this.schemaRegistry.get(key);
        }
        let catchAll: Schema<any> | undefined;
        for (const [pattern, schema] of this.schemaRegistry) {
            if (pattern === '') {
                catchAll = schema;
                continue;
            }
            if (key.startsWith(pattern)) {
                return schema;
            }
        }
        // 2. Fallback to catch-all if registered
        if (catchAll) return catchAll;

        // 3. Last fallback to global registry (Invisible Registration)
        return findSchema(key);
    }

    /**
     * Reconstructs a Uint8Array from values that may have been serialized across WASM.
     */
    private toUint8Array(val: unknown): Uint8Array | null {
        return reconstructBinary(val);
    }

    /**
     * Sets a value for a key in the synchronized state.
     * 
     * @param key - The key to set. Must be a non-empty string.
     * @param value - The value to store. If null/undefined, treated as a delete.
     * @param schema - Optional schema for binary encoding. When provided:
     *                 1. The schema is registered for this key's prefix
     *                 2. The value is encoded using schema.encode()
     *                 3. Incoming updates are decoded using schema.decode()
     * @returns The delta bytes to send to the server (empty if not connected)
     * @throws Error if key is invalid or encoding fails catastrophically
     */
    public set(key: string, value: unknown, schema?: Schema<any>, shouldQueue: boolean = true): Uint8Array {
        // Input validation
        if (!key || typeof key !== 'string') {
            throw new Error('[SyncEngine] set() requires a non-empty string key');
        }

        // Encode the value using schema or generic encoder
        let valBytes: Uint8Array;
        if (schema) {
            // Register schema for this key pattern so decoding works on receive
            const prefixMatch = key.match(/^([a-zA-Z_]+)/);
            if (prefixMatch) {
                this.schemaRegistry.set(prefixMatch[1], schema);
            }

            try {
                valBytes = schema.encode(value as any);
            } catch (e) {
                // Schema encode failed - log warning and fall back to generic encoding
                this.logger.warn(`Schema encode failed for key "${key}", falling back to JSON:`, e);
                valBytes = encodeValue(value);
            }
        } else {
            valBytes = encodeValue(value);
        }
        const timestamp = BigInt(Date.now() * 1000);

        this.optimisticState.set(key, value);
        if (this.core) {
            const res = (this.core as any).apply_local_op(key, valBytes, timestamp) as unknown;
            const delta = reconstructBinary(res);

            if (!delta) {
                throw new Error(`[SyncEngine] WASM core returned invalid delta for key: ${key}`);
            }

            if (shouldQueue) {
                this.addToQueue(delta);
            } else {
                this.logger.debug(`SyncEngine: Skipping queue for direct send (key=${key})`);
            }

            this.emit('op', key, value, true); // true = isOptimistic
            return delta;
        } else {
            this.preConnectState[key] = value;
            // Enforce maxQueueSize on preConnectState
            const keys = Object.keys(this.preConnectState);
            if (keys.length > this.maxQueueSize) {
                delete this.preConnectState[keys[0]];
            }
            this.saveState();
            this.emit('op', key, value, true); // true = isOptimistic
            this.emit('queueChange', Object.keys(this.preConnectState).length);
            return new Uint8Array();
        }
    }

    private addToQueue(delta: Uint8Array): void {
        this.operationQueue.push(delta);
        if (this.operationQueue.length > this.maxQueueSize) {
            this.operationQueue.shift();
            this.logger.warn(`SyncEngine: Queue overflow! Dropping oldest op. Size: ${this.operationQueue.length}`);
        } else {
            this.logger.debug(`SyncEngine: Op added to queue. Size: ${this.operationQueue.length}`);
            this.isQueueDirty = true;
            this.schedulePersistence();
            this.emit('queueChange', this.operationQueue.length);
        }
    }

    // =========================================================================
    // THE SINGLE GATE: Unified Message Entry Point
    // =========================================================================

    /**
     * The Single Entry Point for ALL incoming messages.
     * 
     * This is the Zen Gateway - all parsed messages flow through here.
     * The type system guides the developer to handle each case explicitly.
     * 
     * @param message A pre-parsed IncomingMessage from MessageRouter
     */
    public receive(message: IncomingMessage): void {
        if (this.isDestroyed) return;

        if (!this.core) {
            this.logger.debug('Core not ready, queuing message');
            // Convert back to queueable format
            if (message.type === 'op' || message.type === 'sync') {
                this.bootQueue.push({ type: 'delta', data: message });
            }
            return;
        }

        switch (message.type) {
            case 'op':
                this.processOp(message);
                break;
            case 'sync':
                this.processSync(message);
                break;
            case 'init':
                this.processInit(message);
                break;
            case 'signal':
                this.processSignal(message);
                break;
        }
    }

    /**
     * Process an Op (operation) message.
     */
    private processOp(msg: OpMessage): void {
        const { key, value } = msg;
        if (value) {
            const decoded = this.decodeBinary(key, value);
            this.handleRemoteOp(key, decoded);
        } else {
            // Delete operation
            this.handleRemoteOp(key, null);
        }
    }

    /**
     * Process a Sync (snapshot/state vector) message.
     */
    private processSync(msg: SyncMessage): void {
        if (msg.snapshot) {
            this.logger.info(`Received binary snapshot (${msg.snapshot.byteLength} bytes)`);
            this.applyRemoteDelta(msg.snapshot);
        }

        if (msg.stateVector && msg.stateVector.size > 0) {
            this.logger.debug(`Received state vector with ${msg.stateVector.size} entries`);
            // TODO: Use state vector to produce minimal catch-up delta
        }

        if (msg.ackSeq && msg.ackSeq > 0n) {
            this.logger.debug(`Received ACK for sequence ${msg.ackSeq}`);
            // TODO: Clear local queue up to ackSeq
        }
    }

    /**
     * Process an Init (initial snapshot) message.
     */
    private processInit(msg: InitMessage): void {
        this.handleInitSnapshot(msg.data);
    }

    /**
     * Process a Signal (ephemeral) message.
     */
    private processSignal(msg: SignalMessage): void {
        const { payload, from } = msg;
        if (payload instanceof Uint8Array) {
            try {
                const decoded = this.decodeBinary('', payload);
                this.emit('ephemeral', decoded, from || 'server');
            } catch {
                this.emit('ephemeral', payload, from || 'server');
            }
        } else {
            this.emit('ephemeral', payload, from || 'server');
        }
    }

    // =========================================================================
    // LEGACY ENTRY POINTS (Backward Compatibility)
    // =========================================================================

    /**
     * Entry point for ALL incoming binary messages from transport.
     * Now delegates to the unified receive() method via MessageRouter.
     */
    public applyRawMessage(binary: Uint8Array): void {
        if (this.isDestroyed || !binary || binary.length === 0) return;

        if (!this.core) {
            this.logger.debug('Core not ready, queuing raw message');
            this.bootQueue.push({ type: 'delta', data: binary });
            return;
        }

        // Use the Single Parsing Gateway
        const message = this.router.parse(binary);
        if (message) {
            this.receive(message);
        } else {
            // Fallback for non-WirePacket data (legacy or raw CRDT deltas)
            this.logger.debug('Router could not parse message, attempting fallback');
            this.applyRemoteDelta(binary);
        }
    }

    /**
     * Entry point for incoming remote deltas (Ops or Snapshots).
     * @deprecated Use applyRawMessage for new code
     */
    public applyRemoteDelta(binary: Uint8Array): void {
        if (this.isDestroyed || !binary) return;

        if (!this.core) {
            this.logger.debug('Core not ready, queuing remote delta');
            this.bootQueue.push({ type: 'delta', data: binary });
            return;
        }

        let result: any;
        if (binary instanceof Uint8Array) {
            result = this.decodeBinary('', binary);
        } else {
            result = binary;
        }
        this.handleGenericDelta(result);
    }

    /**
     * Entry point for specialized binary sync packets (Snapshots/State Vectors).
     */
    public handleBinarySync(data: Uint8Array | SyncPacket): void {
        if (this.isDestroyed || !data) return;

        if (!this.core) {
            this.logger.debug('Core not ready, queuing binary sync');
            this.bootQueue.push({ type: 'sync', data });
            return;
        }

        this.processBinarySyncInternal(data);
    }

    private processBinarySyncInternal(data: Uint8Array | SyncPacket): void {
        let sync: SyncPacket;
        if (data instanceof Uint8Array) {
            try {
                const buf = new flatbuffers.ByteBuffer(data);
                const wire = WirePacket.getRootAsWirePacket(buf);
                const syncData = wire.sync();
                if (!syncData) {
                    this.logger.warn('Received sync event but no SyncPacket found in WirePacket');
                    return;
                }
                sync = syncData;
            } catch (e) {
                this.logger.error('Failed to unpack binary sync packet:', e);
                return;
            }
        } else {
            sync = data;
        }

        const snapshot = sync.snapshotArray();
        if (snapshot) {
            this.logger.info(`Received binary snapshot (${snapshot.byteLength} bytes)`);
            this.applyRemoteDelta(snapshot);
        }

        const svCount = sync.stateVectorLength();
        if (svCount > 0) {
            const stateVector = new Map<string, bigint>();
            for (let i = 0; i < svCount; i++) {
                const entry = sync.stateVector(i);
                if (entry && entry.peerId()) {
                    stateVector.set(entry.peerId()!, entry.seq());
                }
            }
            this.logger.debug(`Received state vector with ${svCount} entries`);
            // TODO: In the future, use state vector to produce a minimal catch-up delta
        }

        const ackSeq = sync.ackSeq();
        if (ackSeq > 0n) {
            this.logger.debug(`Received ACK for sequence ${ackSeq}`);
            // TODO: Logic for clearing local queue up to ackSeq
        }
    }

    public handleInitSnapshot(data: Record<string, unknown>): void {
        if (!data) return;
        this.logger.info(`Processing init snapshot with ${Object.keys(data).length} keys`);

        for (const [k, rawVal] of Object.entries(data)) {
            if (!k) continue;

            const binaryVal = this.toUint8Array(rawVal);
            let val: unknown = binaryVal ? this.decodeBinary(k, binaryVal) : rawVal;

            this.confirmedState.set(k, val);
            this.emit('op', k, val, false);
        }
        this.emit('snapshot');
    }

    private handleOpUpdate(op: { key: string, value: any, timestamp?: number }): void {
        const { key, value } = op;

        // Handle DELETE
        if (value === null || value === undefined || (typeof value === 'object' && Object.keys(value).length === 0)) {
            this.logger.debug(`Confirmed DELETE for key=${key}`);
            this.emit('op', key, null, false);
            return;
        }

        const binaryVal = this.toUint8Array(value);
        let val: unknown = binaryVal ? this.decodeBinary(key, binaryVal) : value;

        // Update confirmed state
        this.confirmedState.set(key, val);

        // Reconciliation: If the optimistic value matches the confirmed value, clear optimistic tracking
        const optVal = this.optimisticState.get(key);
        if (optVal === val) {
            this.optimisticState.delete(key);
        }

        this.emit('op', key, val, false);
    }

    /**
     * Directly injects a remote operation value into the engine.
     * This bypasses decoding and is useful for JSON fallbacks or initial snapshots.
     */
    public handleRemoteOp(key: string, value: unknown): void {
        this.confirmedState.set(key, value);
        const optVal = this.optimisticState.get(key);
        if (optVal === value) {
            this.optimisticState.delete(key);
        }
        this.emit('op', key, value, false);
    }

    private decodeBinary(key: string, binary: Uint8Array): unknown {
        // Deterministic decoding chain:
        // 1. Check for schema (Explicit user intent)
        const schema = this.getSchemaForKey(key);
        if (schema) {
            try {
                return schema.decode(binary);
            } catch (e) {
                this.logger.warn(`Schema decode FAILED for ${key}, falling back to FBC`, e);
            }
        }

        // 2. Try FastBinaryCodec (Default internal format)
        try {
            return decodeValue(binary);
        } catch (e) {
            // Final fallback: literal bytes (no JSON guessing)
            return binary;
        }
    }

    private handleGenericDelta(result: any): void {
        if (!result) return;

        // Handle keyed op from Transport
        if (result.key !== undefined && result.value instanceof Uint8Array) {
            const decoded = decodeValue(result.value);
            this.handleOpUpdate({
                key: result.key,
                value: decoded
            });
            return;
        }

        // Handle raw binary delta - log warning instead of recursing
        if (result instanceof Uint8Array || result instanceof ArrayBuffer) {
            this.logger.warn('handleGenericDelta received raw binary - this should not happen');
            return;
        }

        // If it's a list of operations (typical for batch merges)
        if (Array.isArray(result)) {
            result.forEach(item => this.handleGenericDelta(item));
            return;
        }

        // Handle single op result
        if (result.type === 'op' || (result.key && result.value !== undefined)) {
            this.handleOpUpdate({
                key: result.key,
                value: result.value
            });
        } else if (result.type === 'init') {
            this.handleInitSnapshot(result.data || result.history);
        }
    }

    public get<T = unknown>(key: string): T | undefined {
        if (this.optimisticState.has(key)) return this.optimisticState.get(key) as T;
        if (this.confirmedState.has(key)) return this.confirmedState.get(key) as T;
        return this.preConnectState[key] as T | undefined;
    }

    public getConfirmed<T = unknown>(key: string): T | undefined {
        return this.confirmedState.get(key) as T;
    }

    public isOptimistic(key: string): boolean {
        return this.optimisticState.has(key);
    }

    public getAllValues(): Record<string, unknown> {
        const result: Record<string, unknown> = { ...this.preConnectState };

        // Layer 2: Confirmed state (authoritative)
        for (const [key, value] of this.confirmedState.entries()) {
            result[key] = value;
        }

        // Layer 3: Optimistic state (overrides confirmed)
        for (const [key, value] of this.optimisticState.entries()) {
            result[key] = value;
        }

        if (this.core) {
            const core = this.core as any;
            let state = typeof core.get_state === 'function' ? core.get_state() : core.state;
            if (state) {
                for (const key in state) {
                    if (result[key] === undefined) {
                        const rawVal = state[key];
                        const binaryVal = reconstructBinary(rawVal);
                        if (binaryVal) {
                            result[key] = this.decodeBinary(key, binaryVal);
                            this.logger.info(`[SyncEngine] Resolved ${key} from core:`, result[key], "raw length:", binaryVal.length);
                        } else {
                            result[key] = rawVal;
                        }
                    }
                }
            }
        }
        return result;
    }

    public getQueueSize(): number {
        return this.operationQueue.length + Object.keys(this.preConnectState).length;
    }

    public getQueueLength(): number {
        return this.operationQueue.length;
    }

    public getPendingOps(): Uint8Array[] {
        return [...this.operationQueue];
    }

    public clearQueue(): void {
        const oldSize = this.operationQueue.length;
        this.operationQueue = [];
        this.saveState();
        this.logger.info(`SyncEngine: Queue cleared. Was ${oldSize} items.`);
        this.emit('queueChange', this.getQueueSize());
    }

    /**
     * Removes the first N items from the queue.
     * Useful for partial flushes where some items were successfully sent.
     */
    public shiftQueue(count: number): void {
        if (count <= 0) return;
        const actualCount = Math.min(count, this.operationQueue.length);
        this.operationQueue.splice(0, actualCount);
        this.saveState();
        this.logger.debug(`SyncEngine: Shifted ${actualCount} items from queue. Remaining: ${this.operationQueue.length}`);
        this.emit('queueChange', this.getQueueSize());
    }

    public destroy(): void {
        this.isDestroyed = true;
        if (this.persistenceTimer) {
            clearTimeout(this.persistenceTimer);
            this.persistenceTimer = null;
        }
        this.core = null;
        this.operationQueue = [];
        this.preConnectState = {};
        this.confirmedState.clear();
        this.optimisticState.clear();
    }

    private schedulePersistence(): void {
        if (this.persistenceTimer) return;
        this.persistenceTimer = setTimeout(() => {
            this.persistenceTimer = null;
            if (this.isQueueDirty) {
                this.saveState();
            }
        }, 100); // Debounce persistence by 100ms
    }

    private async saveState(): Promise<void> {
        if (this.isDestroyed) return;
        this.isQueueDirty = false;
        try {
            await saveQueue(this.workspaceId, this.operationQueue);
        } catch (e) {
            if (!this.isDestroyed) {
                this.isQueueDirty = true; // Retry later
                this.logger.error(`Save failed for ${this.dbName}`, e);
            }
        }
    }

    private async loadPersistedState(): Promise<void> {
        try {
            const ops = await loadQueue(this.workspaceId);
            if (ops && Array.isArray(ops)) {
                ops.forEach(op => {
                    // Handle various persisted formats (binary, wrapped, or plain object)
                    let data;
                    if (op instanceof Uint8Array) {
                        data = op;
                    } else if (op.data && op.data instanceof Uint8Array) {
                        data = op.data;
                    } else {
                        // Fallback for plain objects from tests or legacy storage
                        data = new TextEncoder().encode(JSON.stringify(op));
                    }

                    if (data) this.operationQueue.push(data);
                });
                this.emit('queueChange', this.operationQueue.length);
            }
        } catch (e) {
            this.logger.error('Load failed', e);
        }
    }
}
