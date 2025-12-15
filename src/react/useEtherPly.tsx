import { useState, useEffect, useRef, useCallback } from 'react';
import { EtherPlyClient } from '../client';
import type { EtherPlyConfig, ConnectionStatus, EtherPlyMessage } from '../types';

/**
 * Options for the useEtherPly hook.
 */
export interface UseEtherPlyOptions extends EtherPlyConfig {
    /**
     * Callback when connected.
     */
    onConnect?: () => void;

    /**
     * Callback when disconnected.
     */
    onDisconnect?: () => void;

    /**
     * Callback when an error occurs.
     */
    onError?: (error: Error) => void;
}

/**
 * Return value of the useEtherPly hook.
 */
export interface UseEtherPlyReturn {
    /**
     * Current state of the workspace as a reactive object.
     */
    state: Record<string, unknown>;

    /**
     * Set a value in the workspace.
     */
    set: (key: string, value: unknown) => void;

    /**
     * Get a value from the workspace.
     */
    get: <T = unknown>(key: string) => T | undefined;

    /**
     * Current connection status.
     */
    status: ConnectionStatus;

    /**
     * Whether the client is connected.
     */
    isConnected: boolean;

    /**
     * The underlying EtherPly client instance.
     */
    client: EtherPlyClient;

    /**
     * Manually connect to the server.
     */
    connect: () => Promise<void>;

    /**
     * Manually disconnect from the server.
     */
    disconnect: () => void;
}

/**
 * React hook for real-time synchronization with EtherPly.
 * 
 * This hook creates and manages an EtherPly client, provides reactive
 * state, and handles connection lifecycle automatically.
 * 
 * @param options - Configuration and callbacks
 * @returns Object with state, setters, and connection status
 * 
 * @example Basic Usage
 * ```tsx
 * function CollaborativeEditor() {
 *   const { state, set, status } = useEtherPly({
 *     workspaceId: 'my-doc',
 *     token: 'jwt-token'
 *   });
 *   
 *   return (
 *     <div>
 *       <p>Status: {status}</p>
 *       <textarea
 *         value={state.content as string || ''}
 *         onChange={(e) => set('content', e.target.value)}
 *       />
 *     </div>
 *   );
 * }
 * ```
 * 
 * @example With Callbacks
 * ```tsx
 * const { state, set } = useEtherPly({
 *   workspaceId: 'my-doc',
 *   token: 'jwt-token',
 *   onConnect: () => console.log('Connected!'),
 *   onDisconnect: () => console.log('Disconnected'),
 *   onError: (err) => console.error('Error:', err)
 * });
 * ```
 */
export function useEtherPly(options: UseEtherPlyOptions): UseEtherPlyReturn {
    const { onConnect, onDisconnect, onError, ...config } = options;

    // Create client once
    const clientRef = useRef<EtherPlyClient | null>(null);
    if (!clientRef.current) {
        clientRef.current = new EtherPlyClient(config);
    }
    const client = clientRef.current;

    // Reactive state
    const [state, setState] = useState<Record<string, unknown>>({});
    const [status, setStatus] = useState<ConnectionStatus>('IDLE');

    // Connect on mount
    useEffect(() => {
        const currentClient = client;

        // Subscribe to status changes
        const unsubscribeStatus = currentClient.onStatusChange((newStatus) => {
            setStatus(newStatus);

            if (newStatus === 'CONNECTED') {
                onConnect?.();
            } else if (newStatus === 'DISCONNECTED') {
                onDisconnect?.();
            } else if (newStatus === 'ERROR') {
                onError?.(new Error('Connection error'));
            }
        });

        // Subscribe to messages
        const unsubscribeMessage = currentClient.onMessage((message: EtherPlyMessage) => {
            if (message.type === 'init') {
                setState(message.data);
            } else if (message.type === 'op') {
                setState((prev) => ({
                    ...prev,
                    [message.payload.key]: message.payload.value,
                }));
            }
        });

        // Connect
        currentClient.connect().catch((error) => {
            onError?.(error);
        });

        // Cleanup
        return () => {
            unsubscribeStatus();
            unsubscribeMessage();
            currentClient.disconnect();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // Only run on mount

    // Memoized setters
    const set = useCallback((key: string, value: unknown) => {
        client.set(key, value);
        // Optimistic update
        setState((prev) => ({ ...prev, [key]: value }));
    }, [client]);

    const get = useCallback(<T = unknown>(key: string): T | undefined => {
        return state[key] as T | undefined;
    }, [state]);

    const connect = useCallback(() => client.connect(), [client]);
    const disconnect = useCallback(() => client.disconnect(), [client]);

    return {
        state,
        set,
        get,
        status,
        isConnected: status === 'CONNECTED',
        client,
        connect,
        disconnect,
    };
}
