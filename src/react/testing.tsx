import { ReactNode, useMemo } from 'react';
import { NMeshedClient } from '../client';
import { NMeshedContext } from './context'; // We need access to the Context object itself
import type { ConnectionStatus } from '../types';
import { vi } from 'vitest';

export interface MockProviderProps {
    children: ReactNode;
    status?: ConnectionStatus;
    latency?: number;
    error?: Error | null;
    storeData?: Record<string, any>;
}

/**
 * Creates a mocked NMeshedClient for testing.
 */
export function createMockClient(initialData: Record<string, any> = {}): NMeshedClient {
    const data = new Map(Object.entries(initialData));

    // Create a partial mock that satisfies the interface methods used by hooks
    const mock = {
        getStatus: vi.fn(() => 'CONNECTED'),
        getLatency: vi.fn(() => 10),
        get: vi.fn((key: string) => data.get(key)),
        set: vi.fn((key: string, value: any) => data.set(key, value)),
        subscribe: vi.fn(() => () => { }),
        onStatusChange: vi.fn(() => () => { }),
        on: vi.fn(() => () => { }),
        connect: vi.fn(async () => { }),
        disconnect: vi.fn(() => { }),
    } as unknown as NMeshedClient;

    return mock;
}

/**
 * A testing provider that bypasses the real client initialization.
 * Use this in unit tests to wrap components that use useStore, usePresence, etc.
 */
export function MockNMeshedProvider({
    children,
    status = 'CONNECTED',
    latency = 10,
    error = null,
    storeData = {}
}: MockProviderProps) {

    const client = useMemo(() => {
        const c = createMockClient(storeData);
        // Override mock implementation to return props
        c.getStatus = () => status as any;
        c.getLatency = () => latency;
        return c;
    }, [status, latency, storeData]);

    const contextValue = {
        client,
        status,
        error
    };

    // We need to cast to any because NMeshedContext is not exported from context.tsx currently.
    // Wait, we need to export NMeshedContext from context.tsx first!
    // For now, let's assume we will fix context.tsx export.
    return (
        <NMeshedContext.Provider value={contextValue}>
            {children}
        </NMeshedContext.Provider>
    );
}
