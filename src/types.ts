/**
 * NMeshed v2 - Type Definitions
 * 
 * The Single Truth: All types in one place.
 * If you need to understand the data model, look here.
 */

import type { EncryptionAdapter } from './encryption';

// =============================================================================
// Configuration
// =============================================================================

import { ZodType, ZodTypeDef } from 'zod';

// =============================================================================
// Configuration
// =============================================================================

/**
 * A Zod-compatible schema definition.
 * We use any ZodType to allow maximum flexibility (objects, arrays, primitives).
 */
export type Schema = ZodType<any, ZodTypeDef, any>;

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
    /** 
     * Registered schemas for strict typing and CRDT inference.
     * Keys here map to store names (e.g. client.store('board')).
     */
    schemas?: Record<string, Schema>;
    /**
     * Custom storage adapter.
     * If not provided, defaults to IndexedDB in browser and InMemory in Node.
     */
    storage?: IStorage;
    /**
     * Enable persistent storage request (navigator.storage.persist).
     * Defaults to true.
     */
    persist?: boolean;
    /**
     * Initial binary snapshot for hydration (RSC/SSR).
     */
    initialSnapshot?: Uint8Array;
    /**
     * End-to-End Encryption Adapter.
     * If provided, all local and remote values will be encrypted.
     */
    encryption?: EncryptionAdapter;
    /**
     * W3C Trace Context (traceparent) for distributed tracing.
     * If not provided, one will be generated for the session.
     */
    traceparent?: string;
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
    timestamp: bigint;
    peerId: string;
}

/** Serialized operation for wire transfer */
export interface WireOp {
    key: string;
    payload: Uint8Array;
    timestamp: bigint;
}

// =============================================================================
// Events
// =============================================================================

/** Event types emitted by the client */
export interface ClientEvents {
    /** Fired when a key's value changes (local or remote) */
    op: (key: string, value: unknown, isLocal: boolean, timestamp?: bigint, isReplay?: boolean, isCAS?: boolean) => void;
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
    /** Fired when a CAS operation needs to be sent to server */
    cas: (wireData: Uint8Array) => void;
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
    /** Force reconnection */
    reconnect(): Promise<void>;
    /** Send binary message */
    send(data: Uint8Array): void;
    /** Register message handler */
    onMessage(handler: (data: Uint8Array) => void): () => void;
    /** Register open handler */
    onOpen(handler: () => void): () => void;
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
    /** 
     * Atomic Compare-And-Swap 
     * Returns true if successful (value matched expected), false otherwise.
     */
    cas<T = unknown>(key: string, expected: T | null, newValue: T): Promise<boolean>;
    /** Subscribe to events */
    on<K extends keyof ClientEvents>(event: K, handler: EventHandler<K>): () => void;
    /** Get current connection status */
    getStatus(): ConnectionStatus;
    /** Get client's peer ID */
    getPeerId(): string;
    /** Disconnect and cleanup */
    /** Disconnect and cleanup */
    disconnect(): void;
    /** Wait for ready state */
    awaitReady(): Promise<void>;
    /** Get a schematic store proxy */
    store<T = any>(key: string): T;
}

// =============================================================================
// Storage Interface
// =============================================================================

/** Interface for persistence adapters (IndexedDB, SQLite, InMemory) */
export interface IStorage {
    /** Initialize storage */
    init(): Promise<void>;
    /** Get value by key */
    get(key: string): Promise<Uint8Array | undefined>;
    /** Set value for key */
    set(key: string, value: Uint8Array): Promise<void>;
    /** Delete key */
    delete(key: string): Promise<void>;
    /** Scan keys with prefix */
    scanPrefix(prefix: string): Promise<Array<[string, Uint8Array]>>;
    /** Clear specific key manually (alias for delete) */
    clear(key: string): Promise<void>;
    /** Clear all data */
    clearAll(): Promise<void>;
    /** Close storage */
    close(): Promise<void>;
}
