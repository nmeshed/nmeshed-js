import { useState, useEffect } from 'react';
import { useNmeshedContext } from './context';
import type { PresenceUser } from '../types';

export type UsePresenceOptions = {
    /**
     * @deprecated Polling is no longer needed; presence is real-time.
     */
    interval?: number;
};

/**
 * Hook to get the current presence list for the workspace.
 * Uses real-time WebSocket events.
 * 
 * @param options - Configuration options
 * @returns Array of active users
 */
export function usePresence(options: UsePresenceOptions = {}): PresenceUser[] {
    void options; // Silence unused warning (deprecated)
    const client = useNmeshedContext();
    const [users, setUsers] = useState<PresenceUser[]>([]);

    useEffect(() => {
        let mounted = true;

        // 1. Initial Fetch (HTTP)
        const fetchInitial = async () => {
            if (client.getStatus() === 'CONNECTED') {
                try {
                    const initialUsers = await client.getPresence();
                    if (mounted) {
                        setUsers(initialUsers as PresenceUser[]);
                    }
                } catch (e) {
                    console.warn('Failed to fetch initial presence:', e);
                }
            }
        };

        // Fetch immediately if connected
        fetchInitial();

        // Listen for status changes (e.g. if we connect late)
        const unsubscribeStatus = client.onStatusChange((status) => {
            if (status === 'CONNECTED') {
                fetchInitial();
            }
        });

        // 2. Subscribe to Real-time Updates (WS)
        const unsubscribe = client.onPresence((eventPayload) => {
            setUsers((current) => {
                // If offline, remove from list
                if (eventPayload.status === 'offline') {
                    return current.filter(u => u.userId !== eventPayload.userId);
                }

                // Otherwise update or add
                const index = current.findIndex(u => u.userId === eventPayload.userId);
                if (index !== -1) {
                    const newUsers = [...current];
                    newUsers[index] = { ...newUsers[index], ...eventPayload };
                    return newUsers;
                } else {
                    return [...current, eventPayload];
                }
            });
        });

        return () => {
            mounted = false;
            unsubscribe();
            unsubscribeStatus();
        };
    }, [client]);

    return users;
}
