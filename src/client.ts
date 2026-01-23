/**
 * @module Client
 * @description
 * The `NMeshedClient` is the primary entry point for the nMeshed SDK.
 * It strictly manages the lifecycle of the connection, local storage persistence, and the core synchronization engine.
 * 
 * ## Architecture Overview
 * The Client acts as the Orchestrator. It does not implement CRDT logic itself (that's the {@link SyncEngine}) 
 * nor does it handle raw sockets (that's the {@link WebSocketTransport}). 
 * Instead, it wires them together and exposes a clean, "Zen" API to the user.
 * 
 * ## Connection Lifecycle
 * 
 * ```mermaid
 * stateDiagram-v2
 *     [*] --> Initializing
 *     Initializing --> Connecting: Storage Loaded
 *     Connecting --> Syncing: WebSocket Open
 *     Syncing --> Reconnecting: WebSocket Closed (Heartbeat Fail)
 *     Reconnecting --> Syncing: Reconnect Success
 *     Reconnecting --> Error: Reconnect Max Retries
 * ```
 */

import { z } from 'zod';
import type { NMeshedConfig, ConnectionStatus, ClientEvents, EventHandler, INMeshedClient, IStorage } from './types';
import { SyncEngine } from './engine';
import { WebSocketTransport } from './transport';
import { encodeOp, decodeMessage, MsgType, encodeValue, encodePing, encodeCAS, encodeInit } from './protocol';
import { createProxy } from './StoreProxy';
import { IndexedDBAdapter } from './adapters/IndexedDBAdapter';
import { InMemoryAdapter } from './adapters/InMemoryAdapter';

// =============================================================================
// NMeshed Client
// =============================================================================

/**
 * The main client class for interacting with the nMeshed service.
 * 
 * @example
 * ```typescript
 * const client = new NMeshedClient({
 *     workspaceId: 'ws_123',
 *     token: 'secret_token'
 * });
 * 
 * await client.awaitReady();
 * client.set('foo', 'bar');
 * ```
 */
export class NMeshedClient implements INMeshedClient {
    private config: NMeshedConfig;
    private engine: SyncEngine;
    private transport: WebSocketTransport;
    private debug: boolean;
    private unsubscribers: (() => void)[] = [];
    private storage: IStorage;
    private keySubscribers = new Map<string, Set<() => void>>();

    /**
     * Creates a new instance of the NMeshedClient.
     * 
     * @param config - The configuration object.
     * @throws {Error} If `workspaceId` is missing.
     * @throws {Error} If neither `token` nor `apiKey` is provided.
     * 
     * @example
     * // FAILURE SCENARIO:
     * // If execution throws "workspaceId is required", verify your implementation:
     * // 1. Check if process.env.NEXT_PUBLIC_WORKSPACE_ID is actually defined.
     * // 2. If using a config object, ensure the key is exactly 'workspaceId', not 'workspace_id'.
     */
    constructor(config: NMeshedConfig) {
        // Validate config at the gates
        if (!config.workspaceId) {
            throw new Error('[NMeshed] workspaceId is required');
        }
        if (!config.token && !config.apiKey) {
            throw new Error('[NMeshed] token or apiKey is required');
        }

        this.config = config;
        this.debug = config.debug || false;

        // Initialize Storage
        // causality: We default to IndexedDB for persistence reliability in browsers,
        // but fallback to InMemory for tests or Node.js environments to prevent runtime crashes.
        if (config.storage) {
            this.storage = config.storage;
        } else if (typeof indexedDB !== 'undefined') {
            this.storage = new IndexedDBAdapter(config.workspaceId);
        } else {
            this.storage = new InMemoryAdapter();
        }

        // Generate peer ID
        const peerId = config.userId || this.generatePeerId();

        // Initialize engine and transport
        this.engine = new SyncEngine(peerId, this.storage, this.debug, config.encryption);

        // Generate Trace Parent for Observability (W3C Standard)
        if (!config.traceparent) {
            config.traceparent = this.generateTraceParent();
        }

        this.transport = new WebSocketTransport(config);

        // Wire up transport to engine
        this.wireTransport();

        // Hydration (RSC/SSR)
        // causality: If we have an initial snapshot (e.g. from server-side rendering),
        // we load it immediately so the UI can render meaningful content before the socket connects.
        if (config.initialSnapshot) {
            this.hydrate(config.initialSnapshot);
        } else {
            // Initialize Persistence & Connection
            // We fire this asynchronously to allow the constructor to return immediately.
            this.init();
        }
    }

