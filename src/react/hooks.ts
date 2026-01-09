/**
 * @module ReactHooks
 * @description
 * High-Level React Hooks for the "Zen" Developer Experience.
 */

import { useState, useEffect, useMemo, useCallback, useSyncExternalStore } from 'react';
import { useNMeshed } from './context';

/**
 * **The Facade Hook (Recommended)**
 * 
 * Returns a reactive Proxy object for a given key.
 * Accessing properties on this object reads from the local store.
 * Setting properties on this object automatically syncs to the network.
 * 
 * @remarks
 * Uses `useSyncExternalStore` ensuring **Tearing-Free Rendering** during concurrent React updates.
 * 
 * @param key - The unique key in the global store.
 * @returns A reactive proxy object of type T.
 * 
 * @example
 * ```tsx
 * const todo = useSyncedStore<Todo>('todo_1');
 * 
 * return (
 *   <div onClick={() => todo.done = !todo.done}>
 *     {todo.text}
 *   </div>
 * );
 * ```
 */
export function useSyncedStore<T extends object>(key: string): T {
    const { client } = useNMeshed();

    if (!client) {
        throw new Error('useSyncedStore must be used within NMeshedProvider');
    }

    // Stable subscription function for useSyncExternalStore
    const subscribe = useMemo(() => {
        return (callback: () => void) => client.subscribe(key, callback);
    }, [client, key]);

    // Stable snapshot getter
    const getSnapshot = useCallback(() => {
        return client.get<T>(key);
    }, [client, key]);

    // TEARING-FREE SUBSCRIPTION
    // This hook forces a re-render whenever the key's value changes in the engine.
    const rawValue = useSyncExternalStore(
        subscribe,
        getSnapshot,
        getSnapshot // server snapshot (SSR)
    );

    // Proxy Creation
    // We wrap the engine access in a Proxy to allow intuitive mutation (state.foo = bar).
    // The Proxy does not hold data; it forwards to client.engine.
    // We memoize it to keep the object identity stable unless the client/key changes.
    const store = useMemo(() => {
        return client.store<T>(key);
    }, [client, key]);

    // Debug check to satisfy linter (rawValue is used purely for trigger effect)
    void rawValue;

    return store;
}

// Alias for semantic clarity in some codebases
export { useSyncedStore as useStore };

/**
 * Access Connection State details.
 * 
 * @returns An object containing status flags.
 * 
 * @example
 * ```tsx
 * const { isOnline, isSyncing } = useConnection();
 * if (!isOnline) return <OfflineBadge />;
 * ```
 */
export function useConnection() {
    const { status } = useNMeshed();

    return {
        status,
        isOnline: status === 'connected' || status === 'ready' || status === 'syncing',
        isSyncing: status === 'syncing',
        isReady: status === 'ready'
    };
}
