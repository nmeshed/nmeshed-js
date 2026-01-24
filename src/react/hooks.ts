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

    // Snapshot Cache allows us to return the same object reference if the value represents the same data.
    // This prevents infinite render loops in React.
    const snapshotCache = useMemo(() => ({ current: undefined as T | undefined }), []);

    // Stable snapshot getter
    const getSnapshot = useCallback(() => {
        const newValue = client.get<T>(key);
        // If the new value is deeply equal to the cached value, return the cached reference.
        // @ts-ignore - deepEqual is available globally or we import it.
        // Actually we need to import it. But assuming we can't easily, we implement a simple one here or use JSON.
        // Fast path: reference equality
        if (newValue === snapshotCache.current) return snapshotCache.current as T;

        // Slow path: deep comparison (JSON stringify is "good enough" for this SDK's data types)
        if (JSON.stringify(newValue) === JSON.stringify(snapshotCache.current)) {
            return snapshotCache.current as T;
        }

        snapshotCache.current = newValue;
        return newValue as T;
    }, [client, key]);

    // TEARING-FREE SUBSCRIPTION
    const rawValue = useSyncExternalStore(
        subscribe,
        getSnapshot,
        getSnapshot
    );

    // Proxy Creation
    const store = useMemo(() => {
        return client.store<T>(key);
    }, [client, key]);

    // Debug check
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
