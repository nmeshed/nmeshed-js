import { NMeshedClientCore } from '../wasm/nmeshed_core';
import * as wasmModule from '../wasm/nmeshed_core';
import { EventEmitter } from '../utils/EventEmitter';
import { encodeValue, decodeValue } from '../codec';
import { saveQueue, loadQueue } from '../persistence';
import { Schema, findSchema, SchemaRegistry } from '../schema/SchemaBuilder';
import { SystemSchemas } from '../schema/SystemSchema';
import { Logger } from '../utils/Logger';
import { RealTimeClock, RTCUpdate } from './RealTimeClock';
import { AuthorityManager } from './AuthorityManager';
import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';
import { ColumnarOpBatch } from '../schema/nmeshed/columnar-op-batch';
import { RingBuffer } from '../utils/RingBuffer';

// ============================================================================
// State Machine Definition
// ============================================================================

/**
 * SyncEngine Lifecycle States
 * 
 * State transitions:
 *   IDLE --> BOOTING --> ACTIVE --> STOPPING --> STOPPED
 *                                                    |
 *                                                    v
 *                                               DESTROYED
 *   STOPPED --> BOOTING (reconnection)
 */
export enum EngineState {
    /** Initial state after construction, before boot() is called */
    IDLE = 'IDLE',
    /** boot() has been called, WASM is initializing */
    BOOTING = 'BOOTING',
    /** Engine is fully operational, ready to process ops */
    ACTIVE = 'ACTIVE',
    /** destroy() called on active engine, cleanup in progress */
    STOPPING = 'STOPPING',
    /** Engine has been stopped, can be rebooted */
    STOPPED = 'STOPPED',
    /** Engine has been permanently destroyed, cannot be reused */
    DESTROYED = 'DESTROYED',
}

/** Valid state transitions */
const VALID_TRANSITIONS: Record<EngineState, EngineState[]> = {
    [EngineState.IDLE]: [EngineState.BOOTING, EngineState.DESTROYED],
    [EngineState.BOOTING]: [EngineState.ACTIVE, EngineState.STOPPING],
    [EngineState.ACTIVE]: [EngineState.STOPPING],
    [EngineState.STOPPING]: [EngineState.STOPPED, EngineState.DESTROYED],
    [EngineState.STOPPED]: [EngineState.BOOTING, EngineState.DESTROYED],
    [EngineState.DESTROYED]: [], // Terminal state
};

export class InvalidStateTransitionError extends Error {
    constructor(from: EngineState, to: EngineState, action: string) {
        super(`Invalid state transition: ${from} -> ${to} (action: ${action})`);
        this.name = 'InvalidStateTransitionError';
    }
}

// ============================================================================
// Utility Functions
// ============================================================================