    private async hydrate(snapshot: Uint8Array) {
        await this.engine.loadSnapshot(snapshot, 1n);
        this.engine.setStatus('ready'); // Assume ready if hydrated
    }

    /**
     * Asynchronous initialization sequence.
     * 1. Requests persistent storage permission from the browser.
     * 2. Initializes the storage adapter (IndexedDB).
     * 3. Loads local state into memory.
     * 4. Establishes the WebSocket connection.
     * 
     * @private
     */
    /**
     * Asynchronous initialization sequence.
     * 1. Requests persistent storage permission from the browser.
     * 2. Initializes the storage adapter (IndexedDB).
     * 3. Loads local state into memory.
     * 4. Establishes the WebSocket connection.
     * 
     * @private
     */
    private async init() {
        // 1. Request Persistence (Browser)
        await this.ensurePersistence();

        // 2. Initialize Storage & Load State
        await this.initializeEngineState();

        // 3. Connect Network (with Thundering Herd Mitigation)
        // Add random jitter (0-500ms) to prevent all clients connecting simultaneously
        const jitter = Math.floor(Math.random() * 500);
        setTimeout(() => {
            this.connect();
        }, jitter);
    }

    /** Helper: Request browser storage persistence to prevent eviction */
    private async ensurePersistence() {
        if (this.config.persist !== false && typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
            try {
                const persisted = await navigator.storage.persist();
                this.log(`Persistence requested: ${persisted ? 'Granted' : 'Denied'}`);
            } catch (e) {
                this.log('Persistence request failed', e);
            }
        }
    }

    /** Helper: Initialize storage and hydrate engine from disk */
    private async initializeEngineState() {
        try {
            await this.storage.init();
            await this.engine.loadFromStorage();
        } catch (e) {
            this.log('Storage initialization failed', e);
            // Non-fatal: Proceed to connect even if storage fails (InMemory fallback usually handles runtime)
        }
    }

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /**
     * Retrieves the current value for a given key from the local store.
     * 
     * @remarks
     * This is a synchronous, in-memory lookup. It is Instant (O(1)).
     * 
     * @param key - The key to retrieve.
     * @returns The value associated with the key, or `undefined` if not found.
     */
    get<T = unknown>(key: string): T | undefined {
        return this.engine.get<T>(key);
    }

    /**
     * Updates the value for a given key.
     * 
     * @remarks
     * This operation is optimistic:
     * 1. It creates an operation.
     * 2. Applies it locally immediately (updating the UI).
     * 3. Queues it for network transmission.
     * 
     * @param key - The key to set.
     * @param value - The value to store. Must be serializable.
     */
    set<T = unknown>(key: string, value: T): void {
        this.log(`set(${key}, ${JSON.stringify(value)})`);
        this.engine.set(key, value).catch(e => {
            console.error('[NMeshed] Set operation failed', e);
        });
    }

    /**
     * Removes a key and its value from the store.
     * 
     * @remarks
     * Treated as a "tombstone" operation in the CRDT engine to ensure deletion propagates correctly
     * across distributed peers.
     * 
     * @param key - The key to delete.
     */
    delete(key: string): void {
        this.engine.delete(key).catch(e => {
            console.error('[NMeshed] Delete operation failed', e);
        });
    }

