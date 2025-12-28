import { useState, useEffect } from 'react';
import { useOptionalNmeshedContext } from './context';
import { NMeshedClient } from '../client';

/**
 * Hook to access the current list of connected peers.
 * 
 * Zen API: "Just give me the peers."
 * No manual wiring required.
 * 
 * @param clientOverride - Optional client instance (if not using Provider)
 * @returns Array of peer IDs.
 */
export function usePeers(clientOverride?: NMeshedClient): string[] {
    const context = useOptionalNmeshedContext();
    const client = clientOverride || context?.client;

    // Default to empty array if no client available
    const [peers, setPeers] = useState<string[]>(() => client ? client.getPeers() : []);

    useEffect(() => {
        if (!client) return;

        // Sync initial state in case it changed before effect
        setPeers(client.getPeers());

        const update = () => setPeers(client.getPeers());

        const unsubJoin = client.on('peerJoin', update);
        const unsubLeave = client.on('peerDisconnect', update);

        return () => {
            unsubJoin();
            unsubLeave();
        };
    }, [client]);

    return peers;
}
