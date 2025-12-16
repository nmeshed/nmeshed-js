import type {
    NMeshedConfig,
    ConnectionStatus,
    MessageHandler,
    StatusHandler,
    EphemeralHandler,
    PresenceHandler,
    ResolvedConfig,
} from './types';
import {
    ConfigurationError,
    ConnectionError,
} from './errors';
import { parseMessage, truncate } from './validation';
import { z } from 'zod';

/**
 * Configuration schema for validation.
 */
const ConfigSchema = z.object({
    workspaceId: z.string().min(1, 'workspaceId is required and must be a non-empty string'),
    token: z.string().min(1, 'token is required and must be a non-empty string'),
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
});


/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: Omit<ResolvedConfig, 'workspaceId' | 'token' | 'userId'> = {
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
    private reconnectAttempts = 0;
    private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    private connectionTimeout: ReturnType<typeof setTimeout> | null = null;
    private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    private operationQueue: QueuedOperation[] = [];
    private currentState: Record<string, unknown> = {};
    private isDestroyed = false;

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
            userId: validConfig.userId?.trim() || this.generateUserId(),
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
    }

    /**
     * Generates a random user ID using crypto if available, falling back to Math.random.
     */
    private generateUserId(): string {
        // Try crypto API first (more random)
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return `user - ${crypto.randomUUID().substring(0, 8)} `;
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
        const base = this.config.serverUrl.replace(/\/+$/, '');
        const params = new URLSearchParams({
            token: this.config.token,
            userId: this.config.userId,
        });
        // Encode workspaceId to handle special characters
        const encodedWorkspace = encodeURIComponent(this.config.workspaceId);
        return `${base} /v1/sync / ${encodedWorkspace}?${params.toString()} `;
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
                if (event.data instanceof ArrayBuffer) {
                    // Fast Path: Dispatch raw binary to ephemeral listeners
                    // We treat all binary as "ephemeral" for now to bypass JSON parsing overhead
                    const listeners = Array.from(this.ephemeralListeners);
                    for (const listener of listeners) {
                        try {
                            listener(event.data);
                        } catch (error) {
                            this.warn('Binary listener threw error:', error);
                        }
                    }
                } else {
                    // Slow Path: Text/JSON
                    this.handleMessage(event.data);
                }
            };
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
                    // Send a ping message
                    // Note: Browser WebSocket doesn't expose ping(), so we send a custom message
                    this.ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
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
     * Handles incoming messages from the server.
     */
    private handleMessage(data: string): void {
        try {
            const message = parseMessage(data);
            this.log('Received:', message.type);

            // Update local state cache
            if (message.type === 'init') {
                this.currentState = { ...message.data };
            } else if (message.type === 'op') {
                this.currentState[message.payload.key] = message.payload.value;
            } else if (message.type === 'ephemeral') {
                // Dispatch to ephemeral listeners
                const listeners = Array.from(this.ephemeralListeners);
                for (const listener of listeners) {
                    try {
                        listener(message.payload);
                    } catch (error) {
                        this.warn('Ephemeral listener threw an error:', error);
                    }
                }
            } else if (message.type === 'presence') {
                // Dispatch to presence listeners
                const listeners = Array.from(this.presenceListeners);
                for (const listener of listeners) {
                    try {
                        listener(message.payload);
                    } catch (error) {
                        this.warn('Presence listener threw an error:', error);
                    }
                }
            }
            // Ignore pong messages (heartbeat responses)

            // Notify generic listeners
            const listeners = Array.from(this.messageListeners);
            for (const listener of listeners) {
                try {
                    listener(message);
                } catch (error) {
                    this.warn('Message listener threw an error:', error);
                }
            }
        } catch (error) {
            // Log but don't crash on malformed messages
            this.warn('Failed to parse message:', truncate(data), error);
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

        for (const op of queueToProcess) {
            this.sendOperationInternal(op.key, op.value, op.timestamp);
        }
    }

    /**
     * Sets a key-value pair in the workspace.
     *
     * @param key - The key to set (must be non-empty string)
     * @param value - The value to set
     * @throws {ConfigurationError} If key is invalid
     */
    set(key: string, value: unknown): void {
        if (!key || typeof key !== 'string') {
            throw new ConfigurationError('Key must be a non-empty string');
        }
        this.sendOperation(key, value);
    }

    /**
     * Gets the current value of a key from local state.
     *
     * Note: This returns the locally cached state, which may be
     * momentarily out of sync with the server.
     *
     * @param key - The key to get
     * @returns The value, or undefined if not found
     */
    get<T = unknown>(key: string): T | undefined {
        return this.currentState[key] as T | undefined;
    }

    /**
     * Gets the entire current state of the workspace.
     *
     * @returns A shallow copy of the current state
     */
    getState(): Record<string, unknown> {
        return { ...this.currentState };
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

        // Optimistic local update
        this.currentState[key] = value;

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
        if (this.ws?.readyState !== WebSocket.OPEN) {
            this.warn('Cannot broadcast: not connected');
            return;
        }

        try {
            // Binary Path (Fast Lane)
            if (payload instanceof ArrayBuffer || payload instanceof Uint8Array) {
                this.ws.send(payload);
                return;
            }

            // JSON Path (Slow Lane)
            const message = JSON.stringify({
                type: 'ephemeral',
                payload
            });
            this.ws.send(message);
        } catch (error) {
            this.warn('Failed to broadcast message:', error);
        }
    }

    /**
     * Internal method to send an operation (assumes connection is open).
     */
    private sendOperationInternal(key: string, value: unknown, timestamp: number): void {
        if (this.ws?.readyState !== WebSocket.OPEN) {
            this.queueOperation(key, value, timestamp);
            return;
        }

        let message: string;
        try {
            message = JSON.stringify({
                type: 'op',
                payload: { key, value, timestamp },
            });
        } catch (error) {
            this.warn('Failed to serialize operation, dropping:', error);
            // Do NOT queue un-serializable operations, as they will never succeed
            return;
        }

        try {
            this.ws.send(message);
            this.log('Sent operation:', key);
        } catch (error) {
            this.warn('Failed to send operation:', error);
            // Re-queue the operation only if sending failed (network issue), not serialization
            this.queueOperation(key, value, timestamp);
        }
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
     * Helper to convert WebSocket URL to HTTP URL.
     */
    private getHttpUrl(path: string): string {
        try {
            const url = new URL(this.config.serverUrl);
            url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
            const base = url.toString().replace(/\/+$/, '');
            return `${base}${path}`;
        } catch (e) {
            // Fallback if URL parsing fails
            const base = this.config.serverUrl
                .replace(/^wss:\/\//, 'https://')
                .replace(/^ws:\/\//, 'http://')
                .replace(/\/+$/, '');
            return `${base}${path}`;
        }
    }

    /**
     * Fetches current presence information for the workspace.
     * 
     * @returns A promise resolving to a list of active users.
     */
    // Updated to match PresenceUser type in types.ts (with optional last_seen)
    async getPresence(): Promise<Array<{ userId: string; status: 'online' | 'idle' | 'offline'; last_seen?: string; metadata?: Record<string, unknown> }>> {
        const url = this.getHttpUrl(`/v1/presence/${this.config.workspaceId}`);

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.config.token}`
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch presence: ${response.statusText}`);
        }

        return response.json();
    }

    /**
     * Permanently destroys the client, releasing all resources.
     * 
     * After calling this, the client cannot be reconnected.
     * Use this for cleanup in React useEffect or similar.
     */
    destroy(): void {
        this.log('Destroying client');
        this.disconnect();
        this.messageListeners.clear();
        this.statusListeners.clear();
        this.ephemeralListeners.clear();
        this.presenceListeners.clear();
        this.operationQueue = [];
        this.currentState = {};
        this.isDestroyed = true;
    }
}
