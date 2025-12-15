import { createContext, useContext, useRef, useEffect, type ReactNode } from 'react';
import { nMeshedClient } from '../client';
import type { nMeshedConfig } from '../types';

/**
 * Context for sharing an nMeshed client across components.
 */
const nMeshedContext = createContext<nMeshedClient | null>(null);

/**
 * Props for nMeshedProvider.
 */
export interface nMeshedProviderProps {
    /**
     * Configuration for the nMeshed client.
     */
    config: nMeshedConfig;

    /**
     * Child components that will have access to the client.
     */
    children: ReactNode;

    /**
     * Whether to automatically connect on mount.
     * @default true
     */
    autoConnect?: boolean;
}

/**
 * Provider component that creates and manages an nMeshed client.
 * 
 * Wrap your app (or a portion of it) with this provider to share
 * a single client instance across multiple components.
 * 
 * @example
 * ```tsx
 * import { nMeshedProvider } from 'nmeshed/react';
 * 
 * function App() {
 *   return (
 *     <nMeshedProvider
 *       config={{
 *         workspaceId: 'my-workspace',
 *         token: 'jwt-token'
 *       }}
 *     >
 *       <MyCollaborativeApp />
 *     </nMeshedProvider>
 *   );
 * }
 * ```
 */
export function nMeshedProvider({
    config,
    children,
    autoConnect = true,
}: nMeshedProviderProps) {
    const clientRef = useRef<nMeshedClient | null>(null);

    // Create client on first render
    if (!clientRef.current) {
        clientRef.current = new nMeshedClient(config);
    }

    useEffect(() => {
        const client = clientRef.current;
        if (!client) return;

        if (autoConnect) {
            client.connect().catch((error) => {
                console.error('[nMeshed] Auto-connect failed:', error);
            });
        }

        return () => {
            client.disconnect();
        };
    }, [autoConnect]);

    return (
        <nMeshedContext.Provider value={clientRef.current}>
            {children}
        </nMeshedContext.Provider>
    );
}

/**
 * Hook to access the nMeshed client from context.
 * 
 * Must be used within an nMeshedProvider.
 * 
 * @returns The nMeshed client instance
 * @throws {Error} If used outside of nMeshedProvider
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
export function useNmeshedContext(): nMeshedClient {
    const client = useContext(nMeshedContext);

    if (!client) {
        throw new Error(
            'useNmeshedContext must be used within an nMeshedProvider. ' +
            'Wrap your component tree with <nMeshedProvider>.'
        );
    }

    return client;
}
