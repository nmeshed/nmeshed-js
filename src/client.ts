import { EventEmitter } from './utils/EventEmitter';
import { AuthProvider, StaticAuthProvider } from './auth/AuthProvider';
import { SyncEngine } from './core/SyncEngine';
import { SyncedCollection, Filters, SyncedCollectionOptions } from './sync/SyncedCollection';
import { Transport, TransportStatus } from './transport/Transport';
import { WebSocketTransport } from './transport/WebSocketTransport';

import { Schema, InferSchema } from './schema/SchemaBuilder';
import { NMeshedMessage, ConnectionStatus } from './types';
import { ConfigurationError, ConnectionError } from './errors';
import { Logger } from './utils/Logger';

export interface NMeshedConfig {
    workspaceId: string;
    userId?: string;
    auth?: AuthProvider;
    token?: string;
    apiKey?: string;
    transport?: 'server';
    relayUrl?: string; // Standard
    serverUrl?: string; // Legacy alias
    debug?: boolean;
    heartbeatInterval?: number;
    heartbeatMaxMissed?: number;
    maxQueueSize?: number;
    connectionTimeout?: number;
    autoReconnect?: boolean;
    maxReconnectAttempts?: number;
    /** Base delay for reconnection backoff in ms (default: 1000) */
    initialReconnectDelay?: number;
    /** Maximum delay between reconnect attempts in ms (default: 10000) */
    maxReconnectDelay?: number;
    /** Custom path to the nmeshed_core.wasm file (Node.js only) */
    wasmPath?: string;
    /** Registry of schemas to pre-register on initialization */
    schemas?: Record<string, Schema<any>>;
}


// Environment Constants
const IS_NODE = typeof process !== 'undefined' && process.versions && !!process.versions.node;
const IS_BROWSER = typeof window !== 'undefined' && typeof window.document !== 'undefined';







/**
 * Derives the relay URL based on environment and configuration.
 * Priority: explicit config > environment variable > localhost detection > production default
 * 
 * @throws ConfigurationError if the derived URL is invalid
 */
function deriveRelayUrl(workspaceId: string, config: NMeshedConfig): string {
    let url: string;

    // 1. Explicit configuration takes priority
    if (config.relayUrl) {
        url = config.relayUrl;
    } else if (config.serverUrl) {
        url = config.serverUrl;
    } else if (IS_NODE && process.env?.NMESHED_RELAY_URL) {
        // 2. Environment variable (Node.js)
        url = process.env.NMESHED_RELAY_URL;
    } else if (IS_BROWSER && window.location?.hostname === 'localhost') {
        // 3. Localhost detection (Browser dev mode)
        const encodedId = encodeURIComponent(workspaceId);
        url = `ws://127.0.0.1:9000/ws?workspace_id=${encodedId}`;
    } else {
        // 4. Production default
        url = 'wss://api.nmeshed.com';
    }

    // Defensive: Validate URL format (ensure it starts with ws:// or wss://)
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
        throw new ConfigurationError(`Invalid relay URL: "${url}". Must start with ws:// or wss://`);
    }

    return url;
}


/**
 * NMeshedClient: The Zen Gateway to Real-Time Sync.
 * 
 * Embodies "Absolute Clarity" by providing a single, unified entry point 
 * for all synchronization tasks. It abstracts away the complexity of 
 * transport negotiation (Server), binary encoding (Flatbuffers), 
 * and optimistic state management.
 */
export interface NMeshedEvents {
    status: [ConnectionStatus];
    message: [NMeshedMessage];
    ephemeral: [unknown, string?];
    error: [any];
    peerJoin: [string];
    peerDisconnect: [string];
    presence: [any];
    [key: string]: any[];
}

export class NMeshedClient extends EventEmitter<NMeshedEvents> {
    public readonly workspaceId: string;
    public readonly userId: string;
    public readonly engine: SyncEngine;
    public readonly transport: Transport;
    public readonly bootPromise: Promise<void>;
    public readonly config: NMeshedConfig;
    private logger: Logger;
    private isDestroyed = false;
    private _status: ConnectionStatus = 'IDLE';
    /** Registry to ensure singleton SyncedCollection instances per prefix */
    private _collections = new Map<string, SyncedCollection<any>>();
    private _latestState: Record<string, any> | null = null;



