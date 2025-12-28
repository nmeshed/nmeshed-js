import { useState, useEffect } from 'react';
import { useOptionalNmeshedContext } from './context';
import type { ConnectionStatus } from '../types';
import { NMeshedClient } from '../client';

export interface ConnectionState {
    status: ConnectionStatus;
    error: Error | null;
    isReady: boolean;
    latency: number;
}

/**
 * Hook to access the current connection health.
 * 
 * Zen API: All connection info in one place.
 * 
 * @param clientOverride - Optional client instance (if not using Provider)
 */
export function useConnectionState(clientOverride?: NMeshedClient): ConnectionState {
    const context = useOptionalNmeshedContext();
    const client = clientOverride || context?.client;

    // Default state if no client
    const [status, setStatus] = useState<ConnectionStatus>(client ? client.getStatus() : 'IDLE');
    const [error, setError] = useState<Error | null>(context?.error || null);
    const [latency, setLatency] = useState<number>(client ? client.getLatency() : 0);

    useEffect(() => {
        if (!client) return;

        // Status handlers
        const unsubStatus = client.onStatusChange((s) => {
            setStatus(s);
            if (s === 'READY' || s === 'CONNECTED') setError(null);
        });

        const unsubError = client.on('error', (e) => {
            setError(e instanceof Error ? e : new Error(String(e)));
        });

        // Polling for latency (since it's a pull metric for now)
        const latencyInterval = setInterval(() => {
            if (client.getStatus() === 'READY') {
                setLatency(client.getLatency());
            }
        }, 2000);

        // Initial sync
        setStatus(client.getStatus());
        setLatency(client.getLatency());

        return () => {
            unsubStatus();
            unsubError();
            clearInterval(latencyInterval);
        };
    }, [client]);

    return {
        status,
        error: error || (context?.error || null), // Merge context error if available
        isReady: status === 'READY',
        latency
    };
}
