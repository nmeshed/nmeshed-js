import { Logger } from './utils/Logger';
import { SyncEngine } from './core/SyncEngine';
import { Transport, TransportStatus } from './transport/Transport';
import { WebSocketTransport } from './transport/WebSocketTransport';
import { P2PTransport } from './transport/P2PTransport';
import * as flatbuffers from 'flatbuffers';
import { WirePacket } from './schema/nmeshed/wire-packet';
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
import type { Schema } from './schema/SchemaBuilder';

/**
 * NMeshedClient: The High-Level Entrance to the nMeshed SDK.
 * 
 * Provides a developer-friendly API for:
 * - Real-time state synchronization via SyncedMaps and CRDTs.
 * - Peer-to-peer or server-mediated messaging and presence.
 * - Transparent lifecycle management and automatic reconnection.
 * - Deterministic, schema-aware binary serialization.
 */
export class NMeshedClient {
    public readonly config: ResolvedConfig;
    public readonly engine: SyncEngine;
    private transport: Transport;
    private logger: Logger;

    private syncedMaps = new Map<string, SyncedMap<unknown>>();
    private isDestroyed = false;
    private bootPromise: Promise<void>;

    private _status: ConnectionStatus = 'IDLE';
    private _isInsideTransaction = false;
    private _transactionDeltas: Uint8Array[] = [];

