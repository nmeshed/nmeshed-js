import { EventEmitter } from './utils/EventEmitter';
import { SyncEngine } from './core/SyncEngine';
import { SyncedCollection } from './sync/SyncedCollection';
import { Transport, TransportStatus } from './transport/Transport';
import { WebSocketTransport } from './transport/WebSocketTransport';
import { P2PTransport } from './transport/P2PTransport';
import { Schema } from './schema/SchemaBuilder';
import { NMeshedMessage } from './types';
import { ConfigurationError, ConnectionError } from './errors';

export interface NMeshedConfig {
    workspaceId: string;
    userId?: string;
    token?: string;
    apiKey?: string;
    transport?: 'server' | 'p2p' | 'hybrid' | Transport;
    relayUrl?: string; // Standard
    serverUrl?: string; // Legacy alias
    iceServers?: RTCIceServer[];
    debug?: boolean;
    heartbeatInterval?: number;
    heartbeatMaxMissed?: number;
    maxQueueSize?: number;
    connectionTimeout?: number;
    autoReconnect?: boolean;
    maxReconnectAttempts?: number;
    aggressiveRelay?: boolean;
}

/**
 * NMeshedClient: The Zen Gateway to Real-Time Sync.
 * 
 * Embodies "Absolute Clarity" by providing a single, unified entry point 
 * for all synchronization tasks. It abstracts away the complexity of 
 * transport negotiation (Server/P2P), binary encoding (Flatbuffers), 
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

    constructor(config: NMeshedConfig) {
        super();

        if (!config.workspaceId) throw new ConfigurationError('workspaceId is required');
        if (!config.token && !config.apiKey) throw new ConfigurationError('Either token or apiKey must be provided');
        if (config.maxQueueSize !== undefined && config.maxQueueSize < 0) throw new ConfigurationError('maxQueueSize must be >= 0');
        if (config.maxReconnectAttempts !== undefined && config.maxReconnectAttempts < 0) throw new ConfigurationError('maxReconnectAttempts must be >= 0');

        const validTransports = ['server', 'p2p', 'hybrid'];
        if (config.transport && typeof config.transport === 'string' && !validTransports.includes(config.transport)) {
            throw new ConfigurationError(`Invalid transport: ${config.transport}`);
        }

        this.config = { ...config };
        if (!this.config.transport) this.config.transport = 'server';

        this.workspaceId = config.workspaceId;
        this.userId = config.userId || `u-${Math.random().toString(36).substring(2, 9)}`;

        this.engine = new SyncEngine(config.workspaceId, this.userId, 'crdt', config.maxQueueSize || 1000, config.debug);
        this.bootPromise = this.engine.boot();

        const relayUrl = config.relayUrl || config.serverUrl || 'wss://relay.nmeshed.io';

        if (typeof config.transport === 'object') {
            this.transport = config.transport;
        } else if (config.transport === 'p2p') {
            this.transport = new P2PTransport({
                workspaceId: config.workspaceId,
                userId: this.userId,
                serverUrl: relayUrl,
                iceServers: config.iceServers,
                token: config.token || config.apiKey || '',
                debug: config.debug,
                aggressiveRelay: config.aggressiveRelay
            });
        } else {
            this.transport = new WebSocketTransport(relayUrl, {
                workspaceId: config.workspaceId,
                peerId: this.userId,
                token: config.token || config.apiKey || '',
                debug: config.debug,
                heartbeatInterval: config.heartbeatInterval,
                heartbeatMaxMissed: config.heartbeatMaxMissed,
                connectionTimeout: config.connectionTimeout,
                autoReconnect: config.autoReconnect,
                maxReconnectAttempts: config.maxReconnectAttempts
            });
        }

        this.setupBindings();
    }

    private setupBindings() {
        this.transport.on('message', (bytes) => this.engine.applyRawMessage(bytes));
        // Backward compatibility for legacy transports
        this.transport.on('sync' as any, (bytes: Uint8Array) => this.engine.applyRawMessage(bytes));
        this.engine.on('init', (payload: any) => {
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
                this.broadcast({ type: '__pong__', to: p.from, requestId: p.requestId });
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


    public async connect(): Promise<void> {
        if (this.isDestroyed) throw new ConnectionError('Client is destroyed');
        // Ensure engine is booted (re-boot if it was destroyed/disconnected)
        await this.engine.boot();
        const heads = this.engine.getHeads();
        return this.transport.connect(heads).catch(err => {
            throw new ConnectionError(err.message || 'Connection failed');
        });
    }

    public disconnect(): void {
        this.transport.disconnect();
        this.engine.stop(); // Use stop() to allow reconnection
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

    public broadcast(payload: any): void {
        if (this.getStatus() !== 'READY' && this.getStatus() !== 'CONNECTED') {
            console.warn('broadcast called while disconnected');
        }
        this.transport.sendEphemeral(payload);
    }

    public sendToPeer(peerId: string, payload: any): void {
        this.transport.sendEphemeral(payload, peerId);
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
}
