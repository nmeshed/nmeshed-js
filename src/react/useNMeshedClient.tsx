/**
 * useNMeshedClient Hook
 * 
 * Provides direct access to the NMeshedClient instance from context.
 * This is the "raw client" access for advanced use cases.
 * 
 * @example
 * ```tsx
 * function MyComponent() {
 *   const client = useNMeshedClient();
 *   
 *   const handleSave = async () => {
 *     await client.set('document', myData);
 *   };
 *   
 *   return <button onClick={handleSave}>Save</button>;
 * }
 * ```
 */

import { useContext } from 'react';
import { NMeshedContext } from './context';
import { NMeshedClient } from '../client';

/**
 * Access the raw NMeshed client for advanced use cases.
 * 
 * Use this when you need direct client methods not exposed
 * by higher-level hooks like useStore or useDocument.
 * 
 * @returns The NMeshedClient instance
 * @throws Error if used outside NMeshedProvider
 * 
 * @example Basic usage
 * ```tsx
 * const client = useNMeshedClient();
 * client.set('key', value);
 * ```
 * 
 * @example With status check
 * ```tsx
 * const client = useNMeshedClient();
 * const isLive = client.getStatus() === 'READY';
 * ```
 */
export function useNMeshedClient(): NMeshedClient {
    const context = useContext(NMeshedContext);

    if (!context) {
        throw new Error(
            'useNMeshedClient must be used within an NMeshedProvider. ' +
            'Wrap your component tree with <NMeshedProvider>.'
        );
    }

    return context.client;
}

/**
 * Safely access the NMeshed client, returning null if outside provider.
 * 
 * Use this when you're building a library component that may or may
 * not be used within an nMeshed context.
 * 
 * @returns The NMeshedClient instance or null
 */
export function useOptionalNMeshedClient(): NMeshedClient | null {
    const context = useContext(NMeshedContext);
    return context?.client ?? null;
}
