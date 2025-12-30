import { z } from 'zod';
import { AuthProvider } from './auth/AuthProvider';

/**
 * Configuration options for the nMeshed client.
 */
export interface NMeshedConfig {
    workspaceId: string;
    auth?: AuthProvider;
    token?: string;
    apiKey?: string;
    syncMode?: 'crdt' | 'crdt_performance' | 'crdt_strict' | 'lww';
    userId?: string;
    serverUrl?: string;
    relayUrl?: string; // Preferred over serverUrl
    autoReconnect?: boolean;
    maxReconnectAttempts?: number;
    reconnectBaseDelay?: number;
    maxReconnectDelay?: number;
    connectionTimeout?: number;
    heartbeatInterval?: number;
    heartbeatMaxMissed?: number;
    maxQueueSize?: number;
    debug?: boolean;
    transport?: 'server';
    replicationFactor?: number;
    schemas?: Record<string, import('./schema/SchemaBuilder').Schema<any>>;
}

/**
 * Internal resolved configuration with all defaults applied.
 */
export type ResolvedConfig = Required<NMeshedConfig>;

export const ConfigSchema = z.object({
    workspaceId: z.string().min(1, 'workspaceId is required'),
    token: z.string().optional(),
    apiKey: z.string().optional(),
    syncMode: z.enum(['crdt', 'crdt_performance', 'crdt_strict', 'lww']).optional().default('crdt'),
    userId: z.string().optional(),
    serverUrl: z.string().optional(),
    autoReconnect: z.boolean().optional().default(true),
    maxReconnectAttempts: z.number().int().min(0).optional().default(10),
    reconnectBaseDelay: z.number().int().min(0).optional().default(1000),
    maxReconnectDelay: z.number().int().min(0).optional().default(30000),
    connectionTimeout: z.number().int().min(0).optional().default(10000),
    heartbeatInterval: z.number().int().min(0).optional().default(30000),
    heartbeatMaxMissed: z.number().int().min(1).optional().default(3),
    maxQueueSize: z.number().int().min(0).optional().default(1000),
    debug: z.boolean().optional().default(false),
    transport: z.enum(['server']).optional().default('server'),
    replicationFactor: z.number().int().min(1).optional().default(20)
});

export const DEFAULT_CONFIG: Partial<ResolvedConfig> = {
    syncMode: 'crdt',
    autoReconnect: true,
    maxReconnectAttempts: 10,
    reconnectBaseDelay: 1000,
    maxReconnectDelay: 30000,
    connectionTimeout: 10000,
    heartbeatInterval: 30000,
    heartbeatMaxMissed: 3,
    maxQueueSize: 1000,
    debug: false,
    transport: 'server',
    replicationFactor: 20
};

/**
 * Connection status of the nMeshed client.
 * 
 * Lifecycle: IDLE → CONNECTING → CONNECTED → SYNCING → READY
 * 
 * - SYNCING: WebSocket connected, awaiting initial state snapshot
 * - READY: Initial sync complete, all operations allowed
 */
export type ConnectionStatus =
    | 'IDLE'
    | 'CONNECTING'
    | 'CONNECTED'
    | 'SYNCING'
    | 'READY'
    | 'DISCONNECTED'
    | 'RECONNECTING'
    | 'ERROR';

/**
 * An operation payload sent to or received from the server.
 */
export interface Operation {
    key: string;
    value: unknown;
    timestamp: number;
    isOptimistic?: boolean;
}

/**
 * Initial state message received on connection.
 */
export interface InitMessage {
    type: 'init';
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
    color?: string;
    latency?: number;
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
    from?: string;
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
export type EphemeralHandler = (payload: unknown, from?: string) => void;

/**
 * Handler function for presence updates.
 */
export type PresenceHandler = (user: PresenceMessage['payload']) => void;

// ============================================
//           CHAOS & DIAGNOSTICS
// ============================================

/**
 * Configuration for network simulation (Chaos Mode).
 */
export interface ChaosOptions {
    latency?: number;
    jitter?: number;
    packetLoss?: number;
}
/**
 * Unsubscribe function returned by event listeners.
 */
export type Unsubscribe = () => void;
