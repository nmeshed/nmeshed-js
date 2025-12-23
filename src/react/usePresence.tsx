import { useState, useEffect, useCallback } from 'react';
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
 * Uses real-time WebSocket events and periodic pings for latency tracking.
 * 
 * @param options - Configuration options
 * @returns Array of active users with enriched data (colors, latency)
 */
export function usePresence(options: UsePresenceOptions = {}): PresenceUser[] {
    void options; // Silence unused warning (deprecated)
    const client = useNmeshedContext();
    const [users, setUsers] = useState<PresenceUser[]>([]);

    const enrichUser = useCallback((user: PresenceUser): PresenceUser => ({
        ...user,
        color: user.color || generateStableColor(user.userId),
    }), []);

    // 1. Subscription & Initial Fetch
    useEffect(() => {
        let mounted = true;

        const fetchInitial = async () => {
            if (client.getStatus() === 'CONNECTED') {
                try {
                    const initialUsers = await client.getPresence();
                    if (mounted) {
                        setUsers((initialUsers as PresenceUser[]).map(enrichUser));
                    }
                } catch (e) {
                    console.warn('Failed to fetch initial presence:', e);
                }
            }
        };

        fetchInitial();

        const unsubscribeStatus = client.onStatusChange((status) => {
            if (status === 'CONNECTED') {
                fetchInitial();
            }
        });

        const unsubscribe = client.onPresence((eventPayload) => {
            setUsers((current) => {
                if (eventPayload.status === 'offline') {
                    return current.filter(u => u.userId !== eventPayload.userId);
                }

                const index = current.findIndex(u => u.userId === eventPayload.userId);
                if (index !== -1) {
                    const newUsers = [...current];
                    newUsers[index] = enrichUser({ ...newUsers[index], ...eventPayload });
                    return newUsers;
                } else {
                    return [...current, enrichUser(eventPayload)];
                }
            });
        });

        return () => {
            mounted = false;
            unsubscribe();
            unsubscribeStatus();
        };
    }, [client, enrichUser]);

    // 2. Periodic Latency Updates (Pings)
    useEffect(() => {
        if (client.getStatus() !== 'CONNECTED') return;

        const pingInterval = setInterval(async () => {
            // Filter online users (excluding self)
            const onlineUsers = users.filter(u => u.status === 'online' && u.userId !== client.getId());
            if (onlineUsers.length === 0) return;

            for (const user of onlineUsers) {
                try {
                    const rtt = await (client as any).ping(user.userId);
                    if (rtt > 0) {
                        setUsers(prev => prev.map(u =>
                            u.userId === user.userId ? { ...u, latency: Math.round(rtt) } : u
                        ));
                    }
                } catch (e) {
                    // Ignore ping failures
                }
            }
        }, 5000);

        return () => clearInterval(pingInterval);
    }, [client, users.length]);

    return users;
}

/**
 * Generates a stable HSL color based on a string ID.
 * Targets high-vibrancy "designer" colors.
 */
function generateStableColor(id: string): string {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
        hash = id.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h = Math.abs(hash % 360);
    return `hsl(${h}, 70%, 55%)`;
}