    /**
     * Creates a client instance pre-configured for local development.
     * 
     * - Auto-connects to localhost:9000 (or derived relay URL)
     * - Uses a dummy 'dev-token' for authentication
     * - Enables debug mode by default
     */
    static dev(workspaceId: string, config: Omit<NMeshedConfig, 'workspaceId'> = {}): NMeshedClient {
        return new NMeshedClient({
            workspaceId,
            token: 'dev-token',
            debug: true,
            ...config
        });
    }

    constructor(config: NMeshedConfig) {
        super();

        if (!config.workspaceId) throw new ConfigurationError('workspaceId is required');

        this.logger = new Logger('NMeshedClient', config.debug);

        // Zen: Relaxed auth for Dev Mode / Localhost
        // If we detect localhost or debug mode, we allow missing credentials by filling a dummy one
        const isLocalhost = IS_BROWSER && window.location?.hostname === 'localhost';
        if (!config.token && !config.apiKey && !config.auth) {
            if (config.debug || isLocalhost) {
                if (config.debug) this.logger.info('Dev Mode: using dummy "dev-token"');
                config.token = 'dev-token';
            } else {
                throw new ConfigurationError('Authentication required. Provide an auth adapter, token, or apiKey.');
            }
        }


        if (config.maxQueueSize !== undefined && config.maxQueueSize < 0) throw new ConfigurationError('maxQueueSize must be >= 0');
        if (config.maxReconnectAttempts !== undefined && config.maxReconnectAttempts < 0) throw new ConfigurationError('maxReconnectAttempts must be >= 0');

        if (config.transport && config.transport !== 'server') {
            throw new ConfigurationError(`Invalid transport: ${config.transport}. Only 'server' is supported.`);
        }

        this.config = { ...config };
        this.config.transport = 'server'; // Force server

        this.workspaceId = config.workspaceId;
        this.userId = config.userId || `u-${Math.random().toString(36).substring(2, 9)}`;

        this.engine = new SyncEngine(
            config.workspaceId,
            this.userId,
            config.maxQueueSize || 1000,
            config.debug,
            config.wasmPath
        );

        // Zen Convenience: Pre-register schemas
        if (config.schemas) {
            for (const [prefix, schema] of Object.entries(config.schemas)) {
                const normalizedPrefix = prefix.endsWith(':') ? prefix : (prefix === '' ? '' : `${prefix}:`);
                this.engine.registerSchema(normalizedPrefix, schema);
            }
        }

        this.bootPromise = this.engine.boot();


        // Zen Identity: Wrap string tokens in StaticAuthProvider
        let auth = config.auth;
        if (!auth && (config.token || config.apiKey)) {
            auth = new StaticAuthProvider(config.token || config.apiKey || '');
        }

        // Token Provider for Transports
        const tokenProvider = auth ? async () => (await auth!.getToken()) || '' : undefined;

        // Zen: Auto-derive relay URL from environment
        const relayUrl = deriveRelayUrl(config.workspaceId, config);
        this.config.relayUrl = relayUrl;

        this.transport = new WebSocketTransport(relayUrl, {

            workspaceId: config.workspaceId,
            peerId: this.userId,
            tokenProvider, // Pass the provider
            token: config.token || config.apiKey || '', // Fallback initial token
            debug: config.debug,
            heartbeatInterval: config.heartbeatInterval,
            heartbeatMaxMissed: config.heartbeatMaxMissed,
            connectionTimeout: config.connectionTimeout,
            autoReconnect: config.autoReconnect,
            maxReconnectAttempts: config.maxReconnectAttempts,
            initialReconnectDelay: config.initialReconnectDelay,
            maxReconnectDelay: config.maxReconnectDelay
        });

        this.setupBindings();
    }

