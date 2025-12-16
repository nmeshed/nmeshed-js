import { createContext, useContext, useRef, useEffect, type ReactNode } from 'react';
import { NMeshedClient } from '../client';
import type { NMeshedConfig } from '../types';

/**
 * Context for sharing an nMeshed client across components.
 */
const NMeshedContext = createContext<NMeshedClient | null>(null);

/**
 * Props for NMeshedProvider.
 */
export interface NMeshedProviderProps {
    /**
     * Configuration for the nMeshed client.
     */
    config: NMeshedConfig;

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
 * import { NMeshedProvider } from 'nmeshed/react';
 * 
 * function App() {
 *   return (
 *     <NMeshedProvider
 *       config={{
 *         workspaceId: 'my-workspace',
 *         token: 'jwt-token'
 *       }}
 *     >
 *       <MyCollaborativeApp />
 *     </NMeshedProvider>
 *   );
 * }
 * ```
 */
export function NMeshedProvider({
    config,
    children,
    autoConnect = true,
}: NMeshedProviderProps) {
    const clientRef = useRef<NMeshedClient | null>(null);

    // Create client on first render
    if (!clientRef.current) {
        clientRef.current = new NMeshedClient(config);
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
        <NMeshedContext.Provider value={clientRef.current}>
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
    const client = useContext(NMeshedContext);

    if (!client) {
        throw new Error(
            'useNmeshedContext must be used within an NMeshedProvider. ' +
            'Wrap your component tree with <NMeshedProvider>.'
        );
    }

    return client;
}