export function reconstructBinary(val: unknown): Uint8Array | null {
    if (val instanceof Uint8Array) return val;
    if (val instanceof ArrayBuffer) return new Uint8Array(val);

    // WASM-JS boundary sometimes returns plain objects for TypedArrays
    if (val && typeof val === 'object') {
        if (Array.isArray(val)) {
            return new Uint8Array(val);
        }

        const obj = val as Record<string, any>;
        if (obj[0] !== undefined && typeof obj[0] === 'number') {
            const len = typeof obj.length === 'number' ? obj.length : undefined;
            if (len !== undefined) {
                const arr = new Uint8Array(len);
                for (let i = 0; i < len; i++) arr[i] = obj[i];
                return arr;
            }

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

// ============================================================================
// SyncEngine Events
// ============================================================================

export interface SyncEngineEvents {
    op: [string, unknown, boolean]; // key, value, isOptimistic
    queueChange: [number];
    snapshot: [];
    ready: [Record<string, unknown>];
    ephemeral: [unknown, string];   // payload, from
    signal: [any];
    stateChange: [EngineState, EngineState]; // from, to
    [key: string]: any[];
}

// ============================================================================
// SyncEngine Class
// ============================================================================

/**
 * SyncEngine: The Orchestration Layer for nMeshed Synchronization.
 * 
 * Implements a formal state machine for lifecycle management:
 * - IDLE: Constructed but not yet initialized
 * - BOOTING: WASM core is being initialized
 * - ACTIVE: Ready to process operations
 * - STOPPING: Cleanup in progress
 * - STOPPED: Can be rebooted
 * - DESTROYED: Terminal state, cannot be reused
 */
export class SyncEngine extends EventEmitter<SyncEngineEvents> {
    // State Machine
    private _state: EngineState = EngineState.IDLE;

    // Core
    private core: NMeshedClientCore | null = null;
    private viewCache = new Map<string, any>();
    private opSequence = 0;
    private workspaceId: string;
    private logger: Logger;
    private debug: boolean;
    private wasmPath?: string;


    // The Monotonic Pulse
    public readonly clock: RealTimeClock;
    // The Arbiter of Ownership
    public readonly authority: AuthorityManager;

    // Persistence/Queue management
    private preConnectState = new Map<string, unknown>();
    private operationQueue: RingBuffer<Uint8Array>;
    private maxQueueSize: number;
    private isQueueDirty = false;
    private persistenceTimer: any = null;
    private bootQueue: Uint8Array[] = [];
    private bootPromise: Promise<void> | null = null;

    // Schema registry for automatic encoding/decoding
    private schemaRegistry = new Map<string, Schema<any>>();

    // Actor Registry (Milestone 3)
    private actorMap = new Map<number, string>();

    // Vector Clocks (Milestone 4)
    private localVector = new Map<string, bigint>();
    private remoteVectors = new Map<string, Map<string, bigint>>();

    constructor(
        workspaceId: string,
        peerId: string,
        maxQueueSize: number = 1000,
        debug: boolean = false,
        wasmPath?: string
    ) {
        super();
        this.workspaceId = workspaceId;
        this.maxQueueSize = maxQueueSize;
        this.debug = debug;
        this.wasmPath = wasmPath;
        this.logger = new Logger('SyncEngine', debug);


        this.operationQueue = new RingBuffer<Uint8Array>(maxQueueSize);

        this.clock = new RealTimeClock(peerId, debug ? 1 : 10, debug);
        this.authority = new AuthorityManager(peerId, 20);

        // Zen: Automatically inherit globally registered schemas
        // This ensures "invisible" registration works for all engines
        for (const [pattern, schema] of SchemaRegistry) {
            this.schemaRegistry.set(pattern, schema);
        }

        // Chain clock ticks to global sync if authority
        this.clock.on('tick', (tick) => {
            if (this._state === EngineState.ACTIVE && this.authority.isAuthority('__global_tick')) {
                const payload = {
                    tick,
                    timestamp: Date.now(),
                    peerId
                };
                this.set('__global_tick', payload, SystemSchemas['__global_tick'], true);
            }
        });

        this.logger.info(`[SyncEngine] Created in state: ${this._state} `);
    }

    // ========================================================================
    // State Machine
    // ========================================================================

    /** Current engine state */
    public get state(): EngineState {
        return this._state;
    }

    /** Check if engine is in a state that can process operations */
    public get isOperational(): boolean {
        return this._state === EngineState.ACTIVE;
    }

    /** Transition to a new state with validation */
    private transition(to: EngineState, action: string): void {
        const from = this._state;
        const validTargets = VALID_TRANSITIONS[from];

        if (!validTargets.includes(to)) {
            throw new InvalidStateTransitionError(from, to, action);
        }

        this.logger.info(`[SyncEngine] State: ${from} -> ${to} (${action})`);
        this._state = to;
        this.emit('stateChange', from, to);
    }

    // ========================================================================
    // Lifecycle Methods
    // ========================================================================

    /**
     * Initialize the WASM core and prepare for operations.
     * 
     * **Concurrency Note**: This method is idempotent and safe to call multiple times.
     * Concurrent calls will wait for the first boot to complete.
     * 
     * **Phases**:
     * 1. Load WASM binary (Node.js/Browser agnostic).
     * 2. Initialize Rust `NMeshedClientCore`.
     * 3. Load persisted state from IndexedDB/LSM.
     * 4. Flush boot-time operation queue.
     * 
     * @returns Promise resolving when EngineState becomes ACTIVE.
     */
    public async boot(): Promise<void> {
        // Already booted
        if (this._state === EngineState.ACTIVE && this.core) {
            return;
        }

        // If already booting, wait for that to complete
        if (this._state === EngineState.BOOTING && this.bootPromise) {
            return this.bootPromise;
        }

        if (this._state !== EngineState.IDLE && this._state !== EngineState.STOPPED) {
            throw new InvalidStateTransitionError(this._state, EngineState.BOOTING, 'boot()');
        }

        this.transition(EngineState.BOOTING, 'boot()');
        this.bootPromise = this.doBootInternal();

        try {
            await this.bootPromise;
        } finally {
            this.bootPromise = null;
        }
    }

    /** Internal boot implementation */

    private async doBootInternal(): Promise<void> {

        try {
            // Auto-initialize WASM
            if ((wasmModule as any).default) {
                const isNode = typeof process !== 'undefined' && process.versions && !!process.versions.node;
                const isRealBrowser = typeof window !== 'undefined' && !isNode;

                if (isNode) {
                    // Node/Vitest loading path
                    const fs = await import('fs');
                    const path = await import('path');

                    const pathsToTry = [
                        this.wasmPath, // 1. Custom path takes priority
                        path.resolve(process.cwd(), 'src/wasm/nmeshed_core/nmeshed_core_bg.wasm'),
                        path.resolve(process.cwd(), 'sdks/javascript/src/wasm/nmeshed_core/nmeshed_core_bg.wasm'),
                        path.join(__dirname || '', '../wasm/nmeshed_core/nmeshed_core_bg.wasm'),
                    ].filter(Boolean) as string[];

                    let found = false;
                    for (const wasmPath of pathsToTry) {
                        try {
                            if (fs.existsSync(wasmPath)) {
                                this.logger.info(`[SyncEngine] Loading WASM from: ${wasmPath}`);
                                const wasmBuffer = fs.readFileSync(wasmPath);
                                await (wasmModule as any).default(wasmBuffer);
                                found = true;
                                break;
                            }
                        } catch (e) {
                            this.logger.debug(`Failed to load WASM from ${wasmPath}: ${e}`);
                        }
                    }


                    if (!found) {
                        this.logger.error(`[SyncEngine] WASM NOT FOUND! Checked paths: ${JSON.stringify(pathsToTry)}. CWD: ${process.cwd()}`);
                    }

                } else if (isRealBrowser) {
                    await (wasmModule as any).default({ module_or_path: '/nmeshed_core_bg.wasm' });
                }
            }

            this.core = new NMeshedClientCore(this.workspaceId);
            this.clock.start();

            // Auto-register System Schemas
            for (const [key, schema] of Object.entries(SystemSchemas)) {
                this.registerSchema(key, schema);
            }

            // Apply pre-connect state
            for (const [key, value] of this.preConnectState) {
                this.setInternal(key, value);
            }

            await this.loadPersistedState();
            this.preConnectState.clear();

            // Flush boot queue
            if (this.bootQueue.length > 0) {
                const queue = [...this.bootQueue];
                this.bootQueue = [];
                for (const item of queue) {
                    this.applyRawMessageInternal(item);
                }
            }

            // Check if engine was destroyed during async boot
            if (this._state === EngineState.DESTROYED || this._state === EngineState.STOPPING || this._state === EngineState.STOPPED) {
                return; // Abort - engine was destroyed or stopped
            }

            this.transition(EngineState.ACTIVE, 'boot() complete');
        } catch (e: any) {
            // If boot fails, go to STOPPED so we can retry (unless destroyed)
            this.logger.error('[SyncEngine] Boot failed:', e);
            if (this._state !== EngineState.DESTROYED) {
                this._state = EngineState.STOPPED;
            }
            throw e;
        }
    }

    /**
     * Stop the engine and release resources.
     * Can be rebooted after calling this.
     */
    public stop(): void {
        if (this._state === EngineState.STOPPED || this._state === EngineState.DESTROYED) {
            return; // Already stopped
        }

        if (this._state !== EngineState.ACTIVE && this._state !== EngineState.BOOTING) {
            throw new InvalidStateTransitionError(this._state, EngineState.STOPPING, 'stop()');
        }

        this.transition(EngineState.STOPPING, 'stop()');
        this.cleanup();
        this.transition(EngineState.STOPPED, 'stop() complete');
    }

    /**
     * Permanently destroy the engine. Cannot be reused after this.
     */
    public destroy(): void {
        if (this._state === EngineState.DESTROYED) {
            return; // Already destroyed
        }

        // Save queue if needed
        if (this.isQueueDirty) {
            this.saveState(true);
        }

        if (this._state === EngineState.ACTIVE || this._state === EngineState.BOOTING) {
            this.transition(EngineState.STOPPING, 'destroy()');
            this.cleanup();
        }

        this.transition(EngineState.DESTROYED, 'destroy()');
    }

    /** Internal cleanup logic */
    private cleanup(): void {
        this.clock.stop();
        if (this.persistenceTimer) {
            clearTimeout(this.persistenceTimer);
            this.persistenceTimer = null;
        }
        this.core = null;
        this.operationQueue.clear(); // Correctly clear RingBuffer
        this.preConnectState.clear();
        this.viewCache.clear();
    }

    // ========================================================================
    // Schema Registration
    // ========================================================================

    public registerSchema(keyPattern: string, schema: Schema<any>): void {
        this.schemaRegistry.set(keyPattern, schema);
    }

    public getSchemaForKey(key: string): Schema<any> | undefined {
        if (this.schemaRegistry.has(key)) return this.schemaRegistry.get(key);
        let catchAll: Schema<any> | undefined;
        for (const [pattern, schema] of this.schemaRegistry) {
            if (pattern === '') { catchAll = schema; continue; }
            if (key.startsWith(pattern)) return schema;
        }
        if (catchAll) return catchAll;
        return findSchema(key);
    }

    // ========================================================================
    // Data Operations
    // ========================================================================

    /**
     * Set a value in the sync engine.
     * @throws InvalidStateTransitionError if not in ACTIVE state
     */
    public set(key: string, value: unknown, schema?: Schema<any>, shouldQueue: boolean = true): Uint8Array {
        if (this._state !== EngineState.ACTIVE) {
            if (this._state === EngineState.IDLE || this._state === EngineState.STOPPED || this._state === EngineState.BOOTING) {
                // Buffer for later
                this.preConnectState.set(key, value);
                // Enforce maxQueueSize on preConnectState roughly
                if (this.preConnectState.size > this.maxQueueSize) {
                    const firstKey = this.preConnectState.keys().next().value;
                    if (firstKey) this.preConnectState.delete(firstKey);
                }
                this.isQueueDirty = true;
                this.schedulePersistence();
                this.emit('queueChange', this.getQueueSize());
                return encodeValue(value);
            }
            throw new Error(`Cannot set() in state ${this._state} `);
        }

        return this.setInternal(key, value, schema, shouldQueue);
    }

    /** Internal set implementation */
    private setInternal(key: string, value: unknown, schema?: Schema<any>, shouldQueue: boolean = true): Uint8Array {
        if (!key || typeof key !== 'string') {
            throw new Error('[SyncEngine] set() requires a non-empty string key');
        }

        let valBytes: Uint8Array;

        // Zen Fix: If schema is not provided, try to find it in the registry.
        const effectiveSchema = schema || this.getSchemaForKey(key);

        // If value is null (deletion), skip schema encoding and use FBC tombstone
        if (effectiveSchema && value !== null && value !== undefined) {
            const prefixMatch = key.match(/^([a-zA-Z_]+)/);
            if (prefixMatch) this.schemaRegistry.set(prefixMatch[1], effectiveSchema);
            try {
                valBytes = effectiveSchema.encode(value as any);
            } catch (e) {
                this.logger.warn(`Schema encode failed for key "${key}", falling back to FBC: `, e);
                valBytes = encodeValue(value);
            }
        } else {
            valBytes = encodeValue(value);
        }

        if (!this.core) {
            this.preConnectState.set(key, value);
            this.isQueueDirty = true;
            this.schedulePersistence();
            return valBytes;
        }

        const timestamp = BigInt(Date.now()) * 1000000n + BigInt(this.opSequence);
        const seq = BigInt(this.opSequence++);
        const actorId = this.authority.peerId;

        // Update Local Vector Clock
        this.localVector.set(actorId, seq);

        const isDelete = value === null || value === undefined;
        this.authority.trackKey(key);

        this.logger.debug(`[SyncEngine] apply_local_op key = ${key} valPixels = ${valBytes.length} `);
        const res = (this.core as any).apply_local_op(key, valBytes, timestamp, actorId, seq, isDelete) as any;
        if (!res) {
            this.logger.error(`[SyncEngine] CORE FAILED TO APPLY OP for key: ${key} `);
            throw new Error('[SyncEngine] CORE FAILED TO APPLY OP');
        }

        const delta = reconstructBinary(res);
        if (!delta) {
            this.logger.error(`[SyncEngine] CORE RETURNED INVALID DELTA for key: ${key} `);
            throw new Error('[SyncEngine] CORE RETURNED INVALID DELTA');
        }

        if (shouldQueue) this.addToQueue(delta);

        // Zen Optimization: Only invalidate the changed key.
        // Previously: this.viewCache.clear(); (Global Lock)
        this.viewCache.delete(key);

        const verify = this.get(key);
        if (this.debug) {
            this.logger.debug(`[SyncEngine] setInternal complete.Key = ${key} `, verify);
        }
        this.emit('op', key, value, true);
        return delta;
    }

    private addToQueue(delta: Uint8Array): void {
        this.operationQueue.push(delta);
        // RingBuffer handles circular overwrite automatically O(1)
        this.isQueueDirty = true;
        this.schedulePersistence();
        this.emit('queueChange', this.getQueueSize());
    }

    /**
     * Apply an incoming binary message.
     */
    public applyRawMessage(bytes: Uint8Array): void {
        this.logger.debug(`[SyncEngine] applyRawMessage: ${bytes.byteLength} bytes`);
        if (this._state === EngineState.DESTROYED || this._state === EngineState.STOPPING) {
            return; // Silently drop
        }

        if (this._state !== EngineState.ACTIVE) {
            // Buffer for after boot
            this.bootQueue.push(bytes);
            return;
        }

        this.applyRawMessageInternal(bytes);
    }

    /** Internal raw message processing */
    private applyRawMessageInternal(bytes: Uint8Array): void {
        if (!bytes || bytes.length === 0 || !this.core) return;

        try {
            const bb = new flatbuffers.ByteBuffer(bytes);
            const packet = WirePacket.getRootAsWirePacket(bb);
            const msgType = packet.msgType();

            // 1. Core State Updates (Op, Sync)
            // 1. Core State Updates (Op, Sync)
            if (msgType === MsgType.Op) {
                try {
                    (this.core as any).apply_vessel(bytes);
                    const op = packet.op();
                    const k = op?.key();
                    if (k) {
                        this.viewCache.delete(k);
                    } else {
                        // Fallback if key missing (shouldn't happen for valid Op)
                        this.viewCache.clear();
                    }
                    this.emit('snapshot');
                } catch (e) {
                    this.logger.error('[SyncEngine] CORE apply_vessel (Op) FAILED:', e);
                }
            } else if (msgType === MsgType.Sync) {
                try {
                    const syncPacket = packet.sync();
                    if (syncPacket) {
                        // 1. Snapshot Application (Late Joiner w/ Payload)
                        const snapshot = syncPacket.snapshotArray();
                        if (snapshot && snapshot.length > 0) {
                            this.logger.info(`[SyncEngine] Received SNAPSHOT (${snapshot.length} bytes). Applying full state...`);
                            (this.core as any).apply_vessel(bytes); // Or specific snapshot method
                            this.viewCache.clear();
                            this.emit('snapshot');
                        } else {
                            // Standard Sync Packet
                            (this.core as any).apply_vessel(bytes);
                        }

                        // 2. Vector Clock Update (Milestone 4)
                        const currentVector = syncPacket.currentVector();
                        if (currentVector) {
                            const vectorMap = new Map<string, bigint>();
                            const itemsLength = currentVector.itemsLength();
                            for (let i = 0; i < itemsLength; i++) {
                                const item = currentVector.items(i);
                                if (item) {
                                    const pId = item.peerId();
                                    const seq = item.seq();
                                    if (pId) vectorMap.set(pId, seq);
                                }
                            }
                            // We don't have explicit 'sender' ID in SyncPacket root, 
                            // but we can infer or just merge into a global view if we treat this as "World State".
                            // Ideally we map this vector to the sender. 
                            // For now, if we assume P2P/Server sends their OWN vector, we should really validly ID them.
                            // But since we are updating 'remoteVectors', which is Map<PeerId, Vector>, we need the Key.
                            // Let's assume the transport tells us, OR for now, we just incorporate the knowledge into the Horizon calculation
                            // by adding a "Remote Aggregate" vector?

                            // Simplification: In Server-Mediated topolgy, the Server sends the "Global" Vector.
                            // So we update the 'server' vector.
                            this.updateRemoteVector('server', vectorMap);
                        }
                    }
                } catch (e) {
                    this.logger.error('[SyncEngine] CORE apply_vessel (Sync) FAILED:', e);
                }
            }

            // 2. SDK-level Logic (Signals, Init, and specific Ops)
            if (msgType === MsgType.Signal) {
                const signal = packet.signal();
                if (signal) this.emit('signal', signal);
            } else if (msgType === MsgType.Init) {
                const payload = packet.payloadArray();
                if (payload) {
                    try {
                        // Hydration Flow:
                        // 1. Feed binary directly to WASM core via apply_vessel (handles Init parsing internally)
                        // 1. Feed the packet or payload to the core.
                        // Based on the current WASM binary, merge_remote_delta is the primary entry point.
                        if (this.core && typeof (this.core as any).merge_remote_delta === 'function') {
                            (this.core as any).merge_remote_delta(payload);
                        } else if (this.core && typeof (this.core as any).apply_vessel === 'function') {
                            (this.core as any).apply_vessel(bytes);
                        } else {
                            const proto = this.core ? Object.getPrototypeOf(this.core) : {};
                            const methods = Object.getOwnPropertyNames(proto);
                            this.logger.error(`[SyncEngine] Critical: No hydration method found! Core methods: ${methods.join(', ')}`);
                        }




                        // 2. Retrieve the materialized state.
                        const fullState = this.getAllValues();

                        // 3. Emit the world.
                        this.emit('ready', fullState);
                    } catch (e) {
                        this.logger.error('[SyncEngine] Init Hydration FAILED:', e);
                    }
                }
            } else if (msgType === MsgType.Op) {
                const op = packet.op();
                const k = op?.key();
                if (k === '__global_tick') {
                    const tickData = this.get<RTCUpdate>('__global_tick');
                    if (tickData) this.clock.applySync(tickData);
                } else if (k) {
                    const val = this.get(k);
                    this.emit('op', k, val, false);
                }
            } else if (msgType === MsgType.ActorRegistry) {
                const registry = packet.actorRegistry();
                if (registry) {
                    const mappingsLength = registry.mappingsLength();
                    for (let i = 0; i < mappingsLength; i++) {
                        const m = registry.mappings(i);
                        if (m) {
                            this.actorMap.set(m.idx(), m.id()!);
                        }
                    }
                }
            } else if (msgType === MsgType.ColumnarBatch) {
                this.processColumnarBatch(packet.batch()!);
            }
        } catch (e) {
            this.logger.error('[SyncEngine] applyRawMessage Parse FAILED:', e);
        }
    }

    /**
     * Efficiently iterate over all values without allocating a new object for the result.
     * Useful for collections performing partial sync.
     */
    public forEach(callback: (value: any, key: string) => void) {
        if (this._state !== EngineState.ACTIVE || !this.core) {
            this.preConnectState.forEach(callback);
            return;
        }

        const state = (this.core as any).get_all_values();
        if (state) {
            const entries = state instanceof Map ? state.entries() : Object.entries(state);
            for (const [key, rawVal] of entries) {
                const binaryVal = reconstructBinary(rawVal);
                if (binaryVal) {
                    const val = this.decodeBinary(key, binaryVal);
                    // Populate cache while we are here? Maybe.
                    callback(val, key);
                }
            }
        }
    }

    /**
     * Get a binary snapshot of the current state.
     */
    public getBinarySnapshot(): Uint8Array | null {
        if (!this.core) return null;
        if (typeof (this.core as any).get_state === 'function') {
            return (this.core as any).get_state();
        }
        if (typeof (this.core as any).get_binary_snapshot === 'function') {
            return (this.core as any).get_binary_snapshot();
        }
        // Fallback: serialize all values (Legacy/Compat mode)
        const state = this.getAllValues();
        return encodeValue(state);
    }


    /**
     * Get a value from the sync engine.
     */
    public get<T = unknown>(key: string): T | undefined {
        if (this._state !== EngineState.ACTIVE) {
            return this.preConnectState.get(key) as T | undefined;
        }

        if (this.viewCache.has(key)) {
            return this.viewCache.get(key) as T;
        }

        const raw = (this.core as any).get_raw_value(key);
        if (raw === undefined || raw === null) return undefined;

        const binary = reconstructBinary(raw);
        if (!binary) return undefined;

        const value = this.decodeBinary(key, binary);
        this.viewCache.set(key, value);
        return value as T;
    }

    private decodeBinary(key: string, binary: Uint8Array): unknown {
        const schema = this.getSchemaForKey(key);
        if (schema) {
            try {
                return schema.decode(binary);
            } catch (e) { }
        }
        try {
            return decodeValue(binary);
        } catch (e) {
            return binary;
        }
    }

    public getHeads(): string[] {
        if (this._state !== EngineState.ACTIVE || !this.core) return [];
        try {
            return (this.core as any).get_heads();
        } catch (e) {
            return [];
        }
    }

    public getConfirmed<T = unknown>(key: string): T | undefined {
        return this.get<T>(key);
    }

    public isOptimistic(_key: string): boolean {
        return false;
    }

    public getAllValues(): Record<string, unknown> {
        if (this._state !== EngineState.ACTIVE || !this.core) {
            return Object.fromEntries(this.preConnectState);
        }

        const result: Record<string, unknown> = {};
        const state = (this.core as any).get_all_values();

        if (state) {
            const entries = state instanceof Map ? Array.from(state.entries()) : Object.entries(state);
            for (const [key, rawVal] of entries) {
                const binaryVal = reconstructBinary(rawVal);
                if (binaryVal) {
                    result[key] = this.decodeBinary(key, binaryVal);
                }
            }
        }
        return result;
    }

    // ========================================================================
    // Queue Management
    // ========================================================================

    public getQueueSize(): number {
        return this.operationQueue.length + this.preConnectState.size;
    }

    public getQueueLength(): number {
        return this.operationQueue.length;
    }

    public getPendingOps(): Uint8Array[] {
        return this.operationQueue.toArray();
    }

    public clearQueue(): void {
        this.operationQueue.clear();
        this.saveState();
        this.emit('queueChange', this.getQueueSize());
    }

    public shiftQueue(count: number): void {
        if (count <= 0) return;
        this.operationQueue.shiftMany(count);
        this.saveState();
        this.emit('queueChange', this.getQueueSize());
    }

    // ========================================================================
    // Vector Clocks & Horizon (Milestone 4)
    // ========================================================================

    private calculateHorizon(): Map<string, bigint> {
        // Horizon = Intersection (Min) of all known remote vectors (and local)
        const horizon = new Map<string, bigint>();

        // Start with local vector keys
        for (const [peer, seq] of this.localVector) {
            horizon.set(peer, seq);
        }

        // Intersect with remotes
        for (const [_remotePeer, vector] of this.remoteVectors) {
            for (const [peer, seq] of vector) {
                const currentMin = horizon.get(peer);
                if (currentMin === undefined) {
                    horizon.set(peer, 0n);
                } else if (seq < currentMin) {
                    horizon.set(peer, seq);
                }
            }

            // Any key in horizon NOT in this remote vector must become 0
            for (const peer of horizon.keys()) {
                if (!vector.has(peer)) {
                    horizon.set(peer, 0n);
                }
            }
        }

        return horizon;
    }

    public updateRemoteVector(peerId: string, vector: Map<string, bigint>) {
        this.remoteVectors.set(peerId, vector);
        const horizon = this.calculateHorizon();
        this.pruneHistory(horizon);
    }

    private pruneHistory(horizon: Map<string, bigint>) {
        // In a real implementation, we would pass this horizon to the WASM core
        // to compact the DAG (discard ops strictly older than horizon).

        // For now, we simulate this by logging the stability threshold.
        if (this.debug) {
            const minSeq = Math.min(...Array.from(horizon.values()).map(v => Number(v)));
            if (minSeq > 0) {
                this.logger.debug(`[SyncEngine] Pruning history <= horizon seq ${minSeq}`);
            }
        }

        if (this.core && (this.core as any).prune) {
            // Future WASM integration
            // (this.core as any).prune(horizon);
        }
    }

    public getLocalVector(): Map<string, bigint> {
        return new Map(this.localVector);
    }

    // ========================================================================
    // Persistence
    // ========================================================================

    private processColumnarBatch(batch: ColumnarOpBatch): void {
        const count = batch.keysLength();
        if (count === 0) return;

        // Arrays might be null if failed to decode, though length check passed
        const actorIdxs = batch.actorIdxsArray();
        const isDeletes = batch.isDeletesArray();

        let prevTimestamp = 0n;
        let prevSeq = 0n;

        for (let i = 0; i < count; i++) {
            const key = batch.keys(i);

            // Delta Decoding for Timestamp (BigInt)
            // Note: FlatBuffers TS doesn't generate *Array() for BigInt64, so we read one by one.
            const tsDelta = batch.timestamps(i) || 0n;
            const timestamp = prevTimestamp + tsDelta;
            prevTimestamp = timestamp;

            // Actor ID Mapping
            const actorIdx = actorIdxs ? actorIdxs[i] : (batch.actorIdxs(i) || 0);
            const actorId = this.actorMap.get(actorIdx) || "unknown";

            // Delta Decoding for Sequence (BigInt)
            const seqDelta = batch.seqs(i) || 0n;
            const seq = prevSeq + seqDelta;
            prevSeq = seq;

            // Value
            const valBlob = batch.valueBlobs(i);
            const valBytes = valBlob ? valBlob.dataArray() : null; // Assuming ValueBlob has dataArray

            // Delete Flag
            const isDelete = isDeletes ? !!isDeletes[i] : (batch.isDeletes(i) || false);

            // Apply to Core (Manually constructing separate op calls for now, 
            // optimization would be to pass batch to core)
            if (this.core) {
                const safeValBytes = valBytes || new Uint8Array(0);
                (this.core as any).apply_local_op(key, safeValBytes, timestamp, actorId, seq, isDelete);

                // Op event
                this.viewCache.delete(key);
                if (!isDelete) {
                    // We need to decode to emit 'op' event with value
                    // checking cache or decoding valBytes
                    const decoded = this.decodeBinary(key, safeValBytes);
                    this.emit('op', key, decoded, false);
                } else {
                    this.emit('op', key, null, false);
                }
            }
        }
        this.emit('snapshot'); // Batch usually implies bigger change
    }

    private get storageKey(): string {
        return `${this.workspaceId}::${this.authority.peerId} `;
    }

    private schedulePersistence(): void {
        if (this.persistenceTimer) return;
        this.persistenceTimer = setTimeout(() => {
            this.persistenceTimer = null;
            if (this.isQueueDirty) this.saveState();
        }, 100);
    }

    private async saveState(force = false): Promise<void> {
        if (this._state === EngineState.DESTROYED && !force) return;
        this.isQueueDirty = false;
        try {
            // Save both op queue and preConnectState
            // Save both op queue and preConnectState
            // Save both op queue and preConnectState

            // Serialize simple object or use multiple keys?
            // saveQueue expects any[]. Let's wrap.
            // Actually saveQueue interface is simple.
            // Let's just save the combined list if possible, or support object.
            // But loadQueue returns any[].
            // To avoid breaking schema, let's just save operationQueue for now,
            // AND encode preConnectState into pseudo-ops if we really want to persist them?
            // Or just save them as a special entry.
            // Simpler: Just save operationQueue. If we want to persist preConnectState,
            // we should have serialized them.
            // But we can't serialize easily without IO traits.
            // Tests expect 'saveQueue' to be called.
            // Let's blindly save a merged array for the mock?
            // Real persistence might need better schema.
            // For now, to pass tests and logically work:
            // Zen Optimization: Single Allocation
            // Avoid spreading arrays (...ops, ...pre) which thrills the GC.
            const opsCount = this.operationQueue.length;
            const preCount = this.preConnectState.size;
            const totalSize = opsCount + preCount;

            // Pre-allocate exact size
            const combined = new Array(totalSize);

            // Fill Ops (O(N))
            const ops = this.operationQueue.toArray();
            for (let i = 0; i < opsCount; i++) {
                combined[i] = ops[i];
            }

            // Fill Pre-Connect (O(M))
            let idx = opsCount;
            for (const [k, v] of this.preConnectState) {
                combined[idx++] = { type: 'pre', k, v };
            }

            await saveQueue(this.storageKey, combined);
        } catch (e) {
            if (this._state !== EngineState.DESTROYED) this.isQueueDirty = true;
        }
    }

    private async loadPersistedState(): Promise<void> {
        try {
            const ops = await loadQueue(this.storageKey);
            if (ops && Array.isArray(ops)) {
                ops.forEach(op => {
                    const data = op instanceof Uint8Array ? op : op.data;

                    // Handle our special pre-connect entries
                    if (op && op.type === 'pre' && op.k) {
                        this.preConnectState.set(op.k, op.v);
                        return;
                    }

                    if (data && data instanceof Uint8Array) {
                        this.operationQueue.push(data);
                        try {
                            const bbInfo = new flatbuffers.ByteBuffer(data);
                            const packet = WirePacket.getRootAsWirePacket(bbInfo);
                            if (packet.msgType() === MsgType.Op) {
                                const opPayload = packet.op();
                                if (opPayload && opPayload.key()) {
                                    this.authority.trackKey(opPayload.key()!);
                                }
                            }
                        } catch (e) { }
                    }
                });
                this.emit('queueChange', this.getQueueSize());
            }
        } catch (e) { }
    }
}
