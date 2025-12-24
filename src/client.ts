import { SyncEngine } from './core/SyncEngine';
import { Transport, TransportStatus } from './transport/Transport';
import { WebSocketTransport } from './transport/WebSocketTransport';
import { P2PTransport } from './transport/P2PTransport';
import { SyncedMap, SyncedMapConfig } from './sync/SyncedMap';
import {
    NMeshedConfig,
    ResolvedConfig,
    ConfigSchema,
    DEFAULT_CONFIG,
    ChaosOptions,
    ConnectionStatus,
    StatusHandler,
    MessageHandler,
    EphemeralHandler,
    PresenceHandler
} from './types';
import { ConnectionError, ConfigurationError } from './errors';

/**
 * NMeshedClient is the main entry point for the nMeshed SDK.
 * It provides a high-level API for real-time synchronization and messaging.
 */
export class NMeshedClient {
    public readonly config: ResolvedConfig;
    private engine: SyncEngine;
    private transport: Transport;

    private _state = new Map<string, any>();

    private _status: ConnectionStatus = 'IDLE';
    private statusListeners = new Set<StatusHandler>();
    private messageListeners = new Set<MessageHandler>();
    private ephemeralListeners = new Set<EphemeralHandler>();
    private presenceListeners = new Set<PresenceHandler>();
    private peerJoinListeners = new Set<(peerId: string) => void>();
    private peerDisconnectListeners = new Set<(peerId: string) => void>();
    private queueListeners = new Set<(size: number) => void>();

    private syncedMaps = new Map<string, SyncedMap<any>>();
    private isDestroyed = false;
    private bootPromise: Promise<void>;

    constructor(config: NMeshedConfig) {
        const result = ConfigSchema.safeParse(config);
        if (!result.success) {
            throw new ConfigurationError(`nMeshed: ${result.error.issues.map(e => e.message).join(', ')}`);
        }

        const validConfig = result.data;
        this.config = {
            ...DEFAULT_CONFIG,
            ...validConfig,
            userId: validConfig.userId || this.generateUserId(),
            syncMode: validConfig.syncMode || 'crdt',
        } as ResolvedConfig;

        this.engine = new SyncEngine(
            this.config.workspaceId,
            this.config.syncMode,
            this.config.maxQueueSize
        );
        this.engine.on('op', (key, value) => {
            this._state.set(key, value);
            this.notifyMessageListeners({ type: 'op', payload: { key, value, timestamp: Date.now() } });
        });
        this.engine.on('queueChange', (size) => {
            this.queueListeners.forEach(l => l(size));
        });

        this.bootPromise = this.engine.boot();

        this.transport = this.config.transport === 'server'
            ? new WebSocketTransport({
                url: this.buildUrl(),
                autoReconnect: this.config.autoReconnect,
                maxReconnectAttempts: this.config.maxReconnectAttempts,
                reconnectBaseDelay: this.config.reconnectBaseDelay,
                maxReconnectDelay: this.config.maxReconnectDelay,
                connectionTimeout: this.config.connectionTimeout,
                heartbeatInterval: this.config.heartbeatInterval,
                heartbeatMaxMissed: this.config.heartbeatMaxMissed,
                debug: this.config.debug
            })
            : new P2PTransport(this.config);

        this.setupTransportListeners();

        // Compatibility warning: initial status notification
        try {
            this.statusListeners.forEach(l => l(this._status));
        } catch (e) {
            this.warn('Initial status notification failed', e);
        }
    }

    private setupTransportListeners(): void {
        this.transport.on('status', (s: TransportStatus) => {
            let next: ConnectionStatus = 'IDLE';
            if (s === 'CONNECTING') next = 'CONNECTING';
            else if (s === 'CONNECTED') next = 'CONNECTED';
            else if (s === 'RECONNECTING') next = 'RECONNECTING';
            else if (s === 'ERROR') next = 'ERROR';
            else next = 'DISCONNECTED';
            this.setStatus(next);
        });

        this.transport.on('message', (data) => {
            console.error(`[NMeshedClient DEBUG] Received message: ${data.byteLength} bytes`);
            this.engine.applyRemoteDelta(data);
        });

        this.transport.on('ephemeral', (payload, from) => {
            const isSystemType = payload && (payload.type === 'op' || payload.type === 'ephemeral' || payload.type === 'presence');
            const effectiveMsg = isSystemType ? payload : { type: 'ephemeral', payload, from };
            this.notifyMessageListeners(effectiveMsg);

            this.ephemeralListeners.forEach(l => {
                try {
                    if (from !== undefined) l(payload, from);
                    else l(payload);
                } catch (e) { this.warn('Ephemeral listener error', e); }
            });
        });

        this.transport.on('presence', (user) => {
            this.presenceListeners.forEach(l => {
                try { l(user); } catch (e) { this.warn('Presence listener error', e); }
            });
        });

        this.transport.on('peerJoin', (id) => {
            this.peerJoinListeners.forEach(l => l(id));
        });

        this.transport.on('peerDisconnect', (id) => {
            this.peerDisconnectListeners.forEach(l => l(id));
        });

        this.transport.on('error', (err) => {
            this.warn('Transport encountered an error', err);
        });
    }

