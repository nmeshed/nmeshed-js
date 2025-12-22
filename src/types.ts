/**
 * Configuration options for the nMeshed client.
 */
export interface NMeshedConfig {
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
     * Synchronization strategy.
     * - 'crdt': (Default) Collaborative document editing (Automerge). Strong consistency.
     * - 'crdt_performance': Optimized CRDT for high-frequency updates (Games). Relaxed durability.
     * - 'crdt_strict': Immediate fsync for critical data (Financial). Highest durability.
     * - 'lww': Real-time ephemeral data (cursors, gaming). Last-Write-Wins.
     */
    syncMode?: 'crdt' | 'crdt_performance' | 'crdt_strict' | 'lww';

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
export type ConnectionStatus =
    /** Initial state before connect() is called */
    | 'IDLE'
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
export interface Operation {
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
export interface InitMessage {
    type: 'init';
    /** Current state of the workspace as key-value pairs */
    data: Record<string, unknown>;
}

/**
 * Operation message for state updates.
 */
export interface OperationMessage {
    type: 'op';
    payload: Operation;
}

/**
 * A user in the presence list.
 */
export interface PresenceUser {
    userId: string;
    status: 'online' | 'idle' | 'offline';
    last_seen?: string;
    metadata?: Record<string, unknown>;
}

/**
 * Presence update message (single user event).
 */
export interface PresenceMessage {
    type: 'presence';
    payload: PresenceUser;
}

/**
 * Ephemeral message (broadcast-only, not persisted).
 */
export interface EphemeralMessage {
    type: 'ephemeral';
    payload: unknown;
}

/**
 * Union of all possible messages from the server.
 */
export type NMeshedMessage = InitMessage | OperationMessage | PresenceMessage | EphemeralMessage;

/**
 * Handler function for incoming messages.
 */
export type MessageHandler = (message: NMeshedMessage) => void;

/**
 * Handler function for connection status changes.
 */
export type StatusHandler = (status: ConnectionStatus) => void;

/**
 * Handler function for ephemeral broadcast messages.
 */
export type EphemeralHandler = (payload: unknown) => void;

/**
 * Handler function for presence updates.
 */
export type PresenceHandler = (user: PresenceMessage['payload']) => void;

/**
 * Internal resolved configuration with all defaults applied.
 */
export type ResolvedConfig = Required<NMeshedConfig>;
