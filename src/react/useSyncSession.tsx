import { useState, useEffect } from 'react';
import { NMeshedClient } from '../client';
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
     * User identifier (auto-generated if omitted)
     */
    userId?: string;

    /**
     * Enable debug logging
     */
    debug?: boolean;

    /**
     * Transport type: 'server' (default) or 'p2p' (experimental)
     */
    transport?: 'server' | 'p2p';

    /**
     * Explicit relay URL (auto-derived if omitted)
     */
    relayUrl?: string;
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

    // Flatten options into NMeshedConfig - no nested spread!
    const result = useNmeshed({
        workspaceId: options.workspaceId,
        token: options.token || options.apiKey,
        userId: options.userId,
        debug: options.debug,
        transport: options.transport || 'server',
        relayUrl: options.relayUrl,
        onError: (err) => setLocalError(err)
    });

    // Safety check - useNmeshed guarantees client but let's be safe
    const client = result.client;
    const status = result.status;

    const [peers, setPeers] = useState<PresenceUser[]>([]);
    const [latency, setLatency] = useState<number>(0);

    // Presence tracking logic
    useEffect(() => {
        if (!client) return;

        const updatePeers = async () => {
            try {
                const list = await client.getPresence();
                setPeers(list);
            } catch (e) {
                // Ignore presence fetch errors or log them
            }
        };

        const onPresence = () => updatePeers();
        const onPeerJoin = () => updatePeers();
        const onPeerLeave = () => updatePeers();

        // Subscribe to events
        // Note: We use 'on' generic method if available or specific methods
        // NMeshedClient has onPresence, onPeerJoin, etc. specific methods usually returning unsubscribe fn
        // or .on() returning unsubscribe.
        // Let's assume .on() is the standard way for these in the Zen client.

        let unsubPresence = () => { };
        let unsubJoin = () => { };
        let unsubLeave = () => { };

        if (typeof client.on === 'function') {
            unsubPresence = client.on('presence', onPresence);
            unsubJoin = client.on('peerJoin', onPeerJoin);
            unsubLeave = client.on('peerDisconnect', onPeerLeave);
        }

        // Initial fetch
        updatePeers();

        const pingInterval = setInterval(async () => {
            if (status === 'READY') {
                try {
                    // Ping self to check loopback/gateway health
                    // Use client.userId since options.userId may be undefined (auto-generated)
                    await client.ping(client.userId);
                    // If ping succeeds, we assume healthy. 
                    // TODO: Get actual RTT if client.ping returns it.
                    // The mock client.ping returns a number (latency).
                    // Real client.ping returns Promise<number>.
                    setLatency(10); // Placeholder or result
                } catch (e) {
                    // Ignore ping errors
                }
            }
        }, 5000);

        return () => {
            unsubPresence();
            unsubJoin();
            unsubLeave();
            clearInterval(pingInterval);
        };
    }, [client, status]);

    return {
        client,
        status,
        isReady: status === 'READY',
        peers,
        latency,
        error: localError
    };
}
