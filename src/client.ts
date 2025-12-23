/**
 * @file client.ts
 * @brief Core nMeshed client for real-time synchronization.
 *
 * This module provides the main NMeshedClient class for connecting to
 * nMeshed servers and synchronizing state across distributed clients.
 *
 * Architecture:
 * - Binary CRDT Path: Operations use Flatbuffers for high-performance sync
 * - JSON Control Path: Presence, errors, and ephemeral use JSON for simplicity
 *
 * @example
 * ```typescript
 * import { NMeshedClient } from 'nmeshed';
 *
 * const client = new NMeshedClient({
 *     workspaceId: 'my-workspace',
 *     token: 'jwt-token',
 * });
 *
 * await client.connect();
 * client.set('key', 'value');
 * ```
 */
import type {
    NMeshedConfig,
    ConnectionStatus,
    MessageHandler,
    StatusHandler,
    EphemeralHandler,
    PresenceHandler,
    ResolvedConfig,
    ChaosOptions,
} from './types';
import {
    ConfigurationError,
    ConnectionError,
} from './errors';
import { encodeValue } from './codec';
import init, { NMeshedClientCore } from './wasm/nmeshed_core';
import { z } from 'zod';
import { loadQueue as dbLoadQueue, saveQueue as dbSaveQueue } from './persistence';
import { SyncedMap } from './sync/SyncedMap';
import { Schema, SchemaDefinition } from './schema/SchemaBuilder';

/**
 * Configuration schema for validation.
 */
const ConfigSchema = z.object({
    workspaceId: z.string().min(1, 'workspaceId is required and must be a non-empty string'),
    token: z.string().optional(),
    apiKey: z.string().optional(),
    syncMode: z.enum(['crdt', 'crdt_performance', 'crdt_strict', 'lww']).optional(),
    userId: z.string().optional(),
    serverUrl: z.string().optional(),
    autoReconnect: z.boolean().optional(),
    maxReconnectAttempts: z.number().nonnegative().optional(),
    reconnectBaseDelay: z.number().nonnegative().optional(),
    maxReconnectDelay: z.number().nonnegative().optional(),
    connectionTimeout: z.number().nonnegative().optional(),
    heartbeatInterval: z.number().nonnegative().optional(),
    maxQueueSize: z.number().nonnegative().optional(),
    debug: z.boolean().optional(),
}).refine(data => data.token || data.apiKey, {
    message: "Either 'apiKey' or 'token' must be provided",
    path: ["apiKey"]
});


/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: Omit<ResolvedConfig, 'workspaceId' | 'token' | 'userId' | 'syncMode' | 'apiKey'> = {
    serverUrl: 'wss://api.nmeshed.com',
    autoReconnect: true,
    maxReconnectAttempts: 10,
    reconnectBaseDelay: 1000,
    maxReconnectDelay: 30000,
    connectionTimeout: 10000,
    heartbeatInterval: 30000,
    maxQueueSize: 1000,
    debug: false,
};

/**
 * Queued operation structure.
 */
interface QueuedOperation {
    key: string;
    value: unknown;
    timestamp: number;
}

/**
 * nMeshed client for real-time synchronization.
 *
 * The client manages a WebSocket connection to an nMeshed server,
 * handles automatic reconnection, and provides methods for sending
 * and receiving state updates.
 *
 * ## Features
 * - Automatic reconnection with exponential backoff
 * - Connection timeout to prevent hangs
 * - Heartbeat pings to detect dead connections
 * - Operation queueing when offline
 * - Bounded queue to prevent memory issues
 * - Defensive message parsing
 *
 * @example Basic Usage
 * ```typescript
 * const client = new NMeshedClient({
        *   workspaceId: 'my-workspace',
        *   token: 'jwt-token'
 * });
 *
 * await client.connect();
 *
 * client.onMessage((msg) => {
 *   if (msg.type === 'op') {
 * console.log('Update:', msg.payload.key, '=', msg.payload.value);
 *   }
 * });
 *
 * client.set('greeting', 'Hello!');
 * ```
 */