    private listeners = {
        status: new Set<StatusHandler>(),
        message: new Set<MessageHandler>(),
        ephemeral: new Set<EphemeralHandler>(),
        presence: new Set<PresenceHandler>(),
        peerJoin: new Set<(peerId: string) => void>(),
        peerDisconnect: new Set<(peerId: string) => void>(),
        queueChange: new Set<(size: number) => void>()
    };

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
            debug: true // Force debug for development/tests regardless of config
        } as ResolvedConfig;

        this.engine = new SyncEngine(
            this.config.workspaceId,
            this.config.syncMode,
            this.config.maxQueueSize,
            this.config.debug
        );
        this.engine.on('op', (key: string, value: unknown, isOptimistic: boolean) => {
            this.notifyMessageListeners({
                type: 'op',
                payload: { key, value, timestamp: Date.now(), isOptimistic }
            });
        });

        this.engine.on('snapshot', () => {
            this.notifyMessageListeners({
                type: 'init',
                data: this.engine.getAllValues()
            });
        });

        this.engine.on('queueChange', (size: number) => {
            this.listeners.queueChange.forEach(l => {
                try {
                    l(size);
                } catch (e) {
                    this.logger.warn('Queue listener error', e);
                }
            });
        });

        this.bootPromise = this.engine.boot();
        this.logger = new Logger('NMeshedClient', this.config.debug);

        this.transport = this.config.transport === 'server'
            ? new WebSocketTransport({
                url: this.buildUrl(),
                autoReconnect: this.config.autoReconnect,
                maxReconnectAttempts: this.config.maxReconnectAttempts,
                reconnectBaseDelay: this.config.reconnectBaseDelay,
                maxReconnectDelay: this.config.maxReconnectDelay,
                connectionTimeout: this.config.connectionTimeout,
                heartbeatInterval: this.config.heartbeatInterval,
                heartbeatMaxMissed: this.config.heartbeatMaxMissed
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
            this.logger.debug(`Received message: ${data.byteLength} bytes`);
            this.engine.applyRemoteDelta(data);
        });

        this.transport.on('sync', (data: Uint8Array) => {
            this.logger.debug(`Received sync packet: ${data.byteLength} bytes`);

            // Re-wrap bytes in ByteBuffer for the engine
            const buf = new flatbuffers.ByteBuffer(data);
            try {
                const wire = WirePacket.getRootAsWirePacket(buf);
                const sync = wire.sync();
                if (sync) {
                    this.engine.handleBinarySync(sync);
                }
            } catch (err) {
                this.logger.error('Failed to parse sync packet', err);
            }
        });

        this.transport.on('init', (payload: any) => {
            this.logger.info('Received init (snapshot) from transport');
            this.engine.handleInitSnapshot(payload.data || payload);
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
                    this.logger.warn('Ephemeral listener error', e);
                }
            });
        });

        this.transport.on('presence', (payload: unknown) => {
            const isPresencePayload = (p: unknown): p is PresenceUser =>
                p !== null && typeof p === 'object' && 'userId' in p && 'status' in p;

            if (isPresencePayload(payload)) {
                this.listeners.presence.forEach(l => {
                    try { l(payload); } catch (e) { this.logger.warn('Presence listener error', e); }
                });
            } else {
                this.logger.warn('Received invalid presence payload:', payload);
            }
        });

        this.transport.on('peerJoin', (id: string) => {
            this.listeners.peerJoin.forEach(l => l(id));
        });

        this.transport.on('peerDisconnect', (id: string) => {
            this.listeners.peerDisconnect.forEach(l => l(id));
        });

        // Handle binary synchronization events
        this.transport.on('sync', (data: Uint8Array) => {
            this.engine.handleBinarySync(data);
        });

        this.transport.on('error', (err: Error) => {
            this.logger.warn('Transport encountered an error', err);
        });
    }

    /**
     * Gets the current lifecycle status of the client.
     */
    public getStatus(): ConnectionStatus {
        return this._status;
    }

    /**
     * Gets the unique user identifier for this client instance.
     */
    public getId(): string {
        return this.config.userId;
    }

    /**
     * Establishes a connection to the nMeshed network.
     * Initializes the SyncEngine and Transport layers.
     * 
     * @throws {ConnectionError} If the client is already destroyed or connection fails.
     */
    public async connect(): Promise<void> {
        if (this.isDestroyed) throw new ConnectionError('Client destroyed');

        this.logger.debug(`connect() called. Current status: ${this._status}`);

        if (this._status === 'CONNECTED' || this._status === 'CONNECTING') return;

        this.setStatus('CONNECTING');

        try {
            await this.bootPromise;
            await this.transport.connect();
            this.flushQueue();
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

    /**
     * Sets a key-value pair in the synchronized state.
     * 
     * @param key - The key to set
     * @param value - The value to store
     * @param schema - Optional schema for binary encoding. If provided, the schema
     *                 is registered for this key prefix and used for automatic
     *                 decoding when receiving updates.
     */
    public set<T = unknown>(key: string, value: T, schema?: Schema<any>): void {
        if (this.isDestroyed) return;
        try {
            const shouldQueue = this._status !== 'CONNECTED';
            const delta = this.engine.set(key, value, schema, shouldQueue);
            if (delta.length > 0) {
                if (this._isInsideTransaction) {
                    this._transactionDeltas.push(delta);
                } else if (this._status === 'CONNECTED') {
                    this.transport.send(delta);
                } else {
                    this.logger.warn(`set() called while ${this._status}; operation queued`);
                }
            }
        } catch (e) {
            // Handle circular JSON or deep recursion gracefully
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.toLowerCase().includes('circular') || msg.toLowerCase().includes('recursion depth')) {
                this.logger.warn(`Failed to set key "${key}" due to circularity or extreme depth:`, e);
                return;
            }
            throw new Error(`Failed to set key "${key}": ${msg}`);
        }
    }

    /**
     * Groups multiple set operations into a single atomic-ish broadcast.
     */
    public transaction(fn: () => void): void {
        this._isInsideTransaction = true;
        this._transactionDeltas = [];
        try {
            fn();
            if (this._transactionDeltas.length > 0 && this._status === 'CONNECTED') {
                // For now, we just send them individually but in the same tick
                this._transactionDeltas.forEach(d => this.transport.send(d));
            }
        } finally {
            this._isInsideTransaction = false;
            this._transactionDeltas = [];
        }
    }

    public get<T = unknown>(key: string): T | undefined {
        return this.engine.get(key) as T;
    }

    /**
     * Returns the last value confirmed by the server for a given key.
     */
    public getConfirmed<T = unknown>(key: string): T | undefined {
        return this.engine.getConfirmed(key) as T;
    }

    /**
     * Returns true if the key has an optimistic local value awaiting server confirmation.
     */
    public isPending(key: string): boolean {
        return this.engine.isOptimistic(key);
    }

    /**
     * Registers a schema for a key pattern for automatic encoding/decoding.
     * Use this when you want to pre-register schemas before calling set().
     */
    public registerSchema(keyPattern: string, schema: Schema<any>): void {
        this.engine.registerSchema(keyPattern, schema);
    }

    public sendOperation<T = unknown>(key: string, value: T, schema?: Schema<any>): void {
        this.set(key, value, schema);
    }

    public getState(): Record<string, unknown> {
        return this.engine.getAllValues();
    }

    /**
     * Broadcasts an ephemeral data payload to all peers in the workspace.
     * @param data - The payload to send (object, string, or binary)
     */
    public broadcast(data: unknown): void {
        if (this.isDestroyed) return;
        if (this._status !== 'CONNECTED') {
            this.logger.warn('broadcast() called while not connected');
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

    /**
     * Returns the list of currently connected peer IDs.
     */
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
            this.logger.warn('Status handler error on subscribe', e);
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
            this.logger.warn('QueueChange handler error on subscribe', e);
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
            this.logger.warn('Failed to fetch presence:', error.message);
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

    public clearQueue(): void {
        this.engine.clearQueue();
    }

    public destroy(): void {
        if (this.isDestroyed) return;
        this.disconnect();
        this.engine.destroy();
        this.syncedMaps.clear();

        // Clear all listeners
        Object.values(this.listeners).forEach(set => set.clear());

        this.isDestroyed = true;
    }

    private setStatus(newStatus: ConnectionStatus): void {
        if (this._status !== newStatus) {
            if (this.config.debug) {
                this.logger.debug(`Status: ${this._status} -> ${newStatus}`);
            }
            if (newStatus === 'ERROR') {
                this.logger.error(`Transitioning to ERROR state!`);
            }
            this._status = newStatus;
            this.notifyStatusListeners(newStatus);
            if (newStatus === 'CONNECTED') this.flushQueue();
        }
    }

    private notifyStatusListeners(status: ConnectionStatus): void {
        this.listeners.status.forEach(l => {
            try { l(status); } catch (e) { this.logger.warn('Status listener error', e); }
        });
    }

    private flushQueue(): void {
        try {
            const ops = this.engine.getPendingOps();
            const count = ops.length;
            if (count > 0) {
                this.logger.info(`Flushing ${count} queued operations to transport.`);
                let success = 0;
                for (const op of ops) {
                    try {
                        this.transport.send(op);
                        success++;
                    } catch (sendErr) {
                        this.logger.error(`Failed to send operation during flush at index ${success}/${count}`, sendErr);
                        // Stop flushing on error to prevent out-of-order execution if transport is broken
                        break;
                    }
                }

                if (success > 0) {
                    this.logger.info(`Successfully flushed ${success}/${count} operations.`);
                    // Use shiftQueue to remove exactly what was sent
                    this.engine.shiftQueue(success);
                }
            }
        } catch (e) {
            this.logger.warn('Failed to start operation queue flush', e);
        }
    }

    private notifyMessageListeners(msg: NMeshedMessage): void {
        this.listeners.message.forEach(l => {
            try { l(msg); } catch (e) { this.logger.warn('Message listener error', e); }
        });
    }

    private generateUserId(): string {
        if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) {
            return (crypto as any).randomUUID();
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

    public get operationQueue(): Uint8Array[] {
        return this.engine.getPendingOps();
    }

    public getPendingCount(): number {
        return this.engine.getQueueLength();
    }

    public getUnconfirmedCount(): number {
        return Object.keys(this.engine.getAllValues()).filter(k => this.engine.isOptimistic(k)).length;
    }
}