    public getStatus(): ConnectionStatus {
        return this._status;
    }

    public getId(): string {
        return this.config.userId;
    }

    public async connect(): Promise<void> {
        if (this.isDestroyed) throw new ConnectionError('Client destroyed');
        console.error(`[NMeshedClient] connect() called. Current status: ${this._status}`);
        if (this._status === 'CONNECTED' || this._status === 'CONNECTING') return;

        this.setStatus('CONNECTING');

        try {
            await this.bootPromise;
            await this.transport.connect();
        } catch (err) {
            console.error(`[NMeshedClient] connect() failed. Current status: ${this._status}`);
            // Only flip to RECONNECTING if we didn't already hit a terminal ERROR state
            if (this._status !== 'ERROR') {
                this.setStatus('RECONNECTING');
            }
            throw err;
        }
    }

    public disconnect(): void {
        this.transport.disconnect();
    }

    public close(): void {
        this.disconnect();
    }

    public set(key: string, value: any): void {
        if (this.isDestroyed) return;
        try {
            const delta = this.engine.set(key, value);
            if (this._status === 'CONNECTED' && delta.length > 0) {
                this.transport.send(delta);
            } else if (this._status !== 'CONNECTED' && delta.length > 0) {
                this.warn('set() called while not connected; operation queued');
            }
        } catch (e) {
            this.warn(`Failed to set key "${key}":`, e);
        }
    }

    public get<T = any>(key: string): T | undefined {
        return this._state.get(key) as T;
    }

    public sendOperation(key: string, value: any): void {
        this.set(key, value);
    }

    public getState(): Record<string, any> {
        return Object.fromEntries(this._state);
    }

    public broadcast(data: any): void {
        if (this.isDestroyed) return;
        if (this._status !== 'CONNECTED') {
            this.warn('broadcast() called while not connected');
            return;
        }

        if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
            this.transport.broadcast(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
        } else {
            this.transport.sendEphemeral(data);
        }
    }


    public sendToPeer(peerId: string, payload: any): void {
        if (this.isDestroyed) return;
        this.transport.sendEphemeral(payload, peerId);
    }

    public getPeers(): string[] {
        return this.transport.getPeers();
    }

    public async ping(peerId: string): Promise<number> {
        return this.transport.ping(peerId);
    }

    public onStatusChange(handler: StatusHandler): () => void {
        if (typeof handler !== 'function') throw new Error('Status handler must be a function');
        this.statusListeners.add(handler);
        try {
            handler(this._status);
        } catch (e) {
            this.warn('Status handler threw on subscription', e);
        }
        return () => this.statusListeners.delete(handler);
    }

    public onMessage(handler: MessageHandler): () => void {
        if (typeof handler !== 'function') throw new Error('Message handler must be a function');
        this.messageListeners.add(handler);
        return () => this.messageListeners.delete(handler);
    }

    public onEphemeral(handler: EphemeralHandler): () => void {
        if (typeof handler !== 'function') throw new Error('Ephemeral handler must be a function');
        this.ephemeralListeners.add(handler);
        return () => this.ephemeralListeners.delete(handler);
    }

    public onBroadcast(handler: EphemeralHandler): () => void {
        if (typeof handler !== 'function') throw new Error('Broadcast handler must be a function');
        return this.onEphemeral(handler);
    }

    public onPresence(handler: PresenceHandler): () => void {
        if (typeof handler !== 'function') throw new Error('Presence handler must be a function');
        this.presenceListeners.add(handler);
        return () => this.presenceListeners.delete(handler);
    }

    public onPeerJoin(handler: (peerId: string) => void): () => void {
        if (typeof handler !== 'function') throw new Error('handler is not a function');
        this.peerJoinListeners.add(handler);
        return () => this.peerJoinListeners.delete(handler);
    }

