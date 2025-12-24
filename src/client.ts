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
    PresenceHandler,
    PresenceUser,
    NMeshedMessage,
    Unsubscribe
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

    private _state = new Map<string, unknown>();

    private _status: ConnectionStatus = 'IDLE';

    private listeners = {
        status: new Set<StatusHandler>(),
        message: new Set<MessageHandler>(),
        ephemeral: new Set<EphemeralHandler>(),
        presence: new Set<PresenceHandler>(),
        peerJoin: new Set<(peerId: string) => void>(),
        peerDisconnect: new Set<(peerId: string) => void>(),
        queueChange: new Set<(size: number) => void>()
    };

    private syncedMaps = new Map<string, SyncedMap<unknown>>();
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

        this.engine.on('op', (key: string, value: unknown) => {
            this._state.set(key, value);
            this.notifyMessageListeners({
                type: 'op',
                payload: { key, value, timestamp: Date.now() }
            });
        });

        this.engine.on('queueChange', (size: number) => {
            this.listeners.queueChange.forEach(l => {
                try {
                    l(size);
                } catch (e) {
                    this.warn('Queue listener error', e);
                }
            });
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

        // Notify initial status
        this.notifyStatusListeners(this._status);
    }

    private setupTransportListeners(): void {
        const statusMap: Record<TransportStatus, ConnectionStatus> = {
            'CONNECTING': 'CONNECTING',
            'CONNECTED': 'CONNECTED',
            'RECONNECTING': 'RECONNECTING',
            'ERROR': 'ERROR',
            'DISCONNECTED': 'DISCONNECTED',
            'IDLE': 'IDLE'
        };

        this.transport.on('status', (s: TransportStatus) => {
            this.setStatus(statusMap[s] || 'IDLE');
        });

        this.transport.on('message', (data: Uint8Array) => {
            if (this.config.debug) {
                this.log(`Received message: ${data.byteLength} bytes`);
            }
            this.engine.applyRemoteDelta(data);
        });

        this.transport.on('ephemeral', (payload: unknown, from?: string) => {
            const isNMeshedMsg = (p: unknown): p is NMeshedMessage =>
                p !== null && typeof p === 'object' && 'type' in p && ['op', 'ephemeral', 'presence'].includes((p as any).type);

            const effectiveMsg: NMeshedMessage = isNMeshedMsg(payload)
                ? payload
                : { type: 'ephemeral', payload, from };

            this.notifyMessageListeners(effectiveMsg);

            this.listeners.ephemeral.forEach(l => {
                try {
                    if (from !== undefined) {
                        l(payload, from);
                    } else {
                        l(payload);
                    }
                } catch (e) {
                    this.warn('Ephemeral listener error', e);
                }
            });
        });

        this.transport.on('presence', (payload: unknown) => {
            const isPresencePayload = (p: unknown): p is PresenceUser =>
                p !== null && typeof p === 'object' && 'userId' in p && 'status' in p;

            if (isPresencePayload(payload)) {
                this.listeners.presence.forEach(l => {
                    try { l(payload); } catch (e) { this.warn('Presence listener error', e); }
                });
            } else {
                this.warn('Received invalid presence payload:', payload);
            }
        });

        this.transport.on('peerJoin', (id: string) => {
            this.listeners.peerJoin.forEach(l => l(id));
        });

        this.transport.on('peerDisconnect', (id: string) => {
            this.listeners.peerDisconnect.forEach(l => l(id));
        });

        this.transport.on('error', (err: Error) => {
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

        if (this.config.debug) {
            this.log(`connect() called. Current status: ${this._status}`);
        }

        if (this._status === 'CONNECTED' || this._status === 'CONNECTING') return;

        this.setStatus('CONNECTING');

        try {
            await this.bootPromise;
            await this.transport.connect();
        } catch (err) {
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
        this.destroy();
    }

    public set(key: string, value: unknown): void {
        if (this.isDestroyed) return;
        try {
            const delta = this.engine.set(key, value);
            if (delta.length > 0) {
                if (this._status === 'CONNECTED') {
                    this.transport.send(delta);
                } else {
                    this.warn(`set() called while ${this._status}; operation queued`);
                }
            }
        } catch (e) {
            // Handle circular JSON gracefully if requested by test or common sense
            if (e instanceof Error && e.message.includes('circular')) {
                this.warn(`Failed to set key "${key}" due to circular structure:`, e);
                return;
            }
            throw new Error(`Failed to set key "${key}": ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    public get<T = unknown>(key: string): T | undefined {
        return this._state.get(key) as T;
    }

    public sendOperation(key: string, value: unknown): void {
        this.set(key, value);
    }

    public getState(): Record<string, unknown> {
        return Object.fromEntries(this._state);
    }

    public broadcast(data: unknown): void {
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

    public sendToPeer(peerId: string, payload: unknown): void {
        if (this.isDestroyed) return;
        this.transport.sendEphemeral(payload, peerId);
    }

    public getPeers(): string[] {
        return this.transport.getPeers();
    }

    public async ping(peerId: string): Promise<number> {
        return this.transport.ping(peerId);
    }

    public onStatusChange(handler: StatusHandler): Unsubscribe {
        if (typeof handler !== 'function') {
            throw new Error('Status handler must be a function');
        }
        this.listeners.status.add(handler);
        // Initial notification
        try {
            handler(this._status);
        } catch (e) {
            this.warn('Status handler error on subscribe', e);
        }
        return () => this.listeners.status.delete(handler);
    }

    public onMessage(handler: MessageHandler): Unsubscribe {
        if (typeof handler !== 'function') {
            throw new Error('Message handler must be a function');
        }
        this.listeners.message.add(handler);
        return () => this.listeners.message.delete(handler);
    }

    public onEphemeral(handler: EphemeralHandler): Unsubscribe {
        if (typeof handler !== 'function') {
            throw new Error('Ephemeral handler must be a function');
        }
        this.listeners.ephemeral.add(handler);
        return () => this.listeners.ephemeral.delete(handler);
    }

    public onBroadcast(handler: EphemeralHandler): Unsubscribe {
        if (typeof handler !== 'function') {
            throw new Error('Broadcast handler must be a function');
        }
        this.listeners.ephemeral.add(handler);
        return () => this.listeners.ephemeral.delete(handler);
    }

    public onPresence(handler: PresenceHandler): Unsubscribe {
        if (typeof handler !== 'function') {
            throw new Error('Presence handler must be a function');
        }
        this.listeners.presence.add(handler);
        return () => this.listeners.presence.delete(handler);
    }

    public onPeerJoin(handler: (userId: string) => void): Unsubscribe {
        if (typeof handler !== 'function') {
            throw new Error('PeerJoin handler must be a function');
        }
        this.listeners.peerJoin.add(handler);
        return () => this.listeners.peerJoin.delete(handler);
    }

    public onPeerDisconnect(handler: (userId: string) => void): Unsubscribe {
        if (typeof handler !== 'function') {
            throw new Error('PeerDisconnect handler must be a function');
        }
        this.listeners.peerDisconnect.add(handler);
        return () => this.listeners.peerDisconnect.delete(handler);
    }

    public onQueueChange(handler: (size: number) => void): Unsubscribe {
        if (typeof handler !== 'function') {
            throw new Error('QueueChange handler must be a function');
        }
        this.listeners.queueChange.add(handler);
        try {
            handler(this.getQueueSize());
        } catch (e) {
            this.warn('QueueChange handler error on subscribe', e);
        }
        return () => this.listeners.queueChange.delete(handler);
    }

    public getQueueSize(): number {
        return this.engine.getQueueSize();
    }

    public on(event: string, handler: (...args: any[]) => void): Unsubscribe {
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

    public getSyncedMap<T = unknown>(name: string, config?: SyncedMapConfig<T>): SyncedMap<T> {
        if (this.syncedMaps.has(name)) {
            return this.syncedMaps.get(name) as SyncedMap<T>;
        }
        const map = new SyncedMap<T>(this, name, config);
        this.syncedMaps.set(name, map as SyncedMap<unknown>);
        return map;
    }

    /**
     * Fetches current presence data for the workspace.
     * Implements defensive fetch with timeout and strict error handling.
     */
    public async getPresence<T = any>(): Promise<T[]> {
        const base = this.config.serverUrl?.replace(/\/+$/, '').replace(/^ws/, 'http') || 'https://api.nmeshed.com';
        const url = `${base}/v1/presence/${encodeURIComponent(this.config.workspaceId)}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        try {
            const res = await fetch(url, {
                headers: { 'Authorization': `Bearer ${this.config.token || this.config.apiKey}` },
                signal: controller.signal
            });

            if (!res.ok) {
                throw new Error(`Failed to fetch presence: ${res.statusText || res.status}`);
            }
            return await res.json();
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            this.warn('Failed to fetch presence:', error.message);
            throw error;
        } finally {
            clearTimeout(timeoutId);
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
        if (this.isDestroyed) return;
        this.disconnect();
        this.engine.destroy();
        this.syncedMaps.clear();
        this._state.clear();

        // Clear all listeners
        Object.values(this.listeners).forEach(set => set.clear());

        this.isDestroyed = true;
    }

    private setStatus(newStatus: ConnectionStatus): void {
        if (this._status !== newStatus) {
            if (this.config.debug) {
                this.log(`Status: ${this._status} -> ${newStatus}`);
            }
            this._status = newStatus;
            this.notifyStatusListeners(newStatus);
            if (newStatus === 'CONNECTED') this.flushQueue();
        }
    }

    private notifyStatusListeners(status: ConnectionStatus): void {
        this.listeners.status.forEach(l => {
            try { l(status); } catch (e) { this.warn('Status listener error', e); }
        });
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

    private notifyMessageListeners(msg: NMeshedMessage): void {
        this.listeners.message.forEach(l => {
            try { l(msg); } catch (e) { this.warn('Message listener error', e); }
        });
    }

    private generateUserId(): string {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        return `user-${Math.random().toString(36).substring(2, 11)}`;
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

    private log(msg: string, ...args: unknown[]): void {
        console.log(`[nMeshed] ${msg}`, ...args);
    }

    private warn(msg: string, ...args: unknown[]): void {
        console.warn(`[nMeshed] ${msg}`, ...args);
    }

    public get operationQueue(): Uint8Array[] {
        return this.engine.getPendingOps();
    }
}
