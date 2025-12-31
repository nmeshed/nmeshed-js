/**
 * NMeshed v2 - Type Definitions
 * 
 * The Single Truth: All types in one place.
 * If you need to understand the data model, look here.
 */

// =============================================================================
// Configuration
// =============================================================================

/** Configuration for NMeshed client */
export interface NMeshedConfig {
    /** Workspace/room identifier */
    workspaceId: string;
    /** JWT token for authentication */
    token?: string;
    /** API key (alternative to token) */
    apiKey?: string;
    /** Server URL (defaults to wss://api.nmeshed.com) */
    serverUrl?: string;
    /** User ID (optional, derived from token if not provided) */
    userId?: string;
    /** Enable debug logging */
    debug?: boolean;
}

// =============================================================================
// Connection State
// =============================================================================

/** Connection status states */
export type ConnectionStatus =
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'syncing'
    | 'ready'
    | 'reconnecting'
    | 'error';

/** Connection state with metadata */
export interface ConnectionState {
    status: ConnectionStatus;
    error?: Error;
    retryCount: number;
    lastConnectedAt?: number;
}

// =============================================================================
// CRDT Operations
// =============================================================================

/** A key-value operation */
export interface Operation {
    key: string;
    value: unknown;
    timestamp: number;
    peerId: string;
}

/** Serialized operation for wire transfer */
export interface WireOp {
    key: string;
    payload: Uint8Array;
    timestamp: number;
}

// =============================================================================
// Events
// =============================================================================

/** Event types emitted by the client */
export interface ClientEvents {
    /** Fired when a key's value changes (local or remote) */
    op: (key: string, value: unknown, isLocal: boolean) => void;
    /** Fired when connection status changes */
    status: (status: ConnectionStatus) => void;
    /** Fired on error */
    error: (error: Error) => void;
    /** Fired when a peer joins */
    peerJoin: (peerId: string) => void;
    /** Fired when a peer leaves */
    peerLeave: (peerId: string) => void;
    /** Fired when initial sync completes */
    ready: () => void;
}

/** Type-safe event emitter interface */
export type EventHandler<T extends keyof ClientEvents> = ClientEvents[T];

// =============================================================================
// WASM Core Interface
// =============================================================================

/** Interface for the WASM CRDT core */
export interface CRDTCore {
    /** Apply a local operation, returns delta to broadcast */
    applyLocalOp(key: string, value: Uint8Array): Uint8Array;
    /** Merge a remote delta */
    mergeRemoteDelta(delta: Uint8Array): string | null;
    /** Get value for key */
    getValue(key: string): unknown | undefined;
    /** Get all values */
    getAllValues(): Record<string, unknown>;
    /** Get binary snapshot for sync */
    getBinarySnapshot(): Uint8Array;
    /** Load snapshot */
    loadSnapshot(data: Uint8Array): void;
    /** Iterate over all keys */
    forEach(callback: (value: unknown, key: string) => void): void;
}

// =============================================================================
// Transport Interface
// =============================================================================

/** Interface for network transport */
export interface Transport {
    /** Connect to server */
    connect(): Promise<void>;
    /** Disconnect from server */
    disconnect(): void;
    /** Send binary message */
    send(data: Uint8Array): void;
    /** Register message handler */
    onMessage(handler: (data: Uint8Array) => void): () => void;
    /** Register close handler */
    onClose(handler: () => void): () => void;
    /** Check if connected */
    isConnected(): boolean;
}

// =============================================================================
// Public API Types
// =============================================================================

/** The public NMeshed client interface */
export interface INMeshedClient {
    /** Get a value by key */
    get<T = unknown>(key: string): T | undefined;
    /** Set a key-value pair */
    set<T = unknown>(key: string, value: T): void;
    /** Delete a key */
    delete(key: string): void;
    /** Subscribe to events */
    on<K extends keyof ClientEvents>(event: K, handler: EventHandler<K>): () => void;
    /** Get current connection status */
    getStatus(): ConnectionStatus;
    /** Get client's peer ID */
    getPeerId(): string;
    /** Disconnect and cleanup */
    disconnect(): void;
}
