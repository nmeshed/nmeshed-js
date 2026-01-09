/**
 * usePresence — Auto-cleaning ephemeral state for cursors, typing indicators, etc.
 * 
 * Unlike useStore, presence data expires automatically when the peer disconnects
 * or after the TTL elapses. No more manual cleanup on unmount.
 * 
 * @example
 * const { peers, setPresence } = usePresence<{ x: number; y: number }>('cursors');
 * 
 * // Set my presence
 * setPresence({ x: 100, y: 200 });
 * 
 * // Read all active peers (stale ones filtered out automatically)
 * Object.entries(peers).forEach(([peerId, cursor]) => {
 *     console.log(`${peerId} is at (${cursor.x}, ${cursor.y})`);
 * });
 */
import { useEffect, useCallback, useMemo } from 'react';
import { useNMeshed } from './context';
import { useStore } from './hooks';

interface PresenceEntry<T> {
    data: T;
    lastSeen: number;
    peerId: string;
}

export interface UsePresenceOptions {
    /** Time-to-live in ms before considering stale (default: 30000) */
    ttl?: number;
    /** Heartbeat interval in ms to keep presence alive (default: 10000) */
    heartbeatInterval?: number;
}

export function usePresence<T extends object>(
    channel: string,
    options: UsePresenceOptions = {}
) {
    const { ttl = 30000, heartbeatInterval = 10000 } = options;
    const { client } = useNMeshed();
    const peerId = client?.getPeerId() || 'unknown';

    // Store presence as a map of peerId -> PresenceEntry
    const presenceStore = useStore<Record<string, PresenceEntry<T>>>(`presence.${channel}`);

    // Auto-cleanup on unmount - the whole point of this hook
    useEffect(() => {
        return () => {
            if (presenceStore && presenceStore[peerId]) {
                delete presenceStore[peerId];
            }
        };
    }, [presenceStore, peerId]);

    // Heartbeat to keep our presence alive
    useEffect(() => {
        const interval = setInterval(() => {
            if (presenceStore && presenceStore[peerId]) {
                presenceStore[peerId] = {
                    ...presenceStore[peerId],
                    lastSeen: Date.now()
                };
            }
        }, heartbeatInterval);
        return () => clearInterval(interval);
    }, [presenceStore, peerId, heartbeatInterval]);

    // Filter out stale peers based on TTL
    const activePeers = useMemo(() => {
        const now = Date.now();
        const result: Record<string, T> = {};

        if (!presenceStore) return result;

        for (const [id, entry] of Object.entries(presenceStore)) {
            if (now - entry.lastSeen < ttl) {
                result[id] = entry.data;
            }
        }

        return result;
    }, [presenceStore, ttl]);

    // Update my presence data
    const setPresence = useCallback((data: T) => {
        if (!presenceStore) return;
        presenceStore[peerId] = {
            data,
            lastSeen: Date.now(),
            peerId
        };
    }, [presenceStore, peerId]);

    return {
        /** All active peers (excluding stale entries) */
        peers: activePeers,
        /** My peer ID */
        myId: peerId,
        /** Update my presence data */
        setPresence
    };
}
