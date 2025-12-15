/**
 * Configuration options for the nMeshed client.
 */
interface nMeshedConfig {
    /**
     * The workspace ID to connect to.
     * A workspace is a collaborative room or document.
     * @example 'my-project-123'
     */
    workspaceId: string;
    /**
     * JWT authentication token.
     * Required for production use.
     * Get one from dashboard.nmeshed.com
     */
    token: string;
    /**
     * Optional user identifier for presence tracking.
     * If not provided, a random ID will be generated.
     */
    userId?: string;
    /**
     * WebSocket server URL.
     * Defaults to 'wss://api.nmeshed.com' in production.
     * @default 'wss://api.nmeshed.com'
     */
    serverUrl?: string;
    /**
     * Enable automatic reconnection on disconnect.
     * @default true
     */
    autoReconnect?: boolean;
    /**
     * Maximum number of reconnection attempts.
     * @default 10
     */
    maxReconnectAttempts?: number;
    /**
     * Base delay (in ms) between reconnection attempts.
     * Uses exponential backoff: delay * 2^attempt
     * @default 1000
     */
    reconnectBaseDelay?: number;
    /**
     * Maximum delay (in ms) between reconnection attempts.
     * Caps the exponential backoff to prevent excessive waits.
     * @default 30000
     */
    maxReconnectDelay?: number;
    /**
     * Timeout (in ms) for initial connection.
     * If connection isn't established within this time, it fails.
     * @default 10000
     */
    connectionTimeout?: number;
    /**
     * Interval (in ms) to send heartbeat pings.
     * Set to 0 to disable heartbeats.
     * @default 30000
     */
    heartbeatInterval?: number;
    /**
     * Maximum number of operations to queue while disconnected.
     * When exceeded, oldest operations are dropped (FIFO).
     * Set to 0 for unlimited (not recommended).
     * @default 1000
     */
    maxQueueSize?: number;
    /**
     * Enable debug logging to console.
     * @default false
     */
    debug?: boolean;
}
/**
 * Connection status of the nMeshed client.
 */
type ConnectionStatus = 
/** Initial state before connect() is called */
'IDLE'
/** Connection in progress */
 | 'CONNECTING'
/** Successfully connected to server */
 | 'CONNECTED'
/** Connection closed (may reconnect) */
 | 'DISCONNECTED'
/** Reconnecting after disconnect */
 | 'RECONNECTING'
/** Fatal error, will not reconnect */
 | 'ERROR';
/**
 * An operation payload sent to or received from the server.
 */
interface Operation {
    /** The key being updated */
    key: string;
    /** The new value */
    value: unknown;
    /** Unix microsecond timestamp for conflict resolution */
    timestamp: number;
}
/**
 * Initial state message received on connection.
 */
interface InitMessage {
    type: 'init';
    /** Current state of the workspace as key-value pairs */
    data: Record<string, unknown>;
}
/**
 * Operation message for state updates.
 */
interface OperationMessage {
    type: 'op';
    payload: Operation;
}
/**
 * Presence update message.
 */
interface PresenceMessage {
    type: 'presence';
    users: PresenceUser[];
}
/**
 * A user in the presence list.
 */
interface PresenceUser {
    userId: string;
    status: 'online' | 'idle' | 'offline';
    last_seen?: string;
    metadata?: Record<string, unknown>;
}
/**
 * Union of all possible messages from the server.
 */
type nMeshedMessage = InitMessage | OperationMessage | PresenceMessage;
/**
 * Handler function for incoming messages.
 */
type MessageHandler = (message: nMeshedMessage) => void;
/**
 * Handler function for connection status changes.
 */
