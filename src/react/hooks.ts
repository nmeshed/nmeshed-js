import { useState, useEffect, useMemo, useCallback, useSyncExternalStore } from 'react';
import { useNMeshed } from './context';

/**
 * Schema-Driven Store Hook
 * Returns a reactive Proxy that auto-syncs changes.
 */
/**
 * Schema-Driven Store Hook
 * Returns a reactive Proxy that auto-syncs changes.
 * Uses useSyncExternalStore for TEARING-FREE, zero-jank updates.
 */
export function useStore<T extends object>(key: string): T {
    const { client } = useNMeshed();

    if (!client) {
        throw new Error('useStore must be used within NMeshedProvider');
    }

    const subscribe = useMemo(() => {
        return (callback: () => void) => client.subscribe(key, callback);
    }, [client, key]);

    const getSnapshot = useCallback(() => {
        return client.get<T>(key);
    }, [client, key]);

    // We use the proxy wrapper as the snapshot? 
    // No, client.get() returns the raw object. 
    // The store proxy API in client.ts returns a Proxy wrapper.
    // We want to return the Proxy, but trigger re-renders when the underlying data changes.

    // Problem: client.store(key) creates a NEW proxy every time.
    // Solution: We need a referentially stable way to get the proxy OR just rely on the proxy being cheap.
    // Actually, the previous implementation wrapped it in useMemo.

    // Let's optimize:
    // We subscribe to the KEY updates.
    // When update happens, we force a re-render via useSyncExternalStore.
    // The value returned should be the Proxy.

    // But useSyncExternalStore expects getSnapshot to return a stable value if nothing changed.
    // client.get() returns the raw JS object from the engine. That object IS stable if the engine didn't change it (it replaces it on update).
    // So client.get(key) is a valid snapshot source.

    const rawValue = useSyncExternalStore(
        subscribe,
        getSnapshot,
        getSnapshot // server snapshot
    );

    // Now wrap it in the proxy for mutations. 
    // We memoize the proxy so it's stable as long as client/key is stable.
    // Wait, if rawValue changes, do we need a new Proxy?
    // The Proxy implementation in client.ts (createProxy) points to `engine`.
    // It doesn't hold the value. It reads from engine on get.
    // So the Proxy instance is completely independent of the data version!
    // It just forwards gets/sets to engine.

    const store = useMemo(() => {
        return client.store<T>(key);
    }, [client, key]);

    // However, we need to make sure the component re-renders when rawValue changes.
    // Just calling useSyncExternalStore creates the subscription and trigger.
    // Returning `store` (the proxy) is fine, because the component will re-render, 
    // access the proxy properties, and the proxy will read fresh data from engine.

    // Trick: We must "consume" rawValue to ensure React doesn't optimize away the re-render?
    // No, useSyncExternalStore triggers a render. The component function runs.
    // We return `store`. The component reads `store.foo`.
    // `store.foo` reads from engine. Engine has new data. correct.

    // One Edge Case: If the proxy caches anything. `createProxy` checks engine on every get.
    // So this is "Zen".

    // BUT: to make sure we don't return a stale proxy if `client` changes (unlikely but possible), 
    // we keep the useMemo dependency on client/key.

    // Debug check to silence unused variable warning if necessary, 
    // but rawValue is effectively used to trigger the hook's effect.
    void rawValue;

    return store;
}

/**
 * Access Connection State
 * Use this to show "Offline" badges or Sync spinners.
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