export class NMeshedClient {
    private readonly config: ResolvedConfig;
    private ws: WebSocket | null = null;
    private status: ConnectionStatus = 'IDLE';
    private readonly messageListeners = new Set<MessageHandler>();
    private readonly statusListeners = new Set<StatusHandler>();
    private readonly ephemeralListeners = new Set<EphemeralHandler>();
    private readonly presenceListeners = new Set<PresenceHandler>();
    private readonly queueListeners = new Set<(size: number) => void>();
    private reconnectAttempts = 0;
    private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    private connectionTimeout: ReturnType<typeof setTimeout> | null = null;
    private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    private operationQueue: QueuedOperation[] = [];
    private core: NMeshedClientCore | null = null;
    private preConnectState: Record<string, unknown> = {};
    private isDestroyed = false;
    private chaos: ChaosOptions | null = null;
    private pendingPings: Map<string, (rtt: number) => void> = new Map();
    private syncedMaps: Map<string, SyncedMap<any>> = new Map();
    private bootPromise: Promise<void>;

    /**
     * Creates a new nMeshed client instance.
     *
     * @param config - Configuration options
     * @throws {ConfigurationError} If workspaceId or token is missing
     */
    constructor(config: NMeshedConfig) {
        // Zod at the Gates: Trust no one.
        const result = ConfigSchema.safeParse(config);

        if (!result.success) {
            // Fail Loudly
            const errorMessages = result.error.issues
                .map(e => `${e.path.join('.')}: ${e.message}`)
                .join(', ');
            throw new ConfigurationError(`nMeshed: ${errorMessages}`);
        }

        const validConfig = result.data;

        this.config = {
            ...DEFAULT_CONFIG,
            workspaceId: validConfig.workspaceId.trim(),
            token: validConfig.token,
            apiKey: validConfig.apiKey,
            syncMode: validConfig.syncMode || 'crdt',
            userId: validConfig.userId?.trim() || this.generateUserId(),
            // If serverUrl is explicitly validConfig, use it.
            // If not, we defer resolution to buildUrl().
            ...(validConfig.serverUrl && { serverUrl: validConfig.serverUrl }),
            ...(validConfig.autoReconnect !== undefined && { autoReconnect: validConfig.autoReconnect }),
            ...(validConfig.maxReconnectAttempts !== undefined && { maxReconnectAttempts: validConfig.maxReconnectAttempts }),
            ...(validConfig.reconnectBaseDelay !== undefined && { reconnectBaseDelay: validConfig.reconnectBaseDelay }),
            ...(validConfig.maxReconnectDelay !== undefined && { maxReconnectDelay: validConfig.maxReconnectDelay }),
            ...(validConfig.connectionTimeout !== undefined && { connectionTimeout: validConfig.connectionTimeout }),
            ...(validConfig.heartbeatInterval !== undefined && { heartbeatInterval: validConfig.heartbeatInterval }),
            ...(validConfig.maxQueueSize !== undefined && { maxQueueSize: validConfig.maxQueueSize }),
            ...(validConfig.debug !== undefined && { debug: validConfig.debug }),
        } as ResolvedConfig; // Cast is safe because we merged defaults

        this.loadQueue();

        // Implicit Boot: Start WASM initialization immediately (Fire and forget)
        this.bootPromise = this.bootCore().catch(err => {
            this.warn('Failed to implicit boot WASM core:', err);
        });
    }

    private async bootCore() {
        if (this.core) return;

        await init();

        if (this.core) return; // Race condition check

        // Map extended modes (performance/strict) to base 'crdt' for WASM
        const coreMode = (this.config.syncMode === 'lww') ? 'lww' : 'crdt';
        this.core = new NMeshedClientCore(this.config.workspaceId, coreMode);

        // Merge pre-connect state into the new core
        for (const [key, value] of Object.entries(this.preConnectState)) {
            try {
                const valBytes = encodeValue(value);
                this.core.apply_local_op(key, valBytes, BigInt(Date.now() * 1000));
            } catch (e) {
                this.warn('Failed to merge preConnectState for key:', key, e);
            }
        }
        this.preConnectState = {}; // Clear it
    }

