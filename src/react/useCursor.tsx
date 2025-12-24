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

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { CursorManager, CursorPosition, CursorManagerConfig } from '../presence/CursorManager';
import { NMeshedClient } from '../client';

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
 * Dummy manager for when client is null.
 * Singleton to prevent unnecessary object creation.
 */
const DUMMY_MANAGER: CursorManager = {
    sendCursor: () => { /* no-op */ },
    onCursor: () => () => { /* no-op */ },
    onCursorRemove: () => () => { /* no-op */ },
    getCursors: () => new Map(),
    getCursor: () => undefined,
    destroy: () => { /* no-op */ },
    userId: '',
} as unknown as CursorManager;

/**
 * React hook for real-time cursor synchronization.
 *
 * Automatically creates a CursorManager, subscribes to updates,
 * and cleans up on unmount.
 *
 * ## Memory Safety
 * The hook memoizes based on config primitive values, not object identity.
 * This prevents CursorManager recreation when consumers pass inline config objects.
 *
 * @param client - NMeshedClient instance
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
    client: NMeshedClient | null,
    config?: CursorManagerConfig
): UseCursorResult {
    const [cursors, setCursors] = useState<Map<string, CursorPosition>>(new Map());

    // Version counter to force re-renders only when cursors actually change
    const versionRef = useRef(0);

    // Extract config primitives to prevent identity-based recreation
    // This fixes the memory leak where inline config objects caused manager recreation
    const configNamespace = config?.namespace;
    const configThrottleMs = config?.throttleMs;
    const configStaleTimeoutMs = config?.staleTimeoutMs;
    const configUserId = config?.userId;

    // Create CursorManager instance with stable dependencies
    const manager = useMemo(() => {
        if (!client) return null;

        const resolvedConfig: CursorManagerConfig = {};
        if (configNamespace !== undefined) resolvedConfig.namespace = configNamespace;
        if (configThrottleMs !== undefined) resolvedConfig.throttleMs = configThrottleMs;
        if (configStaleTimeoutMs !== undefined) resolvedConfig.staleTimeoutMs = configStaleTimeoutMs;
        if (configUserId !== undefined) resolvedConfig.userId = configUserId;

        return new CursorManager(client, resolvedConfig);
    }, [client, configNamespace, configThrottleMs, configStaleTimeoutMs, configUserId]);

    // Subscribe to cursor updates
    useEffect(() => {
        if (!manager) return;

        const updateCursors = () => {
            versionRef.current++;
            setCursors(manager.getCursors());
        };

        const unsubCursor = manager.onCursor(updateCursors);
        const unsubRemove = manager.onCursorRemove(updateCursors);

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

    return {
        cursors,
        sendCursor,
        manager: manager ?? DUMMY_MANAGER,
    };
}
