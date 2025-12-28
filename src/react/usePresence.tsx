import { useState, useEffect, useCallback } from 'react';
import { useNmeshedContext } from './context';
import type { PresenceUser } from '../types';

/**
 * Generates a stable HSL color based on a string ID.
 * Targets high-vibrancy "designer" colors.
 *
 * Exported for use by other components (e.g., AvatarStack).
 *
 * @param id - User or entity ID
 * @returns HSL color string
 *
 * @example
 * ```typescript
 * const color = generateStableColor('user-123');
 * // Returns something like 'hsl(240, 70%, 55%)'
 * ```
 */
export function generateStableColor(id: string): string {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
        hash = id.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h = Math.abs(hash % 360);
    return `hsl(${h}, 70%, 55%)`;
}

/**
 * Type guard to check if client has ping method.
 */
function hasPingMethod(client: unknown): client is { ping: (userId: string) => Promise<number> } {
    return (
        typeof client === 'object' &&
        client !== null &&
        'ping' in client &&
        typeof (client as Record<string, unknown>).ping === 'function'
    );
}

/**
 * Hook to get the current presence list for the workspace.
 * Uses real-time WebSocket events and periodic pings for latency tracking.
 *
 * @returns Array of active users with enriched data (colors, latency)
 *
 * @example
 * ```tsx
 * function OnlineUsers() {
 *     const users = usePresence();
 *
 *     return (
 *         <ul>
 *             {users.map(user => (
 *                 <li key={user.userId}>
 *                     {user.userId} - {user.status}
 *                 </li>
 *             ))}
 *         </ul>
 *     );
 * }
 * ```
 */
export function usePresence(): PresenceUser[] {
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
            if (client.isLive) {
                try {
                    const initialUsers = await client.getPresence();
                    if (mounted) {
                        setUsers((initialUsers as PresenceUser[]).map(enrichUser));
                    }
                } catch (e) {
                    console.warn('[usePresence] Failed to fetch initial presence:', e);
                }
            }
        };

        fetchInitial();

        const unsubscribeStatus = client.onStatusChange((status) => {
            if (status === 'CONNECTED' || status === 'READY') {
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
        if (!client.isLive) return;

        // Type-safe ping using type guard
        if (!hasPingMethod(client)) return;

        const pingInterval = setInterval(async () => {
            // Filter online users (excluding self)
            const selfId = client.getId();
            const onlineUsers = users.filter(u => u.status === 'online' && u.userId !== selfId);
            if (onlineUsers.length === 0) return;

            // Parallel Ping (Zen Optimization: Action through Inaction)
            // Don't wait for one user to respond before asking the next.
            await Promise.all(onlineUsers.map(async (user) => {
                try {
                    const rtt = await client.ping(user.userId);
                    if (rtt > 0) {
                        setUsers(prev => prev.map(u =>
                            u.userId === user.userId ? { ...u, latency: Math.round(rtt) } : u
                        ));
                    }
                } catch {
                    // Ignore failures
                }
            }));
        }, 5000);

        return () => clearInterval(pingInterval);
    }, [client, users.length]);

    return users;
}
