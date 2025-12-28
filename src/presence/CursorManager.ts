/**
 * @file CursorManager.ts
 * @brief Real-time cursor position synchronization for presence features.
 *
 * CursorManager provides a simple API for broadcasting and receiving
 * cursor positions across peers. It handles serialization, ephemeral
 * messaging, and automatic cleanup on peer disconnect.
 *
 * @example
 * ```typescript
 * const cursors = new CursorManager(client, { userId: 'my-user-id' });
 *
 * // Broadcast your cursor
 * cursors.sendCursor(100, 200);
 *
 * // Listen for peer cursors
 * cursors.onCursor((userId, x, y) => {
 *     renderCursor(userId, x, y);
 * });
 * ```
 */



import { NMeshedClient } from '../client';

/**
 * Cursor position data.
 */
export interface CursorPosition {
    x: number;
    y: number;
    userId: string;
    timestamp: number;
}

/**
 * Callback for cursor updates.
 */
export type CursorCallback = (userId: string, x: number, y: number) => void;

/**
 * Configuration for CursorManager.
 */
export interface CursorManagerConfig {
    /**
     * Your user ID to include in cursor broadcasts.
     * Required for peers to identify your cursor.
     */
    userId?: string;

    /**
     * Namespace for cursor ephemeral messages.
     * @default 'cursor'
     */
    namespace?: string;

    /**
     * Throttle interval for cursor broadcasts in ms.
     * @default 16 (60 FPS)
     */
    throttleMs?: number;

    /**
     * Time in ms after which a cursor is considered stale.
     * @default 5000
     */
    staleTimeoutMs?: number;
}

// Message type identifier for cursor packets
const CURSOR_MSG_TYPE = '__cursor__';

/**
 * Real-time cursor synchronization manager.
 *
 * Broadcasts cursor positions via ephemeral messaging and tracks
 * peer cursor positions. Automatically cleans up cursors when peers disconnect.
 */
export class CursorManager {
    private client: NMeshedClient;
    private config: Required<CursorManagerConfig>;
    private cursors: Map<string, CursorPosition> = new Map();
    private callbacks: Set<CursorCallback> = new Set();
    private removeCallbacks: Set<(userId: string) => void> = new Set();
    private lastSendTime: number = 0;
    private unsubscribes: (() => void)[] = [];

    constructor(client: NMeshedClient, config: CursorManagerConfig = {}) {
        this.client = client;
        const resolvedUserId = config.userId ?? (client as any)._config?.userId ?? `user_${Math.random().toString(36).slice(2, 8)}`;
        this.config = {
            userId: resolvedUserId,
            namespace: config.namespace ?? 'cursor',
            throttleMs: config.throttleMs ?? 16,
            staleTimeoutMs: config.staleTimeoutMs ?? 5000,
        };

        this.setupListeners();
    }

    /**
     * Returns the local user ID.
     */
    public get userId(): string {
        return this.config.userId;
    }

    /**
     * Broadcasts cursor position to all peers.
     * Throttled to prevent network spam.
     *
     * @param x - X coordinate
     * @param y - Y coordinate
     */
    public sendCursor(x: number, y: number): void {
        const now = Date.now();
        if (now - this.lastSendTime < this.config.throttleMs) {
            return; // Throttled
        }
        this.lastSendTime = now;

        const message = {
            type: CURSOR_MSG_TYPE,
            namespace: this.config.namespace,
            userId: this.config.userId,
            x: Math.round(x),
            y: Math.round(y),
            timestamp: now,
        };

        const payload = new TextEncoder().encode(JSON.stringify(message));
        this.client.sendMessage(payload);
    }

    /**
     * Registers a callback for cursor updates from peers.
     * Returns an unsubscribe function.
     *
     * @param callback - Called when a peer's cursor moves
     */
    public onCursor(callback: CursorCallback): () => void {
        this.callbacks.add(callback);
        return () => this.callbacks.delete(callback);
    }

    /**
     * Registers a callback for when a cursor is removed (peer disconnect or stale).
     * Returns an unsubscribe function.
     *
     * @param callback - Called when a peer's cursor is removed
     */
    public onCursorRemove(callback: (userId: string) => void): () => void {
        this.removeCallbacks.add(callback);
        return () => this.removeCallbacks.delete(callback);
    }

    /**
     * Returns all current cursor positions.
     */
    public getCursors(): Map<string, CursorPosition> {
        return new Map(this.cursors);
    }

    /**
     * Returns a specific peer's cursor position, or undefined if not available.
     */
    public getCursor(userId: string): CursorPosition | undefined {
        return this.cursors.get(userId);
    }

    /**
     * Cleans up resources.
     */
    public destroy(): void {
        for (const unsub of this.unsubscribes) {
            unsub();
        }
        this.unsubscribes = [];
        this.cursors.clear();
        this.callbacks.clear();
        this.removeCallbacks.clear();
    }

    private setupListeners(): void {
        // Listen for ephemeral messages (payload includes userId)
        const unsubEphemeral = this.client.on('ephemeral', (payload: any) => {
            try {
                // Decode binary payload if necessary
                let data = payload;
                if (payload instanceof Uint8Array || payload instanceof ArrayBuffer) {
                    const str = new TextDecoder().decode(payload);
                    data = JSON.parse(str);
                }
                this.handleEphemeral(data);
            } catch (e) {
                // Ignore decoding errors
            }
        });
        this.unsubscribes.push(unsubEphemeral);

        // Listen for peer disconnect
        const unsubPeerDisconnect = this.client.on('peerDisconnect', (peerId: string) => {
            this.removeCursor(peerId);
        });
        this.unsubscribes.push(unsubPeerDisconnect);
    }

    private handleEphemeral(data: any): void {
        if (!this.isCursorMessage(data)) return;

        const { userId, x, y, timestamp } = data;

        // Ignore our own cursor
        if (userId === this.config.userId) return;

        const position: CursorPosition = {
            x,
            y,
            userId,
            timestamp,
        };

        this.cursors.set(userId, position);

        // Notify callbacks
        for (const callback of this.callbacks) {
            try {
                callback(userId, x, y);
            } catch (e) {
                console.error('[CursorManager] Error in cursor callback:', e);
            }
        }
    }

    private isCursorMessage(data: any): data is {
        type: string;
        namespace: string;
        userId: string;
        x: number;
        y: number;
        timestamp: number;
    } {
        if (typeof data !== 'object' || data === null) return false;
        const obj = data as Record<string, any>;
        return (
            obj.type === CURSOR_MSG_TYPE &&
            obj.namespace === this.config.namespace &&
            typeof obj.userId === 'string' &&
            typeof obj.x === 'number' &&
            typeof obj.y === 'number' &&
            typeof obj.timestamp === 'number'
        );
    }

    private removeCursor(userId: string): void {
        if (!this.cursors.has(userId)) return;

        this.cursors.delete(userId);

        for (const callback of this.removeCallbacks) {
            try {
                callback(userId);
            } catch (e) {
                console.error('[CursorManager] Error in remove callback:', e);
            }
        }
    }
}

