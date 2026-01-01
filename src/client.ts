/**
 * NMeshed v2 - Client
 * 
 * The Zen Garden: Deceptively simple, impossible to use incorrectly.
 * This is the only file users need to understand.
 */

import { z } from 'zod';
import type { NMeshedConfig, ConnectionStatus, ClientEvents, EventHandler, INMeshedClient, IStorage } from './types';
import { SyncEngine } from './engine';
import { WebSocketTransport } from './transport';
import { encodeOp, decodeMessage, MsgType, encodeValue, encodePing, encodeCAS } from './protocol';
import { createProxy } from './StoreProxy';
import { IndexedDBAdapter } from './adapters/IndexedDBAdapter';
import { InMemoryAdapter } from './adapters/InMemoryAdapter';

// =============================================================================
// NMeshed Client
// =============================================================================

export class NMeshedClient implements INMeshedClient {
    private config: NMeshedConfig;
    private engine: SyncEngine;
    private transport: WebSocketTransport;
    private debug: boolean;
    private unsubscribers: (() => void)[] = [];
    private storage: IStorage;
    private keySubscribers = new Map<string, Set<() => void>>();

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
        this.engine = new SyncEngine(peerId, this.storage, this.debug);
        this.transport = new WebSocketTransport(config);

        // Optimizing Event Dispatch:
        // The Engine emits 'op' for everything. The Client can offer a finer API.
        // Actually, let's add `subscribeKey` to SyncEngine directly or handle the Map here.
        // Handling here is safer for refactoring without touching Engine yet.
        // Wait, the instruction says "Add subscribe method".
        // Let's implement the Map<Key, Set<Callback>> in Client for now 
        // as `engine` is imported and might be shared code.


        // Wire up transport to engine
        this.wireTransport();

        // Hydration (RSC/SSR)
        if (config.initialSnapshot) {
            this.engine.loadSnapshot(config.initialSnapshot);
            this.engine.setStatus('ready'); // Assume ready if hydrated
        }

        // Initialize Persistence & Connection
        this.init();
    }

    private async init() {
        // 1. Request Persistence (W1-10)
        if (this.config.persist !== false && typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
            try {
                const persisted = await navigator.storage.persist();
                this.log(`Persistence requested: ${persisted ? 'Granted' : 'Denied'}`);
            } catch (e) {
                this.log('Persistence request failed', e);
            }
        }

        // 2. Initialize Storage
        try {
            await this.storage.init();

            // 3. Load Local State (Offline First)
            await this.engine.loadFromStorage();

            // 4. Connect
            this.connect();
        } catch (e) {
            this.log('Storage initialization failed', e);
            // Fallback: connect anyway
            this.connect();
        }
    }

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /** Get a value by key */
    get<T = unknown>(key: string): T | undefined {
        return this.engine.get<T>(key);
    }

    /** Set a key-value pair */
    set<T = unknown>(key: string, value: T): void {
        this.engine.set(key, value);
    }

    /** Delete a key */
    delete(key: string): void {
        this.engine.delete(key);
    }

    /** 
     * Atomic Compare-And-Swap 
     * Returns true if successful (value matched expected), false otherwise.
     * If successful, the value is updated to newValue.
     */
    async cas<T = unknown>(key: string, expected: T | null, newValue: T): Promise<boolean> {
        return this.engine.cas(key, expected, newValue);
    }

    /** Subscribe to events */
    on<K extends keyof ClientEvents>(event: K, handler: EventHandler<K>): () => void {
        return this.engine.on(event, handler);
    }

    /** Get current connection status */
    getStatus(): ConnectionStatus {
        return this.engine.getStatus();
    }

    /** Get client's peer ID */
    getPeerId(): string {
        return this.engine.getPeerId();
    }

    /** Get all values */
    getAllValues(): Record<string, unknown> {
        return this.engine.getAllValues();
    }

    /** Iterate over all entries */
    forEach(callback: (value: unknown, key: string) => void): void {
        this.engine.forEach(callback);
    }

    /** 
     * Subscribe to changes on a specific key 
     * This offers O(1) dispatch instead of O(N) event filtering.
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

    /** Wait for ready state */
    async awaitReady(): Promise<void> {
        if (this.getStatus() === 'ready') return;

        return new Promise((resolve) => {
            const unsub = this.on('ready', () => {
                unsub();
                resolve();
            });
        });
    }

    /** Disconnect and cleanup */
    disconnect(): void {
        this.unsubscribers.forEach((unsub) => unsub());
        this.transport.disconnect();
        this.engine.destroy();
    }

    // ---------------------------------------------------------------------------
    // Schema-Driven API (The "Ferrari" Engine)
    // ---------------------------------------------------------------------------

    /**
     * Get a schematic store proxy.
     * returns a Proxy wrapper that intercepts mutations for CRDT sync.
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

    private async connect(): Promise<void> {
        this.engine.setStatus('connecting');

        try {
            await this.transport.connect();
            // onOpen handler will set 'connected' -> 'syncing'
        } catch (error) {
            this.engine.setStatus('error');
            this.engine.emit('error', error instanceof Error ? error : new Error(String(error)));
        }
    }

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

        // Auto-Broadcast: Listen to local ops and send them
        const unsubOp = this.engine.on('op', (key, value, isLocal) => {
            // optimized dispatch
            const subscribers = this.keySubscribers.get(key);
            if (subscribers) {
                subscribers.forEach(cb => cb());
            }

            // console.log('[Client] Op event:', key, isLocal, this.transport.isConnected());
            if (isLocal && this.transport.isConnected()) {
                const payload = encodeValue(value);
                const wireData = encodeOp(key, payload);
                this.transport.send(wireData);
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
                    this.log('Ping timeout - disconnecting');
                    this.transport.disconnect();
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

    private flushPendingOps(): void {
        const ops = this.engine.drainPending();
        if (ops.length > 0) {
            this.log(`Flushing ${ops.length} pending ops`);
            for (const op of ops) {
                const payload = encodeValue(op.value);
                const wireData = encodeOp(op.key, payload);
                this.transport.send(wireData);
            }
        }
    }

    private handleMessage(data: Uint8Array): void {
        const msg = decodeMessage(data); // New helper
        if (!msg) return;

        // Clock Synchronization
        if (msg.timestamp && msg.timestamp > 0) {
            // Simple NTP-like adjustment: 
            // We assume latency is symmetric or negligible for this MVP.
            // offset = serverTime - localTime
            const offset = msg.timestamp - Date.now();
            this.engine.setClockOffset(offset);
        }

        switch (msg.type) {
            case MsgType.Init:
                // Load snapshot and transition to ready
                if (msg.payload) {
                    this.engine.loadSnapshot(msg.payload);
                    this.engine.setStatus('ready');
                    this.engine.emit('ready');
                }
                break;

            case MsgType.Op:
                // Apply remote operation
                if (msg.key && msg.payload) {
                    this.engine.applyRemote(msg.key, msg.payload, 'remote');
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

    private log(...args: unknown[]): void {
        if (this.debug) {
            console.log('[NMeshed Client]', ...args);
        }
    }
}