    private setupBindings() {
        this.transport.on('message', (bytes) => {
            try {
                this.engine.applyRawMessage(bytes);
            } catch (e) {
                this.logger.error('Failed to apply raw message to SyncEngine:', e);
                this.emit('error', e);
            }
        });
        // Backward compatibility for legacy transports
        this.transport.on('sync' as any, (bytes: Uint8Array) => {
            try {
                this.engine.applyRawMessage(bytes);
            } catch (e) {
                this.logger.error('Failed to apply raw sync message:', e);
            }
        });
        this.engine.on('ready', (state: any) => {
            this._latestState = state;
            // Re-emit as 'message' with type 'init' and full state for legacy/generic listeners
            this.emit('message', { type: 'init', data: state } as any);
            this.emit('ready' as any, state);

            // Re-evaluate status now that we are hydrated
            this.updateStatus(this.transport.getStatus());
        });


        this.transport.on('status', (s) => this.updateStatus(s));
        this.transport.on('ack' as any, (count: number) => {
            this.engine.shiftQueue(count);
        });
        this.transport.on('error', (e) => this.emit('error', e));
        this.transport.on('peerJoin', (id) => {
            if (!id || id === 'userId' || id === 'status') return;
            this.engine.authority.addPeer(id);
            this.emit('peerJoin', id);
        });
        this.transport.on('peerDisconnect', (id) => {
            if (!id || id === 'userId' || id === 'status') return;
            this.engine.authority.removePeer(id);
            this.emit('peerDisconnect', id);
        });
        this.transport.on('presence', (p) => {
            if (p && typeof p === 'object') {
                if (p.userId && p.status) {
                    const isOnline = p.status === 'online';
                    if (isOnline) {
                        this.emit('peerJoin', p.userId);
                    } else {
                        this.emit('peerDisconnect', p.userId);
                    }
                } else if (!Array.isArray(p)) {
                    Object.entries(p).forEach(([id, status]: [string, any]) => {
                        const isOnline = status === 'online' || (status && status.status === 'online');
                        if (isOnline) {
                            this.emit('peerJoin', id);
                        } else {
                            this.emit('peerDisconnect', id);
                        }
                    });
                }
            }
            this.emit('presence', p);
        });
        this.transport.on('ephemeral', (p, f) => {
            if (p && p.type === '__ping__') {
                this.sendMessage({ type: '__pong__', to: p.from, requestId: p.requestId } as any);
                return;
            }
            // Strict check: if signal data is binary, it comes from MessageRouter
            // If it's ephemeral, it comes from transport.
            this.emit('ephemeral', p, f);
        });

        this.engine.on('op', (k, v, opt) => this.emit('message', {
            type: 'op',
            payload: { key: k, value: v, isOptimistic: opt, timestamp: Date.now() }
        }));
    }

    private updateStatus(transportStatus?: TransportStatus) {
        const ts = transportStatus || this.transport.getStatus();
        const isHydrated = this.engine.isHydrated;

        let derived: ConnectionStatus;
        if (ts === 'CONNECTED') {
            derived = isHydrated ? 'READY' : 'SYNCING';
        } else if (ts === 'RECONNECTING') {
            derived = 'RECONNECTING';
        } else if (ts === 'CONNECTING') {
            derived = 'CONNECTING';
        } else {
            derived = ts as ConnectionStatus;
        }

        if (this._status === derived) return;
        this._status = derived;

        if (derived === 'READY') {
            this.flushQueue();
            this.emit('status', 'READY');
            this.emit('connected' as any);
        } else {
            this.emit('status', derived);
            if (derived === 'DISCONNECTED') {
                this.emit('disconnected' as any);
            }
        }
    }

    private flushQueue() {
        if (this.transport.getStatus() !== 'CONNECTED') return;
        const pending = this.engine.getPendingOps();
        if (pending.length > 0) {
            this.logger.debug(`Flushing ${pending.length} pending ops (NOT clearing until ACK).`);
            pending.forEach(op => this.transport.broadcast(op));
            // NOTE: We no longer shift the queue here. Ops remain in the queue
            // until they are confirmed by the server (via handleRemoteOp which
            // removes matching confirmed ops from optimisticState).
            // The queue is cleared in handleInitSnapshot when pending ops are
            // found to already be incorporated in the server's authoritative state.
        }
    }