type StatusHandler = (status: ConnectionStatus) => void;

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
    * const client = new nMeshedClient({
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
declare class nMeshedClient {
    private readonly config;
    private ws;
    private status;
    private readonly messageListeners;
    private readonly statusListeners;
    private reconnectAttempts;
    private reconnectTimeout;
    private connectionTimeout;
    private heartbeatInterval;
    private operationQueue;
    private currentState;
    private isDestroyed;
    /**
     * Creates a new nMeshed client instance.
     *
     * @param config - Configuration options
     * @throws {ConfigurationError} If workspaceId or token is missing
     */
    constructor(config: nMeshedConfig);
    /**
     * Generates a random user ID using crypto if available, falling back to Math.random.
     */
    private generateUserId;
    /**
     * Logs a debug message if debug mode is enabled.
     */
    private log;
    /**
     * Logs a warning message (always shown).
     */
    private warn;
    /**
     * Updates the connection status and notifies listeners.
     */
    private setStatus;
    /**
     * Builds the WebSocket URL with query parameters.
     */
    private buildUrl;
    /**
     * Connects to the nMeshed server.
     *
     * @returns A promise that resolves when connected, or rejects on error.
     * @throws {ConnectionError} If connection fails or times out
     */
    connect(): Promise<void>;
    /**
     * Clears the connection timeout timer.
     */
    private clearConnectionTimeout;
    /**
     * Starts the heartbeat interval to detect dead connections.
     */
    private startHeartbeat;
    /**
     * Stops the heartbeat interval.
     */
    private stopHeartbeat;
    /**
     * Handles incoming messages from the server.
     */
    private handleMessage;
    /**
     * Handles disconnection and initiates reconnection if configured.
     */
    private handleDisconnect;
    /**
     * Cleans up the current connection without changing status.
     */
    private cleanupConnection;
    /**
     * Schedules a reconnection attempt with capped exponential backoff.
     */
    private scheduleReconnect;
    /**
     * Flushes any operations queued while disconnected.
     */
    private flushOperationQueue;
    /**
     * Sets a key-value pair in the workspace.
     *
     * @param key - The key to set (must be non-empty string)
     * @param value - The value to set
     * @throws {ConfigurationError} If key is invalid
     */
    set(key: string, value: unknown): void;
    /**
     * Gets the current value of a key from local state.
     *
     * Note: This returns the locally cached state, which may be
     * momentarily out of sync with the server.
     *
     * @param key - The key to get
     * @returns The value, or undefined if not found
     */
    get<T = unknown>(key: string): T | undefined;
    /**
     * Gets the entire current state of the workspace.
     *
     * @returns A shallow copy of the current state
     */
    getState(): Record<string, unknown>;
    /**
     * Sends an operation to update a key-value pair.
     *
     * If not connected, the operation is queued and sent when reconnected.
     *
     * @param key - The key to update
     * @param value - The new value
     */
    sendOperation(key: string, value: unknown): void;
    /**
     * Internal method to send an operation (assumes connection is open).
     */
    private sendOperationInternal;
    /**
     * Queues an operation for later sending.
     */
    private queueOperation;
    /**
     * Subscribes to incoming messages.
     *
     * @param handler - Function to call when a message is received
     * @returns A cleanup function to unsubscribe
     */
    onMessage(handler: MessageHandler): () => void;
    /**
     * Subscribes to connection status changes.
     *
     * The handler is called immediately with the current status.
     *
     * @param handler - Function to call when status changes
     * @returns A cleanup function to unsubscribe
     */
    onStatusChange(handler: StatusHandler): () => void;
    /**
     * Gets the current connection status.
     */
    getStatus(): ConnectionStatus;
    /**
     * Gets the number of operations in the queue.
     */
    getQueueSize(): number;
    /**
     * Disconnects from the server.
     *
     * After calling this, you can call `connect()` again to reconnect.
     */
    disconnect(): void;
    /**
     * Alias for disconnect() for API consistency.
     */
    close(): void;
    /**
     * Helper to convert WebSocket URL to HTTP URL.
     */
    private getHttpUrl;
    /**
     * Fetches current presence information for the workspace.
     *
     * @returns A promise resolving to a list of active users.
     */
    getPresence(): Promise<Array<{
        userId: string;
        status: 'online' | 'idle' | 'offline';
        last_seen?: string;
        metadata?: Record<string, unknown>;
    }>>;
    /**
     * Permanently destroys the client, releasing all resources.
     *
     * After calling this, the client cannot be reconnected.
     * Use this for cleanup in React useEffect or similar.
     */
    destroy(): void;
}

export { type ConnectionStatus as C, type InitMessage as I, type MessageHandler as M, type Operation as O, type PresenceUser as P, type StatusHandler as S, nMeshedClient as a, type nMeshedConfig as b, type OperationMessage as c, type nMeshedMessage as n };