    public onPeerDisconnect(handler: (peerId: string) => void): () => void {
        if (typeof handler !== 'function') throw new Error('handler is not a function');
        this.peerDisconnectListeners.add(handler);
        return () => this.peerDisconnectListeners.delete(handler);
    }

    public onQueueChange(handler: (size: number) => void): () => void {
        if (typeof handler !== 'function') throw new Error('handler is not a function');
        this.queueListeners.add(handler);
        handler(this.engine.getQueueSize());
        return () => this.queueListeners.delete(handler);
    }

    public getQueueSize(): number {
        return this.engine.getQueueSize();
    }

    public on(event: string, handler: (...args: any[]) => void): () => void {
        switch (event) {
            case 'status': return this.onStatusChange(handler as StatusHandler);
            case 'message': return this.onMessage(handler as MessageHandler);
            case 'ephemeral': return this.onEphemeral(handler as EphemeralHandler);
            case 'broadcast': return this.onBroadcast(handler as EphemeralHandler);
            case 'peerJoin': return this.onPeerJoin(handler as (peerId: string) => void);
            case 'peerDisconnect': return this.onPeerDisconnect(handler as (peerId: string) => void);
            case 'queueChange': return this.onQueueChange(handler as (size: number) => void);
            default: return () => { };
        }
    }

    public getSyncedMap<T = any>(name: string, config?: SyncedMapConfig<T>): SyncedMap<T> {
        if (this.syncedMaps.has(name)) {
            return this.syncedMaps.get(name)!;
        }
        const map = new SyncedMap<T>(this, name, config);
        this.syncedMaps.set(name, map);
        return map;
    }

    public async getPresence(): Promise<Record<string, any>[]> {
        const base = this.config.serverUrl?.replace(/\/+$/, '').replace(/^ws/, 'http') || 'https://api.nmeshed.com';
        const url = `${base}/v1/presence/${encodeURIComponent(this.config.workspaceId)}`;
        try {
            const res = await fetch(url, { headers: { 'Authorization': `Bearer ${this.config.token || this.config.apiKey}` } });
            if (!res.ok) throw new Error(`Failed to fetch presence: ${res.statusText || res.status}`);
            return await res.json();
        } catch (e) {
            throw e instanceof Error ? e : new Error(`Failed to fetch presence: ${String(e)}`);
        }
    }

    public simulateNetwork(options: ChaosOptions | null): void {
        if (!options) {
            this.transport.simulateLatency(0);
            this.transport.simulatePacketLoss(0);
            return;
        }
        if (options.latency !== undefined) {
            this.transport.simulateLatency(options.latency);
        }
        if (options.packetLoss !== undefined) {
            this.transport.simulatePacketLoss(options.packetLoss);
        }
    }

    public destroy(): void {
        this.disconnect();
        this.engine.destroy();
        this.syncedMaps.clear();
        this._state.clear();
        this.isDestroyed = true;
    }

    private setStatus(newStatus: ConnectionStatus): void {
        if (this._status !== newStatus) {
            console.error(`[NMeshedClient] Status: ${this._status} -> ${newStatus}`);
            this._status = newStatus;
            this.statusListeners.forEach(l => {
                try { l(newStatus); } catch (e) { this.warn('Status listener error', e); }
            });
            if (newStatus === 'CONNECTED') this.flushQueue();
        }
    }

    private flushQueue(): void {
        try {
            const ops = this.engine.getPendingOps();
            ops.forEach(op => this.transport.send(op));
            this.engine.clearQueue();
        } catch (e) {
            this.warn('Failed to flush operation queue', e);
        }
    }

    private notifyMessageListeners(msg: any): void {
        this.messageListeners.forEach(l => {
            try { l(msg); } catch (e) { this.warn('Message listener error', e); }
        });
    }

    private generateUserId(): string {
        return 'user-' + Math.random().toString(36).substring(2, 11);
    }

    private buildUrl(): string {
        const baseUrl = this.config.serverUrl || 'wss://api.nmeshed.com';
        const params = new URLSearchParams({
            userId: this.config.userId,
            workspaceId: this.config.workspaceId,
            ...(this.config.token ? { token: this.config.token } : { api_key: this.config.apiKey || '' })
        });

        const url = new URL(baseUrl);
        url.search = params.toString();
        return url.toString();
    }

    private warn(msg: string, ...args: any[]): void {
        console.warn(`[nMeshed] ${msg}`, ...args);
    }

    public get operationQueue(): Uint8Array[] {
        return this.engine.getPendingOps();
    }
}