    private connectPromise: Promise<void> | null = null;

    public connect(): Promise<void> {
        if (this.isDestroyed) return Promise.reject(new ConnectionError('Client is destroyed'));

        if (!this.connectPromise) {
            this.connectPromise = (async () => {
                try {
                    await this.engine.boot();

                    // Start engine ready listener (internal)
                    this.engine.once('ready', () => this.updateStatus());

                    const heads = this.engine.getHeads();
                    await this.transport.connect(heads);

                } catch (err: any) {
                    this.connectPromise = null;
                    throw new ConnectionError(err.message || 'Connection failed');
                }
            })();

            this.connectPromise.catch(() => { /* Silenced - caller handles via await */ });
        }

        return this.connectPromise;
    }

    public disconnect(): void {
        this.connectPromise = null;
        this.transport.disconnect();
        this.engine.stop();
        this.updateStatus('DISCONNECTED');
    }


    public destroy(): void {
        this.isDestroyed = true;
        this.transport.disconnect();
        this.engine.destroy(); // Permanently destroy the engine
    }

    public async awaitReady(): Promise<void> {
        if (this.getStatus() === 'READY') return;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error('Timeout waiting for READY (Hydration)'));
            }, this.config.connectionTimeout || 10000);

            const statusHandler = (s: ConnectionStatus) => {
                if (s === 'READY') {
                    cleanup();
                    resolve();
                } else if (s === 'ERROR') {
                    cleanup();
                    reject(new Error('Connection error status received'));
                }
            };

            const errorHandler = (err: any) => {
                cleanup();
                reject(err instanceof Error ? err : new Error(String(err)));
            };

            const cleanup = () => {
                clearTimeout(timeout);
                this.off('status', statusHandler as any);
                this.off('error', errorHandler);
            };

            this.on('status', statusHandler as any);
            this.on('error', errorHandler);
        });
    }

    public set(key: string, value: any, schema?: Schema<any>): void {
        this.logger.debug(`${this.userId} set(${key}):`, value);
        const delta = this.engine.set(key, value, schema);

        if (this.transport.getStatus() === 'CONNECTED') {
            this.transport.broadcast(delta);
        } else {
            this.logger.debug(`[NMeshedClient] set() queued (transport: ${this.transport.getStatus()})`);
        }
    }

    /**
     * Typed deletion API.
     * 
     * Zen Pattern: "Absolute Clarity" — Type-safe deletion without `as any` escapes.
     */
    public delete(key: string): void {
        this.set(key, null);
    }

    public get<T = unknown>(key: string): T {
        console.log(`[NMeshedClient] get(${key}) calling engine...`);
        this.engine.authority.trackKey(key);
        return this.engine.get(key) as T;
    }

    public getState(): Record<string, any> {
        return this.engine.getAllValues();
    }

    public getAllValues(): Record<string, any> {
        return this.getState();
    }

    public getId(): string {
        return this.userId;
    }

    public getQueueSize(): number {
        return this.engine.getQueueSize();
    }

    public getMetrics() {
        if ((this.transport as any).getMetrics) {
            return (this.transport as any).getMetrics();
        }
        return null;
    }

    /**
     * Sends an ephemeral message to all connected peers, or a specific peer if `to` is provided.
     * This is useful for transient events like cursors, typing indicators, or game state updates
     * that do not need to be persisted.
     * 
     * Zen DX: Automatically encodes JSON objects to binary if needed.
     */
    public sendMessage(payload: Uint8Array | Record<string, any> | string | number | boolean, to?: string): void {
        if (this.getStatus() !== 'READY' && this.getStatus() !== 'CONNECTED') {
            console.warn('sendMessage called while disconnected');
        }

        let data: Uint8Array;
        if (payload instanceof Uint8Array) {
            data = payload;
        } else if (payload instanceof ArrayBuffer) {
            data = new Uint8Array(payload);
        } else {
            // "Simple" usage support: JSON -> Binary
            try {
                const str = JSON.stringify(payload);
                data = new TextEncoder().encode(str);
            } catch (e) {
                console.warn('[NMeshedClient] Failed to stringify message payload, sending empty.', e);
                data = new Uint8Array(0);
            }
        }

        this.transport.sendEphemeral(data, to);
    }

    /**
     * Get a synced collection. Pattern: "Absolute Clarity".
     * 
     * Schema is inferred from the client configuration (Zen Mode).
     */
    /**
     * Get a synced collection. Pattern: "Absolute Clarity".
     * 
     * Schema is inferred from the client configuration (Zen Mode), 
     * or passed via options.
     */
    public getCollection<T = any>(prefix: string, options?: SyncedCollectionOptions<T>): SyncedCollection<T> {
        const normalizedPrefix = prefix.endsWith(':') ? prefix : (prefix === '' ? '' : `${prefix}:`);

        // If options are provided, we bypass the standard cache key to avoid collision of filters/schemas
        if (options) {
            return new SyncedCollection<T>(this.engine, normalizedPrefix, undefined, options);
        }

        if (!this._collections.has(normalizedPrefix)) {
            const collection = new SyncedCollection<T>(this.engine, normalizedPrefix);
            this._collections.set(normalizedPrefix, collection);
        }
        return this._collections.get(normalizedPrefix)!;
    }

    /**
     * Alias for getCollection().
     */
    public collection<T = any>(prefix: string, options?: SyncedCollectionOptions<T>): SyncedCollection<T> {
        return this.getCollection(prefix, options);
    }


    /**
     * Convenience Getter: All business entities (excludes system/internal keys).
     * 
     * Zen Pattern: "The Zen Garden" — Easy access to what matters.
     */
    public get entities(): SyncedCollection<any> {
        return this.collection('', { filter: Filters.onlyEntities });
    }

    /**
     * Convenience Getter: System state (keys containing `__`).
     */
    public get system(): SyncedCollection<any> {
        return this.collection('', {
            filter: (k) => k.includes('__')
        });
    }

    /**
     * Convenience Getter: Ephemeral state (keys prefixed with `_` but not system `__`).
     */
    public get ephemera(): SyncedCollection<any> {
        return this.collection('', {
            filter: (k) => k.startsWith('_') && !k.includes('__')
        });
    }

    /**
     * Convenience Getter: Internal state (all keys starting with `_`).
     */
    public get internal(): SyncedCollection<any> {
        return this.collection('', {
            filter: (k) => k.startsWith('_')
        });
    }

    /**
     * Convenience Method: Typed entities with schema.
     * Equivalent to: client.collection('', { schema, filter: Filters.onlyEntities })
     */
    public entitiesOf<T extends Schema<any>>(schema: T): SyncedCollection<InferSchema<T>> {
        return this.collection<InferSchema<T>>('', { schema: schema as any, filter: Filters.onlyEntities });
    }

    public getSyncedMap(prefix: string): any {
        return this.getCollection(prefix);
    }


    public subscribe(handler: (msg: NMeshedMessage) => void) {
        if (typeof handler !== 'function') throw new Error('Handler must be a function');
        return this.on('message', handler);
    }

    /** Compatibility Aliases */
    public onStatusChange(handler: (status: ConnectionStatus) => void) {
        if (typeof handler !== 'function') throw new Error('Status handler must be a function');
        try {
            handler(this.getStatus());
        } catch (e) { }
        return super.on('status', handler as any);
    }
    public onMessage(handler: (msg: NMeshedMessage) => void) {
        if (typeof handler !== 'function') throw new Error('Message handler must be a function');
        return super.on('message', handler);
    }
    public onPeerJoin(handler: (peerId: string) => void) { return super.on('peerJoin', handler); }
    public onPeerLeave(handler: (peerId: string) => void) { return super.on('peerDisconnect', handler); }
    public onPeerDisconnect(handler: (peerId: string) => void) { return super.on('peerDisconnect', handler); }

    public onPresence(handler: (p: any) => void) {
        if (typeof handler !== 'function') throw new Error('Presence handler must be a function');
        return super.on('presence', handler);
    }
    public onEphemeral(handler: (p: any, from?: string) => void) {
        if (typeof handler !== 'function') throw new Error('Ephemeral handler must be a function');
        return super.on('ephemeral', handler);
    }

    /**
     * Zen Pattern: Latching Signal for Readiness.
     * 
     * If a handler is provided: Executes immediately if ready, or subscribes to the next 'ready' event.
     * If no handler is provided: Returns a Promise that resolves when the client is ready.
     * 
     * @example
     * await client.onReady();
     * // Or
     * client.onReady((state) => console.log('Ready!', state));
     */
    public onReady(handler?: (state: Record<string, any>) => void): any {
        if (handler !== undefined && typeof handler !== 'function') {
            throw new Error('Handler must be a function');
        }

        if (!handler) {
            return new Promise((resolve) => {
                if (this._latestState) {
                    resolve(this._latestState);
                } else {
                    this.once('ready' as any, (state) => resolve(state));
                }
            });
        }

        // Latching behavior for callbacks
        if (this._latestState) {
            try {
                handler(this._latestState);
            } catch (e) {
                this.logger.error('[NMeshedClient] Error in onReady immediate callback:', e);
            }
        }

        const wrapper = (state: Record<string, any>) => {
            handler(state);
        };

        return this.on('ready' as any, wrapper);
    }




    public onQueueChange(handler: (size: number) => void) {
        const h = () => {
            try {
                handler(this.getQueueSize());
            } catch (e) {
                console.error('[EventEmitter] Error in listener for queueChange:', e);
            }
        };
        h();
        return this.engine.on('queueChange', h);
    }

    public onKeyChange(pattern: string, handler: (key: string, value: any, options: { isOptimistic: boolean }) => void) {
        return this.engine.on('op', (key, value, isOptimistic) => {
            const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
            if (regex.test(key)) {
                try {
                    handler(key, value, { isOptimistic });
                } catch (e) {
                    console.error('[SyncEngine] Error in key change listener:', e);
                }
            }
        });
    }

    public override on<K extends keyof NMeshedEvents | string>(event: K, handler: (...args: any[]) => void): () => void {
        const h = handler as any;
        if (event === 'peerJoin') return this.onPeerJoin(h);
        if (event === 'peerDisconnect') return this.onPeerDisconnect(h);
        return super.on(event as any, h);
    }

    /**
     * Get the current binary snapshot from the core engine.
     * Useful for manual backups or server-side initialization simulation.
     */
    public getBinarySnapshot(): Uint8Array | null {
        return this.engine.getBinarySnapshot();
    }

    public async getPresence(): Promise<any[]> {
        const relayUrl = this.config.relayUrl || this.config.serverUrl || 'wss://relay.nmeshed.io';
        const httpUrl = relayUrl.replace(/^ws/, 'http') + '/v1/presence';
        const res = await fetch(httpUrl, {});
        if (!res.ok) throw new Error(`Failed to fetch presence: ${res.statusText}`);
        return res.json();
    }

    public simulateNetwork(options: { latency?: number, packetLoss?: number, jitter?: number } | null) {
        if (!options) {
            this.transport.simulateLatency(0);
            this.transport.simulatePacketLoss(0);
            return;
        }
        if (options.latency !== undefined) this.transport.simulateLatency(options.latency);
        if (options.packetLoss !== undefined) this.transport.simulatePacketLoss(options.packetLoss / 100);
    }

    public setStatus(s: TransportStatus): void {
        this.updateStatus(s);
    }

    public getStatus(): ConnectionStatus {
        return this._status;
    }

    public get isLive(): boolean {
        return this.getStatus() === 'READY';
    }

    public async ping(peerId: string): Promise<number> {
        return this.transport.ping(peerId);
    }

    /**
     * Returns the list of currently connected peers from the SyncEngine.
     */
    public getPeers(): string[] {
        return this.engine.authority.getPeers();
    }

    /**
     * Returns the current estimated latency in milliseconds.
     */
    public getLatency(): number {
        return this.transport.getLatency();
    }
}