    /** 
     * Performs an Atomic Compare-And-Swap (CAS) operation.
     * 
     * @remarks
     * Useful for implementing locks, counters, or transactional updates.
     * This operation is **not** purely local/optimistic. It requires coordination logic.
     * 
     * @param key - The target key.
     * @param expected - The value you expect to currently exist (null if expecting non-existence).
     * @param newValue - The value to set if the expectation matches.
     * @returns A Promise resolving to `true` if the swap succeeded, `false` otherwise.
     */
    async cas<T = unknown>(key: string, expected: T | null, newValue: T): Promise<boolean> {
        return this.engine.cas(key, expected, newValue);
    }

    /**
     * Subscribes to global client events.
     * 
     * @param event - The event name ('ready', 'syncing', 'error', 'op').
     * @param handler - The callback function.
     * @returns A function to unsubscribe.
     */
    on<K extends keyof ClientEvents>(event: K, handler: EventHandler<K>): () => void {
        return this.engine.on(event, handler);
    }

    /**
     * Returns the current connection status.
     * 
     * @returns One of 'initializing' | 'connecting' | 'syncing' | 'offline' | 'reconnecting' | 'error' | 'ready'.
     */
    getStatus(): ConnectionStatus {
        return this.engine.getStatus();
    }

    /**
     * Returns the unique Peer ID of this client instance.
     * 
     * @remarks
     * Used for conflict resolution (LWW - Last Write Wins) ties.
     */
    getPeerId(): string {
        return this.engine.getPeerId();
    }

    /**
     * Returns a snapshot of all current key-value pairs.
     */
    getAllValues(): Record<string, unknown> {
        return this.engine.getAllValues();
    }

    /**
     * Iterates over all key-value pairs in the store.
     * 
     * @param callback - Function to execute for each entry.
     */
    forEach(callback: (value: unknown, key: string) => void): void {
        this.engine.forEach(callback);
    }

    /** 
     * Subscribes to changes on a **specific key**.
     * 
     * @remarks
     * Ideally used for binding a specific UI component to a specific data point.
     * This offers O(1) dispatch efficiency, avoiding the overhead of filtering global 'op' events.
     * 
     * @param key - The key to watch.
     * @param callback - The function to call when the key's value changes.
     * @returns Unsubscribe function.
     */
    subscribe(key: string, callback: () => void): () => void {
        if (!this.keySubscribers.has(key)) {
            this.keySubscribers.set(key, new Set());
        }
        const set = this.keySubscribers.get(key)!;
        set.add(callback);

        return () => {
            set.delete(callback);
            if (set.size === 0) {
                this.keySubscribers.delete(key);
            }
        };
    }

    /**
     * Waits until the client is in the 'ready' state.
     * 
     * @remarks
     * The 'ready' state implies that local storage has been loaded.
     * It does *not* necessarily mean we are connected to the server, but it means
     * the client is safe to read/write against.
     * 
     * @returns Promise that resolves when ready.
     */
    async awaitReady(): Promise<void> {
        if (this.getStatus() === 'ready') return;

        return new Promise((resolve) => {
            const unsub = this.on('ready', () => {
                unsub();
                resolve();
            });
        });
    }

    /**
     * Gracefully disconnects the client.
     * 
     * @remarks
     * 1. Unsubscribes all listeners.
     * 2. Closes the WebSocket connection.
     * 3. Destroys the engine instance.
     */
    disconnect(): void {
        this.unsubscribers.forEach((unsub) => unsub());
        this.transport.disconnect();
        this.engine.destroy();
    }

    // ---------------------------------------------------------------------------
    // Schema-Driven API (The "Ferrari" Engine)
    // ---------------------------------------------------------------------------

