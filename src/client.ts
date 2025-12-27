import { Logger } from './utils/Logger';
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
import type { Schema } from './schema/SchemaBuilder';
import { ConsistentHashRing } from './utils/ConsistentHashRing';

/**
 * NMeshedClient: The High-Level Entrance to the nMeshed SDK.
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
        queueChange: new Set<(size: number) => void>(),
        becomeAuthority: new Set<{ pattern: string; regex: RegExp; handler: (key: string) => void }>(),
        loseAuthority: new Set<{ pattern: string; regex: RegExp; handler: (key: string) => void }>()
    };

    private authorityRing: ConsistentHashRing;
    private currentAuthorities = new Set<string>();

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
            debug: validConfig.debug ?? true
        } as ResolvedConfig;

        this.logger = new Logger('NMeshedClient', this.config.debug);
        this.authorityRing = new ConsistentHashRing(this.config.replicationFactor || 20);
        this.authorityRing.addNode(this.config.userId);

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
            this.logger.debug('Engine snapshot received, transition to READY');
            this.setStatus('READY');
            this.notifyMessageListeners({
                type: 'init',
                data: this.engine.getAllValues()
            });
        });

        this.engine.on('queueChange', (size: number) => {
            this.listeners.queueChange.forEach(l => {
                try { l(size); } catch (e) { this.logger.warn('Queue listener error', e); }
            });
        });

        // Decentralized Authority tracking for new keys
        this.onMessage((msg) => {
            if (msg.type === 'op' && !this.currentAuthorities.has(msg.payload.key)) {
                if (this.isAuthority(msg.payload.key)) {
                    this.currentAuthorities.add(msg.payload.key);
                    this.listeners.becomeAuthority.forEach(l => {
                        if (l.regex.test(msg.payload.key)) {
                            try { l.handler(msg.payload.key); } catch (e) { this.logger.warn('becomeAuthority listener error', e); }
                        }
                    });
                }
            }
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
                heartbeatMaxMissed: this.config.heartbeatMaxMissed
            })
            : new P2PTransport(this.config);

        this.setupTransportListeners();
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
            const nextStatus = statusMap[s] || 'IDLE';
            if (nextStatus === 'CONNECTED') {
                if (this._status !== 'READY' && this._status !== 'SYNCING') {
                    this.setStatus('CONNECTED');
                    this.setStatus('SYNCING');
                }
            } else {
                this.setStatus(nextStatus);
            }
        });

        this.transport.on('message', (data: Uint8Array) => {
            this.engine.applyRawMessage(data);
        });

        this.transport.on('init', (payload: Record<string, unknown>) => {
            this.engine.handleInitSnapshot(payload.data as Record<string, unknown> || payload);
        });

        this.transport.on('ephemeral', (payload: unknown, from?: string) => {
            const isNMeshedMsg = (p: unknown): p is NMeshedMessage =>
                p !== null && typeof p === 'object' && 'type' in p && ['op', 'ephemeral', 'presence'].includes((p as any).type);

            const effectiveMsg: NMeshedMessage = isNMeshedMsg(payload)
                ? payload
                : { type: 'ephemeral', payload, from };

            this.notifyMessageListeners(effectiveMsg);

            this.listeners.ephemeral.forEach(l => {
                try { l(payload, from); } catch (e) { this.logger.warn('Ephemeral listener error', e); }
            });
        });

        this.transport.on('presence', (payload: unknown) => {
            const isPresencePayload = (p: unknown): p is PresenceUser =>
                p !== null && typeof p === 'object' && 'userId' in p && 'status' in p;

            if (isPresencePayload(payload)) {
                this.listeners.presence.forEach(l => {
                    try { l(payload); } catch (e) { this.logger.warn('Presence listener error', e); }
                });
            }
        });

        this.transport.on('peerJoin', (id: string) => {
            this.authorityRing.addNode(id);
            this.recalculateAuthority();
            this.listeners.peerJoin.forEach(l => l(id));
        });

        this.transport.on('peerDisconnect', (id: string) => {
            this.authorityRing.removeNode(id);
            this.recalculateAuthority();
            this.listeners.peerDisconnect.forEach(l => l(id));
        });

        this.transport.on('sync', (data: Uint8Array) => {
            this.engine.applyRawMessage(data);
        });

        this.transport.on('error', (err: Error) => {
            this.logger.warn('Transport encountered an error', err);
        });
    }

    public get isLive(): boolean {
        return this._status === 'CONNECTED' || this._status === 'SYNCING' || this._status === 'READY';
    }

    public getStatus(): ConnectionStatus {
        return this._status;
    }

    public getId(): string {
        return this.config.userId;
    }

    public async connect(): Promise<void> {
        if (this.isDestroyed) throw new ConnectionError('Client destroyed');
        if (this.isLive || this._status === 'CONNECTING') return;

        this.setStatus('CONNECTING');
        try {
            await this.bootPromise;
            await this.transport.connect();
            this.flushQueue();
        } catch (err) {
            if (this._status !== 'ERROR') this.setStatus('RECONNECTING');
            throw err;
        }
    }

    public async awaitReady(): Promise<void> {
        if (this._status === 'READY') return;
        this.connect().catch(() => { });
        return new Promise((resolve, reject) => {
            const unsub = this.onStatusChange((status) => {
                if (status === 'READY') { unsub(); resolve(); }
                else if (status === 'ERROR' || status === 'DISCONNECTED') {
                    unsub();
                    reject(new ConnectionError(`Connection failed: ${status}`));
                }
            });
        });
    }

    public disconnect(): void {
        this.transport.disconnect();
    }

    public set<T = unknown>(key: string, value: T, schema?: Schema<any>): void {
        if (this.isDestroyed) return;
        if (schema) {
            const prefix = key.split(/[:_]/)[0];
            if (prefix && prefix !== key) this.registerSchema(prefix, schema);
        }

        try {
            const isLive = this.isLive;
            const delta = this.engine.set(key, value, schema, !isLive);
            if (delta.length > 0) {
                if (this._isInsideTransaction) {
                    this._transactionDeltas.push(delta);
                } else if (isLive) {
                    this.transport.send(delta);
                }
            }
        } catch (e) {
            this.logger.error(`Failed to set key "${key}":`, e);
            // throw e; // Suppress throw to allow graceful failure, verified by tests
        }
    }

    public transaction(fn: () => void): void {
        this._isInsideTransaction = true;
        this._transactionDeltas = [];
        const isLive = this.isLive;
        try {
            fn();
            if (this._transactionDeltas.length > 0 && isLive) {
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

    public getConfirmed<T = unknown>(key: string): T | undefined {
        return this.engine.getConfirmed(key) as T;
    }

    public isPending(key: string): boolean {
        return this.engine.isOptimistic(key);
    }

    public registerSchema(keyPattern: string, schema: Schema<any>): void {
        this.engine.registerSchema(keyPattern, schema);
    }

    public onKeyChange<T = unknown>(
        pattern: string,
        handler: (key: string, value: T | null, meta: { isOptimistic: boolean; timestamp: number }) => void
    ): Unsubscribe {
        const regex = this.patternToRegex(pattern);
        return this.onMessage((msg) => {
            if (msg.type === 'op' && regex.test(msg.payload.key)) {
                handler(msg.payload.key, msg.payload.value as T, {
                    isOptimistic: !!msg.payload.isOptimistic,
                    timestamp: msg.payload.timestamp
                });
            }
        });
    }

    private patternToRegex(pattern: string): RegExp {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const glob = escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
        return new RegExp(`^${glob}$`);
    }

    public getState(): Record<string, unknown> {
        return this.engine.getAllValues();
    }

    public isAuthority(key: string): boolean {
        return this.authorityRing.getNode(key) === this.config.userId;
    }

    public onBecomeAuthority(pattern: string, handler: (key: string) => void): Unsubscribe {
        const listener = { pattern, regex: this.patternToRegex(pattern), handler };
        this.listeners.becomeAuthority.add(listener);

        const keys = Object.keys(this.engine.getAllValues());
        keys.forEach(key => {
            if (listener.regex.test(key) && this.isAuthority(key)) {
                if (!this.currentAuthorities.has(key)) this.currentAuthorities.add(key);
                try { handler(key); } catch (e) { this.logger.warn('onBecomeAuthority existing key error', e); }
            }
        });

        return () => this.listeners.becomeAuthority.delete(listener);
    }

    public onLoseAuthority(pattern: string, handler: (key: string) => void): Unsubscribe {
        const listener = { pattern, regex: this.patternToRegex(pattern), handler };
        this.listeners.loseAuthority.add(listener);
        return () => this.listeners.loseAuthority.delete(listener);
    }

    private recalculateAuthority(): void {
        const allKeys = Object.keys(this.engine.getAllValues());
        const previousAuthorities = new Set(this.currentAuthorities);
        this.currentAuthorities.clear();

        allKeys.forEach(key => {
            if (this.isAuthority(key)) {
                this.currentAuthorities.add(key);
                if (!previousAuthorities.has(key)) {
                    this.listeners.becomeAuthority.forEach(l => {
                        if (l.regex.test(key)) {
                            try { l.handler(key); } catch (e) { this.logger.warn('becomeAuthority listener error', e); }
                        }
                    });
                }
            } else if (previousAuthorities.has(key)) {
                this.listeners.loseAuthority.forEach(l => {
                    if (l.regex.test(key)) {
                        try { l.handler(key); } catch (e) { this.logger.warn('loseAuthority listener error', e); }
                    }
                });
            }
        });
    }

    public broadcast(data: unknown): void {
        if (this.isDestroyed) return;
        if (!this.isLive) {
            this.logger.warn('Broadcast called while disconnected or ensuring connection');
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
        if (typeof handler !== 'function') throw new Error('Status handler must be a function');
        this.listeners.status.add(handler);
        try { handler(this._status); } catch (e) { }
        return () => this.listeners.status.delete(handler);
    }

    public onMessage(handler: MessageHandler): Unsubscribe {
        if (typeof handler !== 'function') throw new Error('Message handler must be a function');
        this.listeners.message.add(handler);
        return () => this.listeners.message.delete(handler);
    }

    public onEphemeral(handler: EphemeralHandler): Unsubscribe {
        if (typeof handler !== 'function') throw new Error('Ephemeral handler must be a function');
        this.listeners.ephemeral.add(handler);
        return () => this.listeners.ephemeral.delete(handler);
    }

    public onPresence(handler: PresenceHandler): Unsubscribe {
        if (typeof handler !== 'function') throw new Error('Presence handler must be a function');
        this.listeners.presence.add(handler);
        return () => this.listeners.presence.delete(handler);
    }

    public onPeerJoin(handler: (userId: string) => void): Unsubscribe {
        this.listeners.peerJoin.add(handler);
        return () => this.listeners.peerJoin.delete(handler);
    }

    public onPeerDisconnect(handler: (userId: string) => void): Unsubscribe {
        this.listeners.peerDisconnect.add(handler);
        return () => this.listeners.peerDisconnect.delete(handler);
    }

    public onQueueChange(handler: (size: number) => void): Unsubscribe {
        this.listeners.queueChange.add(handler);
        try { handler(this.getQueueSize()); } catch (e) { }
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
            case 'peerJoin': return this.onPeerJoin(handler as (peerId: string) => void);
            case 'peerDisconnect': return this.onPeerDisconnect(handler as (peerId: string) => void);
            case 'queueChange': return this.onQueueChange(handler as (size: number) => void);
            default: return () => { };
        }
    }

    public getSyncedMap<T = unknown>(name: string, config?: SyncedMapConfig<T>): SyncedMap<T> {
        if (this.syncedMaps.has(name)) return this.syncedMaps.get(name) as SyncedMap<T>;
        const map = new SyncedMap<T>(this, name, config);
        this.syncedMaps.set(name, map as SyncedMap<unknown>);
        return map;
    }

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
            if (!res.ok) throw new Error(`Failed to fetch presence: ${res.statusText}`);
            return await res.json();
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
        if (options.latency !== undefined) this.transport.simulateLatency(options.latency);
        if (options.packetLoss !== undefined) this.transport.simulatePacketLoss(options.packetLoss);
    }

    public clearQueue(): void {
        this.engine.clearQueue();
    }

    public destroy(): void {
        if (this.isDestroyed) return;
        this.disconnect();
        this.engine.destroy();
        this.syncedMaps.clear();
        Object.values(this.listeners).forEach(set => set.clear());
        this.isDestroyed = true;
    }

    private setStatus(newStatus: ConnectionStatus): void {
        if (this._status !== newStatus) {
            this.logger.debug(`Status: ${this._status} -> ${newStatus}`);
            this._status = newStatus;
            this.notifyStatusListeners(newStatus);
            if (['CONNECTED', 'SYNCING', 'READY'].includes(newStatus)) this.flushQueue();
        }
    }

    private notifyStatusListeners(status: ConnectionStatus): void {
        this.listeners.status.forEach(l => { try { l(status); } catch (e) { } });
    }

    private flushQueue(): void {
        try {
            const ops = this.engine.getPendingOps();
            if (ops.length === 0) return;
            let success = 0;
            for (const op of ops) {
                try {
                    this.transport.send(op);
                    success++;
                } catch (sendErr) {
                    break;
                }
            }
            if (success > 0) this.engine.shiftQueue(success);
        } catch (e) {
            this.logger.warn('Failed to flush queue', e);
        }
    }

    private notifyMessageListeners(msg: NMeshedMessage): void {
        this.listeners.message.forEach(l => { try { l(msg); } catch (e) { } });
    }

    private generateUserId(): string {
        if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) return (crypto as any).randomUUID();
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
