import { useState } from 'react';
import { NMeshedClient } from '../client';
import { CallbackAuthProvider, AuthProvider } from '../auth/AuthProvider';
import { usePeers } from './usePeers';
import type { ConnectionStatus, PresenceUser } from '../types';
import { useNmeshed } from './useNmeshed';
// import { usePresence } from './usePresence'; // Not used in this implementation

/**
 * Simplified options for useSyncSession hook.
 * 
 * Zen Principle: If a config option can be derived, derive it.
 * - serverUrl: Auto-derived from workspaceId + environment
 * - userId: Auto-generated if not provided
 */
export interface SyncSessionOptions {
    /**
     * Workspace ID to connect to (required)
     */
    workspaceId: string;

    /**
     * API Key or token for authentication (one required)
     */
    apiKey?: string;
    token?: string;

    /**
     * Auth provider adapter (e.g., clerkAuth, auth0Auth, supabaseAuth)
     * Takes precedence over getToken if both specified
     */
    auth?: AuthProvider;

    /**
     * Dynamic token provider (e.g., for clerk.session.getToken())
     * @deprecated Use auth adapter instead: auth: clerkAuth({ getToken })
     */
    getToken?: () => Promise<string | null>;

    /**
     * User identifier (auto-generated if omitted)
     */
    userId?: string;

    /**
     * Enable debug logging
     */
    debug?: boolean;

    /**
     * Transport type: 'server' (default)
     */
    transport?: 'server';

    /**
     * Explicit relay URL (auto-derived if omitted)
     */
    /**
     * Explicit relay URL (auto-derived if omitted)
     */
    relayUrl?: string;

    /**
     * Client-side schema registry.
     * 
     * Zen Pattern: "The Laws of Physics" — Define your data shapes once, here.
     * The client will automatically hydrate/dehydrate data matching these prefixes.
     */
    schemas?: Record<string, import('../schema/SchemaBuilder').Schema<any>>;
}

export interface SyncSessionResult {
    /**
     * The underlying NMeshed client instance
     */
    client: NMeshedClient;
    /**
     * Current connection status
     */
    status: ConnectionStatus;
    /**
     * Helper boolean: true if status is 'READY'
     */
    isReady: boolean;
    /**
     * List of currently connected peers
     */
    peers: PresenceUser[];
    /**
     * Estimated one-way latency to the mesh/server
     */
    latency: number;
    /**
     * Error object if connection failed
     */
    error: Error | null;
}

/**
 * React hook for synchronized session management.
 * 
 * Zen API: Minimal config, maximum clarity.
 * 
 * @example Minimal Usage (production)
 * ```tsx
 * const { client, isReady } = useSyncSession({
 *     workspaceId: 'my-workspace',
 *     apiKey: 'nm_live_xxx'
 * });
 * ```
 * 
 * @example Development (localhost auto-detected)
 * ```tsx
 * const { client, isReady } = useSyncSession({
 *     workspaceId: 'my-workspace',
 *     apiKey: 'nm_local_bypass',
 *     debug: true
 * });
 * ```
 */
export function useSyncSession(options: SyncSessionOptions): SyncSessionResult {
    // Local error state since useNmeshed uses callback pattern
    const [localError, setLocalError] = useState<Error | null>(null);

    // Derive auth provider: explicit auth > getToken callback > undefined
    const authProvider = options.auth ?? (options.getToken ? new CallbackAuthProvider(options.getToken) : undefined);

    // Flatten options into NMeshedConfig
    const result = useNmeshed({
        workspaceId: options.workspaceId,
        token: options.token || options.apiKey,
        auth: authProvider,
        userId: options.userId,
        debug: options.debug,
        transport: options.transport || 'server',
        relayUrl: options.relayUrl,
        schemas: options.schemas,
        onError: (err) => setLocalError(err)
    });

    const client = result.client;

    const status = result.status;
    const isReady = status === 'CONNECTED' || status === 'READY';
    const latency = 0; // TODO: Expose latency via context or hook if needed
    const peerIds = usePeers(client);

    // Map string IDs to PresenceUser for backward compatibility
    // In a future version, we might fetch rich presence, but for now we assume online.
    const peers: PresenceUser[] = peerIds.map(id => ({
        userId: id,
        status: 'online',
        latency: 0
    }));

    return {
        client,
        status,
        isReady,
        peers,
        latency,
        error: localError
    };
}
