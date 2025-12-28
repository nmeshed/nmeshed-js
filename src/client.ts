import { EventEmitter } from './utils/EventEmitter';
import { AuthProvider, StaticAuthProvider } from './auth/AuthProvider';
import { SyncEngine } from './core/SyncEngine';
import { SyncedCollection } from './sync/SyncedCollection';
import { Transport, TransportStatus } from './transport/Transport';
import { WebSocketTransport } from './transport/WebSocketTransport';

import { Schema } from './schema/SchemaBuilder';
import { NMeshedMessage } from './types';
import { ConfigurationError, ConnectionError } from './errors';

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
}

/**
 * Derives the relay URL based on environment and configuration.
 * Priority: explicit config > environment variable > localhost detection > production default
 * 
 * This eliminates the need for manual URL construction in demos.
 */
function deriveRelayUrl(workspaceId: string, config: NMeshedConfig): string {
    // 1. Explicit configuration takes priority
    if (config.relayUrl) return config.relayUrl;
    if (config.serverUrl) return config.serverUrl;

    // 2. Environment variable (Node.js)
    if (typeof process !== 'undefined' && process.env?.NMESHED_RELAY_URL) {
        return process.env.NMESHED_RELAY_URL;
    }

    // 3. Localhost detection (Browser dev mode)
    if (typeof window !== 'undefined' && window.location?.hostname === 'localhost') {
        return `ws://localhost:8080/v1/sync/${encodeURIComponent(workspaceId)}`;
    }

    // 4. Production default
    return 'wss://relay.nmeshed.io';
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
    status: [TransportStatus];
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
    private isDestroyed = false;

    /**
     * Creates a client instance pre-configured for local development.
     * 
     * - Auto-connects to localhost:8080 (or derived relay URL)
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

        // Zen: Relaxed auth for Dev Mode / Localhost
        // If we detect localhost or debug mode, we allow missing credentials by filling a dummy one
        const isLocalhost = typeof window !== 'undefined' && window.location?.hostname === 'localhost';
        if (!config.token && !config.apiKey && !config.auth) {
            if (config.debug || isLocalhost) {
                if (config.debug) console.log('[NMeshedClient] Dev Mode: using dummy "dev-token"');
                config.token = 'dev-token';
            } else {
                throw new ConfigurationError('Either auth, token, or apiKey must be provided');
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

        this.engine = new SyncEngine(config.workspaceId, this.userId, 'crdt', config.maxQueueSize || 1000, config.debug);
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
            maxReconnectAttempts: config.maxReconnectAttempts
        });

        this.setupBindings();
    }

    private setupBindings() {
        this.transport.on('message', (bytes) => this.engine.applyRawMessage(bytes));
        // Backward compatibility for legacy transports
        this.transport.on('sync' as any, (bytes: Uint8Array) => this.engine.applyRawMessage(bytes));
        this.engine.on('init', (rawPayload: any) => {
            let payload = rawPayload;
            if (rawPayload instanceof Uint8Array) {
                try {
                    const json = new TextDecoder().decode(rawPayload);
                    payload = JSON.parse(json);
                } catch (e) {
                    // Not JSON? Might be pure binary init in future.
                    // For now, if it fails, we can't extract meshId/peers.
                    return;
                }
            }

            // Update Mesh ID if provided
            if (payload.meshId) {
                this.engine.authority.meshId = payload.meshId;
            }
            // Update Peers if provided
            if (payload.peers && Array.isArray(payload.peers)) {
                for (const peer of payload.peers) {
                    if (peer.userId) this.engine.authority.addPeer(peer.userId);
                }
            }
        });
        this.transport.on('status', (s) => {
            if (s === 'CONNECTED') {
                this.flushQueue();
            }
            this.emit('status', s === 'CONNECTED' ? 'READY' : s);
        });
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

    private flushQueue() {
        if (this.transport.getStatus() !== 'CONNECTED') return;
        const pending = this.engine.getPendingOps();
        if (pending.length > 0) {
            console.log(`[NMeshedClient] Flushing ${pending.length} pending ops (NOT clearing until ACK).`);
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
                    const heads = this.engine.getHeads();
                    await this.transport.connect(heads);
                } catch (err: any) {
                    this.connectPromise = null;
                    throw new ConnectionError(err.message || 'Connection failed');
                }
            })();
        }

        return this.connectPromise;
    }

    public disconnect(): void {
        this.connectPromise = null;
        // The following lines (this.status, this.notifyStatusListeners, this.reconnectTimeout)
        // are not present in the original document's class definition.
        // To maintain faithfulness and avoid introducing undeclared properties,
        // they are commented out or omitted.
        // this.status = 'DISCONNECTING';
        // this.notifyStatusListeners('DISCONNECTING');

        // if (this.reconnectTimeout) {
        //     clearTimeout(this.reconnectTimeout);
        //     this.reconnectTimeout = null;
        // }

        this.transport.disconnect();
        this.engine.stop();
        // this.status = 'IDLE';
        // this.notifyStatusListeners('IDLE');
    }

    public destroy(): void {
        this.isDestroyed = true;
        this.transport.disconnect();
        this.engine.destroy(); // Permanently destroy the engine
    }

    public async awaitReady(): Promise<void> {
        if (this.getStatus() === 'READY') return;
        return new Promise((resolve, reject) => {
            const statusHandler = (s: TransportStatus) => {
                if (s === 'READY') {
                    this.off('status', statusHandler);
                    this.off('error', errorHandler);
                    resolve();
                }
            };
            const errorHandler = (e: any) => {
                this.off('status', statusHandler);
                this.off('error', errorHandler);
                reject(e);
            };
            this.on('status', statusHandler);
            this.on('error', errorHandler);
        });
    }

    public set(key: string, value: any, schema?: Schema<any>): void {
        if (this.config.debug) {
            console.log(`[NMeshedClient] ${this.userId} set(${key}):`, value);
        }
        this.engine.set(key, value, schema);
        this.flushQueue();
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

    public getCollection<T = any>(prefix: string, schema?: Schema<any>): SyncedCollection<T> {
        return new SyncedCollection<T>(this.engine, prefix, schema);
    }

    public getSyncedMap(prefix: string): any {
        if (!(this as any)._maps) (this as any)._maps = new Map();
        if (!(this as any)._maps.has(prefix)) {
            (this as any)._maps.set(prefix, this.getCollection(prefix));
        }
        return (this as any)._maps.get(prefix);
    }

    public subscribe(handler: (msg: NMeshedMessage) => void) {
        if (typeof handler !== 'function') throw new Error('Handler must be a function');
        return this.on('message', handler);
    }

    /** Compatibility Aliases */
    public onStatusChange(handler: (status: TransportStatus) => void) {
        if (typeof handler !== 'function') throw new Error('Status handler must be a function');
        try {
            handler(this.getStatus());
        } catch (e) { }
        return super.on('status', handler);
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
        this.emit('status', s);
    }

    public getStatus(): TransportStatus {
        const s = this.transport.getStatus();
        if (s === 'IDLE') return 'IDLE';
        if (s === 'CONNECTING') return 'CONNECTING';
        if (s === 'DISCONNECTED') return 'DISCONNECTED';
        if (s === 'RECONNECTING') return 'RECONNECTING';
        if (s === 'ERROR') return 'ERROR';
        return s === 'CONNECTED' ? 'READY' : s;
    }

    public get isLive(): boolean {
        const s = this.getStatus();
        return s === 'READY';
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
