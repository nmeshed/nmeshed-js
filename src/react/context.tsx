import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { NMeshedClient } from '../client';
import type { NMeshedConfig, ConnectionStatus } from '../types';

/**
 * Context value shape with connection state exposure.
 */
interface NMeshedContextValue {
    client: NMeshedClient;
    status: ConnectionStatus;
    error: Error | null;
}

/**
 * Context for sharing an nMeshed client across components.
 */
export const NMeshedContext = createContext<NMeshedContextValue | null>(null);

/**
 * Props for NMeshedProvider.
 */
export interface NMeshedProviderProps {
    /**
     * Configuration for the nMeshed client.
     * Required if `client` is not provided.
     */
    config?: NMeshedConfig;

    /**
     * Existing nMeshed client instance.
     * If provided, `config` is ignored.
     */
    client?: NMeshedClient;

    /**
     * Child components that will have access to the client.
     * ...
     */
    children: ReactNode;

    /**
     * Whether to automatically connect on mount.
     * @default true
     */
    autoConnect?: boolean;

    /**
     * Optional callback for connection errors.
     * Called in addition to setting the error state.
     */
    onError?: (error: Error) => void;

    /**
     * Optional callback for status changes.
     */
    onStatusChange?: (status: ConnectionStatus) => void;
}

/**
 * Provider component that creates and manages an nMeshed client.
 *
 * Wrap your app (or a portion of it) with this provider to share
 * a single client instance across multiple components.
 *
 * ## Connection State Exposure
 * Unlike silent failures, this provider exposes connection state
 * and errors to consumers via context. Use `useNmeshedStatus()` to
 * access connection health in child components.
 *
 * @example
 * ```tsx
 * import { NMeshedProvider } from 'nmeshed/react';
 *
 * function App() {
 *   return (
 *     <NMeshedProvider
 *       config={{
 *         workspaceId: 'my-workspace',
 *         token: 'jwt-token'
 *       }}
 *       onError={(err) => console.error('Connection failed:', err)}
 *     >
 *       <MyCollaborativeApp />
 *     </NMeshedProvider>
 *   );
 * }
 * ```
 */
export function NMeshedProvider({
    config,
    client: externalClient,
    children,
    autoConnect = true,
    onError,
    onStatusChange,
}: NMeshedProviderProps) {
    // Reactively manage client instance based on config
    const [clientInstance, setClientInstance] = useState<NMeshedClient>(() => {
        if (externalClient) return externalClient;
        if (!config) throw new Error("NMeshedProvider: Either 'client' or 'config' must be provided.");
        return new NMeshedClient(config);
    });

    // Detect config changes and recreate client (Hot-Swap)
    useEffect(() => {
        if (externalClient) {
            setClientInstance(externalClient);
            return;
        }

        if (config) {
            // Identity check: Only recreate if workspaceId or token changes
            const current = clientInstance.config;
            if (config.workspaceId !== current.workspaceId ||
                (config.token && config.token !== current.token) ||
                (config.apiKey && config.apiKey !== current.apiKey)) {

                // Disconnect old client before switching
                clientInstance.disconnect();

                const newClient = new NMeshedClient(config);
                setClientInstance(newClient);
            }
        }
    }, [config?.workspaceId, config?.token, config?.apiKey, externalClient]); // Deep dependency check

    const client = clientInstance;
    const [status, setStatus] = useState<ConnectionStatus>(client.getStatus());
    const [error, setError] = useState<Error | null>(null);

    // Subscribe to status changes
    useEffect(() => {
        if (!client) return;

        // Sync initial status
        setStatus(client.getStatus());

        const unsubscribe = client.onStatusChange((newStatus) => {
            setStatus(newStatus);
            onStatusChange?.(newStatus); // notify parent

            // Clear error on successful connection
            if (newStatus === 'CONNECTED') {
                setError(null);
            }
        });

        return unsubscribe;
    }, [client]); // Re-subscribe when client instance changes

    // Handle auto-connect with proper error surfacing
    useEffect(() => {
        if (!client || !autoConnect) return;

        // Prevent auto-connect if already connected/connecting
        const s = client.getStatus();
        if (s === 'CONNECTED' || s === 'CONNECTING' || s === 'RECONNECTING') return;

        const performConnect = async () => {
            try {
                await client.connect();
            } catch (err) {
                const connectionError = err instanceof Error
                    ? err
                    : new Error(String(err));

                console.error('[nMeshed] Auto-connect failed:', connectionError);
                setError(connectionError);
                onError?.(connectionError);
            }
        };

        performConnect();

        return () => {
            // Optional: Disconnect on unmount? 
            // Usually desired for a Provider, but check use-cases.
            client.disconnect();
        };
    }, [autoConnect, client]); // Config changes -> New Client -> Auto Connect

    const contextValue: NMeshedContextValue = {
        client,
        status,
        error,
    };

    return (
        <NMeshedContext.Provider value={contextValue}>
            {children}
        </NMeshedContext.Provider>
    );
}

/**
 * Hook to access the nMeshed client from context.
 *
 * Must be used within an NMeshedProvider.
 *
 * @returns The nMeshed client instance
 * @throws {Error} If used outside of NMeshedProvider
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const client = useNmeshedContext();
 *
 *   const handleClick = () => {
 *     client.set('clicked', true);
 *   };
 *
 *   return <button onClick={handleClick}>Click me</button>;
 * }
 * ```
 */
export function useNmeshedContext(): NMeshedClient {
    const context = useContext(NMeshedContext);

    if (!context) {
        throw new Error(
            'useNmeshedContext must be used within an NMeshedProvider. ' +
            'Wrap your component tree with <NMeshedProvider>.'
        );
    }

    return context.client;
}

/**
 * Hook to access connection status and error state.
 *
 * Use this to show connection UI (spinner, error message, etc.)
 * or to conditionally render based on connection health.
 *
 * @returns Object with status and error
 *
 * @example
 * ```tsx
 * function ConnectionIndicator() {
 *   const { status, error } = useNmeshedStatus();
 *
 *   if (status === 'CONNECTING') return <Spinner />;
 *   if (status === 'ERROR') return <ErrorBanner message={error?.message} />;
 *   if (status === 'CONNECTED') return <GreenDot />;
 *   return null;
 * }
 * ```
 */
export function useNmeshedStatus(): { status: ConnectionStatus; error: Error | null } {
    const context = useContext(NMeshedContext);

    if (!context) {
        throw new Error(
            'useNmeshedStatus must be used within an NMeshedProvider. ' +
            'Wrap your component tree with <NMeshedProvider>.'
        );
    }

    return {
        status: context.status,
        error: context.error,
    };
}

/**
 * Hook to access the nMeshed context optionally.
 * Returns null if not within a provider.
 */
export function useOptionalNmeshedContext(): NMeshedContextValue | null {
    return useContext(NMeshedContext);
}