    /**
     * Generates a random user ID using crypto if available, falling back to Math.random.
     */
    private generateUserId(): string {
        // Try crypto API first (more random)
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return `user-${crypto.randomUUID().substring(0, 8)}`;
        }
        // Fallback to Math.random
        return 'user-' + Math.random().toString(36).substring(2, 11);
    }

    /**
     * Logs a debug message if debug mode is enabled.
     */
    private log(message: string, ...args: unknown[]): void {
        if (this.config.debug) {
            const timestamp = new Date().toISOString();
            console.log(`[nMeshed ${timestamp}] ${message} `, ...args);
        }
    }

    /**
     * Logs a warning message (always shown).
     */
    private warn(message: string, ...args: unknown[]): void {
        console.warn(`[nMeshed] ${message} `, ...args);
    }

    /**
     * Updates the connection status and notifies listeners.
     */
    private setStatus(newStatus: ConnectionStatus): void {
        if (this.status !== newStatus) {
            this.log(`Status: ${this.status} -> ${newStatus} `);
            this.status = newStatus;

            // Clone listeners to avoid mutation during iteration
            const listeners = Array.from(this.statusListeners);
            for (const listener of listeners) {
                try {
                    listener(newStatus);
                } catch (error) {
                    this.warn('Status listener threw an error:', error);
                }
            }
        }
    }

    /**
     * Builds the WebSocket URL with query parameters.
     */
    private buildUrl(): string {
        let baseUrl = this.config.serverUrl;

        // Intelligent Defaults based on API Key
        if (!baseUrl && this.config.apiKey) {
            const key = this.config.apiKey;
            if (key.startsWith('nm_local_')) {
                baseUrl = 'ws://localhost:8080';
            } else if (key.includes('_us-east_')) {
                baseUrl = 'wss://us-east.api.nmeshed.io';
            } else if (key.includes('_eu-west_')) {
                baseUrl = 'wss://eu-west.api.nmeshed.io';
            } else {
                // Default Global
                baseUrl = 'wss://api.nmeshed.com';
            }
        }

        // Fallback if no apiKey and no serverUrl (shouldn't happen due to default, but safe)
        if (!baseUrl) {
            baseUrl = 'wss://api.nmeshed.com';
        }

        const base = baseUrl.replace(/\/+$/, '');
        const params = new URLSearchParams({
            // Send whichever auth method is available
            ...(this.config.token ? { token: this.config.token } : {}),
            ...(this.config.apiKey ? { api_key: this.config.apiKey } : {}),
            userId: this.config.userId,
            sync_mode: this.config.syncMode,
        });
        // Encode workspaceId to handle special characters
        const encodedWorkspace = encodeURIComponent(this.config.workspaceId);
        return `${base}/v1/sync/${encodedWorkspace}?${params.toString()}`;
    }

    /**
     * Connects to the nMeshed server.
     *
     * @returns A promise that resolves when connected, or rejects on error.
     * @throws {ConnectionError} If connection fails or times out
     */
    connect(): Promise<void> {
        if (this.isDestroyed) {
            return Promise.reject(new ConnectionError('Client has been destroyed', undefined, false));
        }

        if (this.status === 'CONNECTED') {
            this.log('Already connected');
            return Promise.resolve();
        }

        if (this.status === 'CONNECTING') {
            this.log('Connection already in progress');
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            (async () => {
                this.setStatus('CONNECTING');
                try {
                    // Implicit Core: Wait for proactive boot to finish
                    try {
                        await this.bootPromise;
                        if (!this.core) {
                            throw new Error("Core not initialized after boot");
                        }
                    } catch (e: any) {
                        // Re-throw as ConnectionError or handle
                        throw new Error(`Failed to boot core: ${e.message}`);
                    }
                } catch (error) {
                    this.setStatus('ERROR');
                    reject(new ConnectionError(
                        'Failed to initialize WASM core',
                        error instanceof Error ? error : new Error(String(error)),
                        false
                    ));
                    return;
                }

                this.setStatus('CONNECTING');
                const url = this.buildUrl();
                this.log('Connecting to', url.replace(this.config.token, '[REDACTED]'));

                // Set connection timeout
                if (this.config.connectionTimeout > 0) {
                    this.connectionTimeout = setTimeout(() => {
                        this.log('Connection timeout');
                        this.cleanupConnection();
                        this.setStatus('ERROR');
                        reject(new ConnectionError(
                            `Connection timed out after ${this.config.connectionTimeout} ms`,
                            undefined,
                            true
                        ));
                    }, this.config.connectionTimeout);
                }

                try {
                    this.ws = new WebSocket(url);
                } catch (error) {
                    this.clearConnectionTimeout();
                    this.setStatus('ERROR');
                    reject(new ConnectionError(
                        'Failed to create WebSocket',
                        error instanceof Error ? error : undefined,
                        false
                    ));
                    return;
                }

                this.ws.onopen = () => {
                    this.clearConnectionTimeout();
                    this.log('WebSocket connected');
                    this.setStatus('CONNECTED');
                    this.reconnectAttempts = 0;
                    this.startHeartbeat();
                    this.flushOperationQueue();
                    resolve();
                };

                this.ws.onclose = (event) => {
                    this.clearConnectionTimeout();
                    this.log('WebSocket closed', { code: event.code, reason: event.reason });
                    this.handleDisconnect(event.code);
                };

                this.ws.onerror = () => {
                    this.log('WebSocket error');
                    if (this.status === 'CONNECTING') {
                        this.clearConnectionTimeout();
                        this.setStatus('ERROR');
                        reject(new ConnectionError('WebSocket connection failed', undefined, true));
                    }
                };

                this.ws.binaryType = 'arraybuffer'; // Crucial for performance

                this.ws.onmessage = (event) => {
                    // Use duck-typing for ArrayBuffer check (works in Node.js tests)
                    const isBinaryData = event.data instanceof ArrayBuffer ||
                        (event.data && typeof event.data === 'object' && 'byteLength' in event.data && !('length' in event.data));

                    if (isBinaryData) {
                        // Binary Path (Fast Lane)
                        try {
                            // 1. Merge into WASM Core
                            const result = this.core?.merge_remote_delta(new Uint8Array(event.data)) as any;

                            // 2. State is now updated in Core. 
                            // Notify listeners based on result type
                            if (result) {
                                if (result.type === 'op') {
                                    const syntheticMsg = {
                                        type: 'op' as const,
                                        payload: {
                                            key: result.key,
                                            value: result.value,
                                            timestamp: 0
                                        }
                                    };

                                    // Dispatch to listeners (e.g. useDocument, useNmeshed)
                                    const listeners = Array.from(this.messageListeners);
                                    for (const listener of listeners) {
                                        try {
                                            listener(syntheticMsg as any);
                                        } catch (error) {
                                            this.warn('Message listener threw an error:', error);
                                        }
                                    }
                                } else if (result.type === 'init') {
                                    // Handle init message from binary protocol
                                    const syntheticInit = {
                                        type: 'init' as const,
                                        data: result.data || {}
                                    };

                                    const listeners = Array.from(this.messageListeners);
                                    for (const listener of listeners) {
                                        try {
                                            listener(syntheticInit as any);
                                        } catch (error) {
                                            this.warn('Message listener threw an error:', error);
                                        }
                                    }
                                }
                            }

                            this.log('Received Binary Update');
                        } catch (error) {
                            this.warn('Failed to merge remote delta:', error);
                        }

                        // If not an Op, assume Ephemeral/Cursor (Legacy or Spec v2)
                        const listeners = Array.from(this.ephemeralListeners);
                        for (const listener of listeners) {
                            try {
                                listener(event.data);
                            } catch (error) {
                                this.warn('Binary listener threw error:', error);
                            }
                        }
                    } else {
                        // TEXT PATH: Control messages only (ephemeral, presence, errors)
                        // CRDT ops should NEVER be text - only binary Flatbuffers
                        this.handleControlMessage(event.data);
                    }
                };
            })().catch(reject);
        });
    }

    /**
     * Clears the connection timeout timer.
     */
    private clearConnectionTimeout(): void {
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }
    }

    /**
     * Starts the heartbeat interval to detect dead connections.
     */
    private startHeartbeat(): void {
        this.stopHeartbeat();

        if (this.config.heartbeatInterval <= 0) {
            return;
        }

        this.heartbeatInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                try {
                    // Send a binary heartbeat (single byte marker)
                    // Note: Server interprets 0x00 as keep-alive ping
                    this.ws.send(new Uint8Array([0x00]));
                    this.log('Heartbeat sent');
                } catch (error) {
                    this.warn('Failed to send heartbeat:', error);
                }
            }
        }, this.config.heartbeatInterval);
    }

    /**
     * Stops the heartbeat interval.
     */
    private stopHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    /**
     * Handles text control messages (ephemeral, presence, errors).
     * NOTE: CRDT operations use binary Flatbuffers, not this path.
     */
    private handleControlMessage(data: string): void {
        try {
            const parsed = JSON.parse(data);
            const type = parsed.type;

            switch (type) {
                case 'presence': {
                    // Real-time presence update from server
                    const presencePayload = parsed.payload || parsed;
                    for (const handler of this.presenceListeners) {
                        try {
                            handler(presencePayload);
                        } catch (error) {
                            this.warn('Presence handler threw error:', error);
                        }
                    }
                    break;
                }

                case 'ephemeral': {
                    // Cursor/typing indicators from other clients
                    const ephemeralPayload = parsed.payload || parsed;

                    // Internal diagnostic handlers
                    if (ephemeralPayload.type === '__ping__' && ephemeralPayload.to === this.config.userId) {
                        this.broadcast({
                            type: '__pong__',
                            requestId: ephemeralPayload.requestId,
                            from: this.config.userId,
                            to: ephemeralPayload.from,
                            timestamp: ephemeralPayload.timestamp,
                        });
                        return;
                    }

                    if (ephemeralPayload.type === '__pong__' && ephemeralPayload.to === this.config.userId) {
                        const handler = this.pendingPings.get(ephemeralPayload.requestId);
                        if (handler) {
                            const rtt = performance.now() - ephemeralPayload.timestamp;
                            this.pendingPings.delete(ephemeralPayload.requestId);
                            handler(rtt);
                        }
                        return;
                    }

                    for (const listener of this.ephemeralListeners) {
                        try {
                            listener(ephemeralPayload);
                        } catch (error) {
                            this.warn('Ephemeral listener threw error:', error);
                        }
                    }
                    break;
                }

                case 'error':
                    // Error from server
                    this.warn('Server error:', parsed.error || parsed.message || data);
                    break;

                default:
                    this.log('Ignoring unknown control message type:', type);
            }
        } catch {
            // Not valid JSON - ignore
            this.log('Ignoring non-JSON text message');
        }
    }

    /**
     * Handles disconnection and initiates reconnection if configured.
     */
    private handleDisconnect(closeCode?: number): void {
        this.cleanupConnection();

        // Check for authentication errors (typically 4001 or 4003)
        if (closeCode && closeCode >= 4000 && closeCode < 4100) {
            this.warn('Authentication error, not reconnecting');
            this.setStatus('ERROR');
            return;
        }

        if (!this.config.autoReconnect) {
            this.setStatus('DISCONNECTED');
            return;
        }

        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
            this.log('Max reconnect attempts reached');
            this.setStatus('ERROR');
            return;
        }

        this.setStatus('RECONNECTING');
        this.scheduleReconnect();
    }

    /**
     * Cleans up the current connection without changing status.
     */
    private cleanupConnection(): void {
        this.stopHeartbeat();
        this.clearConnectionTimeout();

        if (this.ws) {
            // Remove handlers to prevent callbacks during cleanup
            this.ws.onopen = null;
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.onmessage = null;

            try {
                this.ws.close();
            } catch {
                // Ignore errors during cleanup
            }
            this.ws = null;
        }
    }

    /**
     * Schedules a reconnection attempt with capped exponential backoff.
     */
    private scheduleReconnect(): void {
        // Calculate delay with exponential backoff, capped at maxReconnectDelay
        const rawDelay = this.config.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts);
        const delay = Math.min(rawDelay, this.config.maxReconnectDelay);

        // Add jitter (±10%) to prevent thundering herd
        const jitter = delay * 0.1 * (Math.random() * 2 - 1);
        const finalDelay = Math.round(delay + jitter);

        this.log(`Reconnecting in ${finalDelay} ms(attempt ${this.reconnectAttempts + 1} / ${this.config.maxReconnectAttempts})`);

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectAttempts++;
            this.connect().catch((error) => {
                this.log('Reconnect failed:', error);
                // handleDisconnect will be called by the WebSocket close event
            });
        }, finalDelay);
    }

    /**
     * Flushes any operations queued while disconnected.
     */
    private flushOperationQueue(): void {
        if (this.operationQueue.length === 0) {
            return;
        }

        this.log(`Flushing ${this.operationQueue.length} queued operations`);

        // Process a snapshot of the queue to prevent infinite loops if operations are re-queued
        const queueToProcess = [...this.operationQueue];
        this.operationQueue = [];
        this.saveQueue();
        this.notifyQueueListeners();

        for (const op of queueToProcess) {
            this.sendOperationInternal(op.key, op.value, op.timestamp);
        }
    }

    /**
     * Sets a key-value pair in the workspace.
     *
     * @param key - The key to set (must be non-empty string)
     * @param value - The value to set
     * @param schema - Optional schema to use for serialization
     * @throws {ConfigurationError} If key is invalid
     */
    set<T extends SchemaDefinition>(key: string, value: unknown, schema?: Schema<T>): void {
        if (!key || typeof key !== 'string') {
            throw new ConfigurationError('Key must be a non-empty string');
        }

        let finalValue = value;
        if (schema) {
            try {
                // If schema provided, we encode to Uint8Array immediately
                finalValue = schema.encode(value);
            } catch (e: any) {
                throw new ConfigurationError(`Failed to encode value with schema: ${e.message}`);
            }
        }

        this.sendOperation(key, finalValue);
    }

    /**
     * Gets the current user ID.
     */
    getId(): string {
        return this.config.userId;
    }

    /**
     * Measures Round-Trip Time (RTT) to a specific user.
     * @param userId - The ID of the user to ping
     * @returns Promise resolving to the RTT in milliseconds
     */
    async ping(userId: string): Promise<number> {
        return new Promise((resolve) => {
            if (this.status !== 'CONNECTED') {
                resolve(-1);
                return;
            }

            const requestId = Math.random().toString(36).substring(2, 11);
            const start = performance.now();

            const timer = setTimeout(() => {
                this.pendingPings.delete(requestId);
                resolve(-1); // Timeout
            }, 5000);

            this.pendingPings.set(requestId, (rtt) => {
                clearTimeout(timer);
                resolve(rtt);
            });

            this.broadcast({
                type: '__ping__',
                requestId,
                from: this.config.userId,
                to: userId,
                timestamp: start,
            });
        });
    }

    /**
     * Enables artificial network conditions for testing.
     * @param options - Chaos configuration
     */
    simulateNetwork(options: ChaosOptions | null): void {
        this.chaos = options;
        if (options) {
            this.log('Network Chaos Mode ENABLED:', options);
        } else {
            this.log('Network Chaos Mode DISABLED');
        }
    }

    private withChaos(fn: () => void): void {
        if (!this.chaos) {
            fn();
            return;
        }

        // 1. Packet Loss
        if (this.chaos.packetLoss && Math.random() * 100 < this.chaos.packetLoss) {
            this.log('Chaos: Packet dropped');
            return;
        }

        // 2. Latency + Jitter
        let delay = this.chaos.latency || 0;
        if (this.chaos.jitter) {
            delay += (Math.random() * 2 - 1) * this.chaos.jitter;
        }

        if (delay > 0) {
            setTimeout(fn, delay);
        } else {
            fn();
        }
    }

    get<T = unknown, S extends SchemaDefinition = any>(key: string, schema?: Schema<S>): T | undefined {
        if (!this.core) {
            return this.preConnectState[key] as T | undefined;
        }
        const state = this.getState();
        const rawValue = state[key];

        if (schema && rawValue instanceof Uint8Array) {
            try {
                return schema.decode(rawValue) as T;
            } catch (e) {
                this.warn(`Failed to decode key '${key}' with schema:`, e);
                return undefined;
            }
        }

        return rawValue as T | undefined;
    }

    /**
     * Gets the entire current state of the workspace.
     *
     * @returns The current state from the WASM core
     */
    getState(): Record<string, unknown> {
        if (!this.core) return { ...this.preConnectState };
        try {
            return this.core.get_state() as Record<string, unknown>;
        } catch (error) {
            this.warn('Failed to get state from WASM core:', error);
            return {};
        }
    }

    /**
     * Sends an operation to update a key-value pair.
     *
     * If not connected, the operation is queued and sent when reconnected.
     *
     * @param key - The key to update
     * @param value - The new value
     */
    sendOperation(key: string, value: unknown): void {
        const timestamp = Date.now() * 1000; // Unix microseconds

        if (!this.core) {
            this.preConnectState[key] = value;
        }

        if (this.ws?.readyState !== WebSocket.OPEN) {
            this.queueOperation(key, value, timestamp);
            return;
        }

        this.sendOperationInternal(key, value, timestamp);
    }

    /**
     * Broadcasts an ephemeral message to all other connected clients.
     * 
     * @param payload - The data to broadcast (JSON object or Binary ArrayBuffer)
     */
    broadcast(payload: unknown): void {
        this.withChaos(() => {
            if (this.ws?.readyState !== WebSocket.OPEN) {
                this.warn('Cannot broadcast: not connected');
                return;
            }

            try {
                // Binary Path (Fast Lane) - Always prefer binary
                if (payload instanceof ArrayBuffer || payload instanceof Uint8Array) {
                    this.ws!.send(payload);
                    return;
                }

                // Encode non-binary payload to binary (uses encodeValue for JSON encoding)
                const encoded = encodeValue(payload);
                this.ws!.send(encoded);
            } catch (error) {
                this.warn('Failed to broadcast message:', error);
            }
        });
    }

    /**
     * Internal method to send an operation (assumes connection is open).
     */
    private sendOperationInternal(key: string, value: unknown, timestamp: number): void {
        // Binary Path: ALWAYS prefer binary for Ops
        if (!this.core) {
            this.warn('WASM core not initialized, queuing operation');
            this.queueOperation(key, value, timestamp);
            return;
        }

        // Encode value to binary using codec
        let valBytes: Uint8Array;
        try {
            valBytes = encodeValue(value);
        } catch (error) {
            // Encoding failed (e.g., circular reference) - don't queue, just warn
            this.warn('Failed to encode value, dropping operation:', key, error);
            return;
        }

        try {
            const binaryOp = this.core.apply_local_op(key, valBytes, BigInt(timestamp));

            if (this.ws) {
                this.withChaos(() => {
                    this.ws?.send(binaryOp);
                });
            }
            this.log('Sent binary operation (WASM-packed):', key);
        } catch (error) {
            this.warn('Failed to send binary operation via WASM core:', error);
            this.queueOperation(key, value, timestamp);
        }
    }

    /**
     * Returns a SyncedMap instance for the given namespace.
     * Managed instances are cached and reused.
     * 
     * @param namespace - Unique namespace for the map
     * @returns A SyncedMap instance
     */
    getSyncedMap<T = any>(namespace: string): SyncedMap<T> {
        if (!this.syncedMaps.has(namespace)) {
            const map = new SyncedMap<T>(this as any, namespace, {
                serialize: (val: T) => encodeValue(val),
                deserialize: (bytes: Uint8Array) => {
                    const decoder = new TextDecoder();
                    return JSON.parse(decoder.decode(bytes));
                }
            });
            this.syncedMaps.set(namespace, map);
        }
        return this.syncedMaps.get(namespace)!;
    }

    /**
     * Queues an operation for later sending.
     */
    private queueOperation(key: string, value: unknown, timestamp: number): void {
        // Check queue size limit
        if (this.config.maxQueueSize > 0 && this.operationQueue.length >= this.config.maxQueueSize) {
            // Drop oldest operation (FIFO)
            const dropped = this.operationQueue.shift();
            this.warn(`Queue full, dropping oldest operation: ${dropped?.key} `);
        }

        this.operationQueue.push({ key, value, timestamp });
        this.saveQueue();
        this.notifyQueueListeners();
        this.log(`Queued operation: ${key} (queue size: ${this.operationQueue.length})`);
    }

    /**
     * Subscribes to incoming messages.
     *
     * @param handler - Function to call when a message is received
     * @returns A cleanup function to unsubscribe
     */
    onMessage(handler: MessageHandler): () => void {
        if (typeof handler !== 'function') {
            throw new ConfigurationError('Message handler must be a function');
        }

        this.messageListeners.add(handler);
        return () => {
            this.messageListeners.delete(handler);
        };
    }

    /**
     * Compatibility event emitter interface.
     * Maps 'ephemeral' to onBroadcast and 'presence' to onPresence.
     * @internal
     */
    on(event: string, handler: any): () => void {
        if (event === 'ephemeral') return this.onBroadcast(handler);
        if (event === 'presence') return this.onPresence(handler);
        if (event === 'status') return this.onStatusChange(handler);
        if (event === 'message') return this.onMessage(handler);
        return () => { };
    }

    /**
     * Subscribes to connection status changes.
     *
     * The handler is called immediately with the current status.
     *
     * @param handler - Function to call when status changes
     * @returns A cleanup function to unsubscribe
     */
    /**
     * Subscribes to ephemeral broadcasts.
     */
    onBroadcast(handler: EphemeralHandler): () => void {
        if (typeof handler !== 'function') {
            throw new ConfigurationError('Broadcast handler must be a function');
        }
        this.ephemeralListeners.add(handler);
        return () => {
            this.ephemeralListeners.delete(handler);
        };
    }

    /**
     * Subscribes to presence updates.
     */
    onPresence(handler: PresenceHandler): () => void {
        if (typeof handler !== 'function') {
            throw new ConfigurationError('Presence handler must be a function');
        }
        this.presenceListeners.add(handler);
        return () => {
            this.presenceListeners.delete(handler);
        };
    }

    onStatusChange(handler: StatusHandler): () => void {
        if (typeof handler !== 'function') {
            throw new ConfigurationError('Status handler must be a function');
        }

        this.statusListeners.add(handler);
        // Immediately call with current status
        try {
            handler(this.status);
        } catch (error) {
            this.warn('Status handler threw an error:', error);
        }
        return () => {
            this.statusListeners.delete(handler);
        };
    }

    /**
     * Gets the current connection status.
     */
    getStatus(): ConnectionStatus {
        return this.status;
    }

    /**
     * Gets the number of operations in the queue.
     */
    getQueueSize(): number {
        return this.operationQueue.length;
    }

    /**
     * Disconnects from the server.
     *
     * After calling this, you can call `connect()` again to reconnect.
     */
    disconnect(): void {
        this.log('Disconnecting');

        // Cancel any pending reconnection
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        this.cleanupConnection();
        this.setStatus('DISCONNECTED');
    }

    /**
     * Alias for disconnect() for API consistency.
     */
    close(): void {
        this.disconnect();
    }

    /**
     * Subscribe to queue size changes.
     */
    onQueueChange(handler: (size: number) => void): () => void {
        this.queueListeners.add(handler);
        handler(this.operationQueue.length);
        return () => {
            this.queueListeners.delete(handler);
        };
    }

    private notifyQueueListeners(): void {
        const size = this.operationQueue.length;
        for (const handler of this.queueListeners) {
            try {
                handler(size);
            } catch (e) {
                this.warn("Queue listener error", e);
            }
        }
    }



    private async loadQueue(): Promise<void> {
        try {
            const items = await dbLoadQueue(this.config.workspaceId);

            if (items && items.length > 0) {
                // Prepend loaded items to preserve order (oldest first)
                this.operationQueue = [...items, ...this.operationQueue];
                this.notifyQueueListeners();
                this.log(`Loaded ${items.length} operations from IndexedDB`);
            }
        } catch (e) {
            this.warn("Failed to load queue from IndexedDB", e);
        }
    }

    private saveQueue(): void {
        dbSaveQueue(this.config.workspaceId, this.operationQueue).catch((e: unknown) => {
            this.warn("Failed to save queue to IndexedDB", e);
        });
    }



    destroy(): void {
        this.disconnect();
        this.isDestroyed = true;
        this.preConnectState = {};
        this.operationQueue = [];
        this.core = null;
    }

    async getPresence(): Promise<unknown> {
        const base = this.config.serverUrl.replace(/\/+$/, '').replace(/^ws/, 'http');
        const encodedWorkspace = encodeURIComponent(this.config.workspaceId);
        const url = `${base}/v1/presence/${encodedWorkspace}`;

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.config.token}`,
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch presence: ${response.statusText}`);
        }

        return response.json();
    }
}
