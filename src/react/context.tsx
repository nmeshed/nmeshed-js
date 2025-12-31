/**
 * NMeshed v2 - React Integration
 * 
 * Singular Entry: One Provider, one Hook, zero cognitive load.
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import type { NMeshedConfig, ConnectionStatus, ClientEvents, EventHandler } from '../types';
import { NMeshedClient } from '../client';

// =============================================================================
// Context
// =============================================================================

interface NMeshedContextValue {
    client: NMeshedClient | null;
    status: ConnectionStatus;
    isReady: boolean;
}

const NMeshedContext = createContext<NMeshedContextValue | null>(null);

// =============================================================================
// Provider
// =============================================================================

interface NMeshedProviderProps extends Partial<NMeshedConfig> {
    client?: NMeshedClient;
    children: React.ReactNode;
}

export function NMeshedProvider({ children, client: externalClient, ...config }: NMeshedProviderProps): React.ReactElement {
    const [internalClient, setInternalClient] = useState<NMeshedClient | null>(null);
    const [status, setStatus] = useState<ConnectionStatus>('disconnected');

    // Mux: Use external client if provided, otherwise internal (Managed Mode)
    const activeClient = externalClient || internalClient;

    // Managed Mode Lifecycle
    useEffect(() => {
        if (externalClient) {
            // "AAA Mode": User manages the client. We just listen.
            // This decouples network life from UI death.
            setStatus(externalClient.getStatus());
            return externalClient.on('status', setStatus);
        }

        // "Zen Mode": We manage everything for you.
        // Validate config first
        if (!config.workspaceId || (!config.token && !config.apiKey)) {
            // Config likely still loading, do nothing
            return;
        }

        const newClient = new NMeshedClient(config as NMeshedConfig);
        setInternalClient(newClient);
        setStatus(newClient.getStatus());

        const unsubStatus = newClient.on('status', setStatus);

        return () => {
            unsubStatus();
            newClient.disconnect();
        };
        // Dependency on config ensures we only re-create if *intent* changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [externalClient, config.workspaceId, config.token, config.apiKey]);

    const value = useMemo<NMeshedContextValue>(() => ({
        client: activeClient,
        status,
        isReady: status === 'ready',
    }), [activeClient, status]);

    return React.createElement(NMeshedContext.Provider, { value }, children);
}

// =============================================================================
// Hooks
// =============================================================================

/** Hook to access the NMeshed context */
export function useNMeshed(): NMeshedContextValue {
    const context = useContext(NMeshedContext);
    if (!context) {
        throw new Error('[NMeshed] useNMeshed must be used within NMeshedProvider');
    }
    return context;
}

/** Hook for a single synced value */
export function useSyncedValue<T>(key: string, defaultValue: T): [T, (value: T) => void] {
    const { client, isReady } = useNMeshed();
    const [value, setValue] = useState<T>(() => client?.get<T>(key) ?? defaultValue);

    // Subscribe to changes
    useEffect(() => {
        if (!client) return;

        const unsub = client.on('op', (opKey, opValue) => {
            if (opKey === key) {
                setValue(opValue as T);
            }
        });

        // Initial value
        setValue(client.get<T>(key) ?? defaultValue);

        return unsub;
    }, [client, key, defaultValue]);

    // Setter
    const setRemoteValue = useCallback((newValue: T) => {
        if (client) {
            client.set(key, newValue);
        }
        setValue(newValue);
    }, [client, key]);

    return [value, setRemoteValue];
}

/** Hook to subscribe to all changes */
export function useOnChange(callback: (key: string, value: unknown) => void): void {
    const { client } = useNMeshed();

    useEffect(() => {
        if (!client) return;
        return client.on('op', (key, value) => callback(key, value));
    }, [client, callback]);
}

/** Hook for connection status */
export function useConnectionStatus(): ConnectionStatus {
    const { status } = useNMeshed();
    return status;
}

/** 
 * Hook to access a Schema-Driven Store 
 * (The "Ferrari" DX)
 * 
 * Usage: const { tasks } = useStore('board');
 */
export function useStore<T = any>(key: string): T {
    const { client, isReady } = useNMeshed();

    // Create a local state force-update trigger for reactivity
    // Since the Proxy handles data, we just need to re-render when 'op' fires for this key
    const [, forceUpdate] = useState({});

    useEffect(() => {
        if (!client) return;
        return client.on('op', (opKey) => {
            // Granular re-render: only if THIS store changed
            if (opKey === key) {
                forceUpdate({});
            }
        });
    }, [client, key]);

    // Return the Proxy if ready, otherwise empty object (or null? let's safe-default)
    // We memoize the proxy creation to avoid thrashing
    const store = useMemo(() => {
        if (!client) return {} as T;
        return client.store(key);
    }, [client, key]);

    return store as T;
}