    /**
     * Creates a Type-Safe Store Proxy for a specific key.
     * 
     * @remarks
     * Returns a Proxy object that intercepts mutations and automatically synchronizes them.
     * This allows you to treat remote data as if it were a local mutable object.
     * 
     * @param key - The root key to proxy.
     * @returns A proxy object typed as T.
     */
    store<T = any>(key: string): T {
        return createProxy(
            this.engine,
            key,
            this.config.schemas?.[key] || z.any()
        ) as T;
    }

    // ---------------------------------------------------------------------------
    // Private
    // ---------------------------------------------------------------------------

    /**
     * Initiates the WebSocket connection sequence.
     * 
     * @private
     */
    private async connect(): Promise<void> {
        this.engine.setStatus('connecting');

        try {
            await this.transport.connect();
            // Note: The onOpen handler (wired in wireTransport) will transition state 
            // from 'connected' -> 'syncing'.
        } catch (error) {
            this.engine.setStatus('error');
            this.engine.emit('error', error instanceof Error ? error : new Error(String(error)));
        }
    }

    /**
     * Sets up event listeners between the Network Transport and the Sync Engine.
     * 
     * @private
     */
    private wireTransport(): void {
        // Handle incoming messages
        const unsubMessage = this.transport.onMessage((data) => {
            this.handleMessage(data);
        });
        this.unsubscribers.push(unsubMessage);

        // Handle connection established
        const unsubOpen = this.transport.onOpen(() => {
            this.engine.setStatus('connected');
            this.engine.setStatus('syncing');
            // FIX: Send Init Handshake so server knows to send snapshot
            this.log('Sending Init Handshake');
            this.transport.send(encodeInit(new Uint8Array()));
            this.flushPendingOps();
            this.startHeartbeat();
        });
        this.unsubscribers.push(unsubOpen);

        // Handle disconnection
        const unsubClose = this.transport.onClose(() => {
            this.engine.setStatus('reconnecting');
            this.stopHeartbeat();
        });
        this.unsubscribers.push(unsubClose);

        // Auto-Broadcast: Listen to local ops and send them to the server
        const unsubOp = this.engine.on('op', (key, value, isLocal, timestamp, isReplay, isCAS) => {
            // optimized dispatch to specific key subscribers
            const subscribers = this.keySubscribers.get(key);
            if (subscribers) {
                subscribers.forEach(cb => cb());
            }

            // Replay Suppression (Bug 5 Fix)
            if (isReplay) return;

            // CAS Suppression (Fix for Double-Write)
            // If this op was generated by a CAS, we do NOT broadcast it as a blind Op.
            // The 'cas' event will handle the network transmission.
            if (isCAS) return;

            // DEBUG: Log op propagation
            if (isLocal) {
                const connected = this.transport.isConnected();
                this.log(`Op: ${key} | Local: ${isLocal} | Connected: ${connected}`);

                if (connected) {
                    // Send operation to server
                    // Use async IIFE to handle potential encryption overhead without blocking handling loop
                    (async () => {
                        let payload = encodeValue(value);
                        let isEncrypted = false;
                        if (this.config.encryption) {
                            payload = await this.config.encryption.encrypt(payload);
                            isEncrypted = true;
                        }
                        // Bug 4 Fix: Use the actual timestamp from the engine!
                        const ts = timestamp || BigInt(Date.now());
                        const wireData = encodeOp(key, payload, ts, isEncrypted, this.engine.getPeerId());
                        this.transport.send(wireData);
                    })();

                } else {
                    this.log(`Queueing Op (Offline): ${key}`);
                }
            }
        });
        this.unsubscribers.push(unsubOp);

        // Wire CAS
        // @ts-ignore - Engine emits generic events, but we need to declare checking type in Engine if strict.
        const unsubCas = this.engine.on('cas' as any, (wireData: Uint8Array) => {
            if (this.transport.isConnected()) {
                this.transport.send(wireData);
            }
        });
        this.unsubscribers.push(unsubCas);
    }

