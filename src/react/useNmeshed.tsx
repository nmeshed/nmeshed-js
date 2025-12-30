import { useState, useEffect, useRef, useCallback } from 'react';
import { NMeshedClient } from '../client';
import type { NMeshedConfig, ConnectionStatus, NMeshedMessage } from '../types';

/**
 * Options for the useNmeshed hook.
 */
export interface UseNmeshedOptions extends NMeshedConfig {
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
 * Return value of the useNmeshed hook.
 */
export interface UseNmeshedReturn {
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
     * The underlying nMeshed client instance.
     */
    client: NMeshedClient;

    /**
     * Manually connect to the server.
     */
    connect: () => Promise<void>;

    /**
     * Manually disconnect from the server.
     */
    disconnect: () => void;

    /**
     * Number of queued operations.
     */
    queueSize: number;
}

/**
 * React hook for real-time synchronization with nMeshed.
 * 
 * This hook creates and manages an nMeshed client, provides reactive
 * state, and handles connection lifecycle automatically.
 * 
 * @param options - Configuration and callbacks
 * @returns Object with state, setters, and connection status
 * 
 * @example Basic Usage
 * ```tsx
 * function CollaborativeEditor() {
 *   const { state, set, status } = useNmeshed({
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
 * const { state, set } = useNmeshed({
 *   workspaceId: 'my-doc',
 *   token: 'jwt-token',
 *   onConnect: () => console.log('Connected!'),
 *   onDisconnect: () => console.log('Disconnected'),
 *   onError: (err) => console.error('Error:', err)
 * });
 * ```
 */
export function useNmeshed(options: UseNmeshedOptions): UseNmeshedReturn {
    const { onConnect, onDisconnect, onError, ...config } = options;

    // Create client once
    const clientRef = useRef<NMeshedClient | null>(null);
    if (!clientRef.current) {
        clientRef.current = new NMeshedClient(config);
    }
    const client = clientRef.current;

    // Reactive state
    const [state, setState] = useState<Record<string, unknown>>({});
    const [status, setStatus] = useState<ConnectionStatus>('IDLE');
    const [queueSize, setQueueSize] = useState(0);

    // Connect on mount
    useEffect(() => {
        let isMounted = true;
        const currentClient = client;

        // Subscribe to status changes
        const unsubscribeStatus = currentClient.onStatusChange((newStatus) => {
            if (isMounted) setStatus(newStatus);
        });

        // Effect for callbacks to ensure they see the updated state
        // (Handled by the dependency array of another useEffect or just split it)

        // Subscribe to queue changes
        const unsubscribeQueue = currentClient.onQueueChange((size) => {
            if (isMounted) setQueueSize(size);
        });

        // Subscribe to messages
        const unsubscribeMessage = currentClient.onMessage((message: NMeshedMessage) => {
            if (!isMounted) return;
            if (message.type === 'init') {
                setState(message.data);
            } else if (message.type === 'op') {
                setState((prev) => ({
                    ...prev,
                    [message.payload.key]: message.payload.value,
                }));
            }
        });

        // Subscribe to errors
        const unsubscribeError = currentClient.on('error', (err) => {
            if (isMounted) onError?.(err instanceof Error ? err : new Error(String(err)));
        });

        // Connect
        currentClient.connect().catch((error) => {
            if (isMounted) onError?.(error);
        });

        // Cleanup
        return () => {
            isMounted = false;
            unsubscribeStatus();
            unsubscribeQueue();
            unsubscribeMessage();
            unsubscribeError();
            currentClient.disconnect();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // Only run on mount

    // Standalone effect for callbacks to ensure they always see updated 'status'
    const lastNotifiedStatus = useRef<ConnectionStatus | null>(null);
    useEffect(() => {
        if (status === lastNotifiedStatus.current) return;
        lastNotifiedStatus.current = status;

        if (status === 'READY') {
            onConnect?.();
        } else if (status === 'DISCONNECTED') {
            onDisconnect?.();
        } else if (status === 'ERROR') {
            onError?.(new Error('Connection error'));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status, onConnect, onDisconnect, onError]);

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
        isConnected: status === 'CONNECTED' || status === 'SYNCING' || status === 'READY',
        client,
        connect,
        disconnect,
        queueSize,
    };
}
