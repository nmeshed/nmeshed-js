/**
 * @file useCursor.tsx
 * @brief React hook for real-time cursor synchronization.
 *
 * Provides a simple API for broadcasting and rendering peer cursors
 * in React applications.
 *
 * @example
 * ```tsx
 * function Canvas() {
 *     const client = useNmeshedClient();
 *     const { cursors, sendCursor } = useCursor(client);
 *
 *     return (
 *         <div onMouseMove={(e) => sendCursor(e.clientX, e.clientY)}>
 *             {Array.from(cursors.values()).map((cursor) => (
 *                 <CursorIcon key={cursor.userId} x={cursor.x} y={cursor.y} />
 *             ))}
 *         </div>
 *     );
 * }
 * ```
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { MeshClient } from '../mesh/MeshClient';
import { CursorManager, CursorPosition, CursorManagerConfig } from '../presence/CursorManager';

/**
 * Return type for useCursor hook.
 */
export interface UseCursorResult {
    /**
     * Map of peer cursors by userId.
     */
    cursors: Map<string, CursorPosition>;

    /**
     * Broadcast your cursor position.
     */
    sendCursor: (x: number, y: number) => void;

    /**
     * The underlying CursorManager instance.
     */
    manager: CursorManager;
}

/**
 * React hook for real-time cursor synchronization.
 *
 * Automatically creates a CursorManager, subscribes to updates,
 * and cleans up on unmount.
 *
 * @param client - MeshClient instance
 * @param config - Optional CursorManager configuration
 *
 * @example
 * ```tsx
 * const { cursors, sendCursor } = useCursor(client);
 *
 * // Render peer cursors
 * {Array.from(cursors.values()).map((c) => (
 *     <div key={c.userId} style={{ left: c.x, top: c.y }} />
 * ))}
 *
 * // Broadcast your cursor
 * <div onMouseMove={(e) => sendCursor(e.clientX, e.clientY)} />
 * ```
 */
export function useCursor(
    client: MeshClient | null,
    config?: CursorManagerConfig
): UseCursorResult {
    const [cursors, setCursors] = useState<Map<string, CursorPosition>>(new Map());

    // Create CursorManager instance
    const manager = useMemo(() => {
        if (!client) return null;
        return new CursorManager(client, config);
    }, [client, config?.namespace, config?.throttleMs, config?.staleTimeoutMs]);

    // Subscribe to cursor updates
    useEffect(() => {
        if (!manager) return;

        const unsubCursor = manager.onCursor(() => {
            setCursors(manager.getCursors());
        });

        const unsubRemove = manager.onCursorRemove(() => {
            setCursors(manager.getCursors());
        });

        return () => {
            unsubCursor();
            unsubRemove();
            manager.destroy();
        };
    }, [manager]);

    // Memoized sendCursor function
    const sendCursor = useCallback(
        (x: number, y: number) => {
            manager?.sendCursor(x, y);
        },
        [manager]
    );

    // Create a dummy manager for when client is null
    const dummyManager = useMemo(
        () =>
        ({
            sendCursor: () => { },
            onCursor: () => () => { },
            onCursorRemove: () => () => { },
            getCursors: () => new Map(),
            getCursor: () => undefined,
            destroy: () => { },
        } as unknown as CursorManager),
        []
    );

    return {
        cursors,
        sendCursor,
        manager: manager ?? dummyManager,
    };
}