    // ---------------------------------------------------------------------------
    // Heartbeat (Ping/Pong)
    // ---------------------------------------------------------------------------

    private pingInterval: any = null;
    private pongTimeout: any = null;

    /**
     * Starts the heartbeat mechanism to detect silent connection drops.
     * Sends a PING every 30s. Expects a PONG within 5s.
     * 
     * @private
     */
    private startHeartbeat() {
        this.stopHeartbeat();
        // Send Ping every 30s
        this.pingInterval = setInterval(() => {
            if (this.transport.isConnected()) {
                this.log('Sending Ping');
                this.transport.send(encodePing());

                // Expect Pong within 5s
                if (this.pongTimeout) clearTimeout(this.pongTimeout);
                this.pongTimeout = setTimeout(() => {
                    this.log('Ping timeout - reconnecting');
                    this.transport.reconnect().catch(e => this.log('Reconnect failed', e));
                }, 5000);
            }
        }, 30000);
    }

    private stopHeartbeat() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.pongTimeout) clearTimeout(this.pongTimeout);
        this.pingInterval = null;
        this.pongTimeout = null;
    }

    /**
     * Flushes ops that were generated while offline to the server.
     * 
     * @private
     */
    private async flushPendingOps(): Promise<void> {
        const ops = this.engine.drainPending();
        if (ops.length > 0) {
            this.log(`Flushing ${ops.length} pending ops`);
            for (const op of ops) {
                let payload = encodeValue(op.value);
                let isEncrypted = false;
                if (this.config.encryption) {
                    payload = await this.config.encryption.encrypt(payload);
                    isEncrypted = true;
                }
                const wireData = encodeOp(op.key, payload, op.timestamp, isEncrypted, this.engine.getPeerId());
                this.transport.send(wireData);
            }
        }
    }

    /**
     * Routes incoming wire messages to the appropriate logic.
     * 
     * @param data - Raw binary message from the websocket.
     */
    private handleMessage(data: Uint8Array): void {
        const msg = decodeMessage(data);
        if (!msg) return;

        // Clock Synchronization
        if (msg.timestamp && msg.timestamp > 0n) {
            // Simple NTP-like adjustment: 
            // We assume latency is symmetric or negligible for this MVP.
            // offset = serverTime - localTime
            // HLC is (Physical << 80) ...
            // We want roughly the physical difference. 
            // Better: use HLC.unpack
            // But for simple offset, we can just store the delta. 
            // setClockOffset expects number? Engine ignores it anyway in HLC mode.
            // keeping it as no-op or simple cast.
            const offset = Number(msg.timestamp >> 80n) - Date.now();
            this.engine.setClockOffset(offset);
        }

        switch (msg.type) {
            case MsgType.Init:
                // Load snapshot and transition to ready
                if (msg.payload) {
                    // loadSnapshot is async - properly await it before setting ready status
                    (async () => {
                        await this.engine.loadSnapshot(msg.payload!, msg.timestamp);
                        this.engine.setStatus('ready');
                        this.engine.emit('ready');
                    })();
                }
                break;

            case MsgType.Op:
                // Apply remote operation
                if (msg.key && msg.payload) {
                    // Pass timestamp and actorId for proper LWW ordering
                    this.engine.applyRemote(msg.key, msg.payload, msg.actorId || 'remote', msg.timestamp);
                }
                break;

            case MsgType.Pong:
                this.log('Received Pong');
                if (this.pongTimeout) {
                    clearTimeout(this.pongTimeout);
                    this.pongTimeout = null;
                }
                break;
        }
    }

    private generatePeerId(): string {
        return `peer_${Math.random().toString(36).substring(2, 11)}`;
    }

    private generateTraceParent(): string {
        const traceId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        const spanId = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        return `00-${traceId}-${spanId}-01`;
    }

    private log(...args: unknown[]): void {
        if (this.debug) {
            console.log('[NMeshed Client]', ...args);
        }
    }
}
