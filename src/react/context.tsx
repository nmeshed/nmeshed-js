/**
 * @module ReactContext
 * @description
 * This module provides the `NMeshedContext` and `NMeshedProvider`, which are the foundation
 * for using nMeshed in a React application.
 * 
 * ## Usage Modes
 * 1. **Zen Mode (Managed)**: You pass the configuration (`workspaceId`, `token`) props to the Provider, and it instantiates/manages the Client for you.
 * 2. **AAA Method (Advanced)**: You instantiate the `NMeshedClient` yourself and pass it via the `client` prop. Useful for dependency injection or sharing the client with non-React code.
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
    isReady: boolean; // Convenience flag for status === 'ready'
}

const NMeshedContext = createContext<NMeshedContextValue | null>(null);

// =============================================================================
// Provider
// =============================================================================

interface NMeshedProviderProps extends Partial<NMeshedConfig> {
    /**
     * Optional external client instance.
     * If provided, the Provider will use this client instead of creating one.
     */
    client?: NMeshedClient;
    children: React.ReactNode;
}

/**
 * The Root Provider for nMeshed.
 * 
 * @example
 * ```tsx
 * // Zen Mode (Recommended)
 * <NMeshedProvider workspaceId="ws_123" token="secret">
 *   <App />
 * </NMeshedProvider>
 * ```
 * 
 * @example
 * // Advanced Mode (Shared Client)
 * const client = new NMeshedClient({ ... });
 * <NMeshedProvider client={client}>
 *   <App />
 * </NMeshedProvider>
 * 
 * @param props - Configuration or Client instance.
 * @throws {Error} (Indirectly) If validation fails in Client constructor.
 */
export function NMeshedProvider({ children, client: externalClient, ...config }: NMeshedProviderProps): React.ReactNode {
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
            // This prevents "Client init failed" errors during hydration/env loading
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

    // Race Condition Guard:
    // If we are in "Zen Mode" (internal client), we must NOT render children until 
    // the client is instantiated. Otherwise hooks will throw "outside provider" or "client null" error.
    if (!activeClient) {
        // We render null to suspend the tree.
        // Ideally, user should handle "loading" based on isReady being false higher up if they use external client,
        // but for internal client, this 'null' prevents crashes.
        return null;
    }

    return React.createElement(NMeshedContext.Provider, { value }, children);
}

// =============================================================================
// Hooks
// =============================================================================

/** 
 * Low-level hook to access the NMeshed context.
 * 
 * @remarks
 * Prefer using `useSyncedStore` or `useConnection` instead of this directly.
 * 
 * @throws {Error} If used outside of `<NMeshedProvider>`.
 */
export function useNMeshed(): NMeshedContextValue {
    const context = useContext(NMeshedContext);
    if (!context) {
        throw new Error('[NMeshed] useNMeshed must be used within NMeshedProvider');
    }
    return context;
}

/** 
 * Hook for a single simple value (key-value pair).
 * 
 * @remarks
 * Good for simple toggles, strings, or numbers.
 * For complex objects with schema validation, use `useSyncedStore`.
 * 
 * @param key - The sync key.
 * @param defaultValue - Fallback value if key doesn't exist.
 * @returns [value, setValue] tuple.
 */
export function useSyncedValue<T>(key: string, defaultValue: T): [T, (value: T | ((prev: T) => T)) => void] {
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

        // Initial value check (after connect)
        setValue(client.get<T>(key) ?? defaultValue);

        return unsub;
    }, [client, key, defaultValue]);

    // Track latest value in ref for stable setter (Pattern: Fresh Ref)
    const valueRef = React.useRef(value);
    useEffect(() => { valueRef.current = value; }, [value]);

    // Setter
    const setRemoteValue = useCallback((newValueOrFn: T | ((prev: T) => T)) => {
        const current = valueRef.current;
        let newValue: T;

        if (typeof newValueOrFn === 'function') {
            newValue = (newValueOrFn as ((prev: T) => T))(current);
        } else {
            newValue = newValueOrFn;
        }

        if (client) {
            client.set(key, newValue);
        }
        setValue(newValue);
    }, [client, key]);

    return [value, setRemoteValue];
}

/** 
 * Hook to subscribe to ALL changes globally.
 * 
 * @remarks
 * Use sparingly. Useful for logs, debuggers, or "activity streams".
 */
export function useOnChange(callback: (key: string, value: unknown) => void): void {
    const { client } = useNMeshed();

    useEffect(() => {
        if (!client) return;
        return client.on('op', (key, value) => callback(key, value));
    }, [client, callback]);
}

/** 
 * Hook to access specific connection status string.
 */
export function useConnectionStatus(): ConnectionStatus {
    const { status } = useNMeshed();
    return status;
}
