/**
 * @file SyncedMap.ts
 * @brief Schema-aware reactive state container with automatic P2P synchronization.
 *
 * SyncedMap eliminates manual serialization, CRDT op wrapping, and hydration loops
 * by providing a Map-like interface that automatically broadcasts changes to peers.
 *
 * @example
 * ```typescript
 * import { createSyncedMap } from 'nmeshed';
 *
 * const entities = createSyncedMap<Entity>(meshClient, 'entities', {
 *     serialize: (e) => EntityState.serialize(e),
 *     deserialize: (buf) => EntityState.deserialize(buf),
 * });
 *
 * entities.set('building_123', { type: 'miner', x: 100, y: 200 });
 * entities.onRemoteChange((key, value) => hydrateToECS(key, value));
 * ```
 */

import type { MeshClient } from '../mesh/MeshClient';

/**
 * Configuration for SyncedMap serialization.
 */
export interface SyncedMapConfig<T> {
    /** Serialize a value to binary format for network transmission. */
    serialize: (value: T) => Uint8Array;
    /** Deserialize binary data back to a typed value. */
    deserialize: (buf: Uint8Array) => T;
    /**
     * Custom broadcast handler for binary transport.
     * If provided, SyncedMap will call this instead of using ephemeral JSON.
     * Use this to integrate with existing binary networking (e.g., Flatbuffers).
     */
    onBroadcast?: (key: string, bytes: Uint8Array | null) => void;
    /**
     * Custom snapshot handler for binary transport.
     * Called when SyncedMap needs to send a snapshot to a peer.
     */
    onSnapshot?: (peerId: string, entries: Map<string, Uint8Array>) => void;
}

/**
 * Event handlers for remote state changes.
 */
type RemoteChangeHandler<T> = (key: string, value: T) => void;
type RemoteDeleteHandler = (key: string) => void;

/**
 * Internal message format for snapshot transmission.
 */
interface SnapshotMessage {
    type: 'snapshot';
    namespace: string;
    entries: Array<{ key: string; data: string }>; // Base64-encoded values
}

/**
 * Internal message format for single-key updates.
 */
interface UpdateMessage {
    type: 'update';
    namespace: string;
    key: string;
    data: string | null; // Base64-encoded value, null = delete
}

type SyncMessage = SnapshotMessage | UpdateMessage;

/**
 * Reactive state container with automatic mesh synchronization.
 *
 * Features:
 * - Map-like interface (set, get, delete, has, keys, values, entries)
 * - Auto-broadcast on mutations
 * - Remote change/delete callbacks
 * - Snapshot serialization for peer hydration
 */
export class SyncedMap<T> {
    private data: Map<string, T> = new Map();
    private serialized: Map<string, Uint8Array> = new Map();
    private client: MeshClient;
    private namespace: string;
    private config: SyncedMapConfig<T>;

    private remoteChangeListeners: Set<RemoteChangeHandler<T>> = new Set();
    private remoteDeleteListeners: Set<RemoteDeleteHandler> = new Set();

    private unsubscribeMessage: (() => void) | null = null;
    private unsubscribePeerJoin: (() => void) | null = null;

    constructor(client: MeshClient, namespace: string, config: SyncedMapConfig<T>) {
        this.client = client;
        this.namespace = namespace;
        this.config = config;

        this.setupListeners();
    }

    // ============================================
    //           MAP INTERFACE
    // ============================================

    /**
     * Sets a key-value pair and broadcasts the change to all peers.
     */
    set(key: string, value: T): void {
        const bytes = this.config.serialize(value);
        this.data.set(key, value);
        this.serialized.set(key, bytes);

        // Broadcast update
        this.broadcastUpdate(key, bytes);
    }

    /**
     * Gets a value by key.
     */
    get(key: string): T | undefined {
        return this.data.get(key);
    }

    /**
     * Checks if a key exists.
     */
    has(key: string): boolean {
        return this.data.has(key);
    }

    /**
     * Deletes a key and broadcasts the deletion to all peers.
     */
    delete(key: string): boolean {
        const existed = this.data.delete(key);
        this.serialized.delete(key);

        if (existed) {
            this.broadcastUpdate(key, null);
        }
        return existed;
    }

    /**
     * Clears all entries (local only, does not broadcast).
     */
    clear(): void {
        this.data.clear();
        this.serialized.clear();
    }

    /**
     * Returns the number of entries.
     */
    get size(): number {
        return this.data.size;
    }

    /**
     * Iterates over keys.
     */
    keys(): IterableIterator<string> {
        return this.data.keys();
    }

    /**
     * Iterates over values.
     */
    values(): IterableIterator<T> {
        return this.data.values();
    }

    /**
     * Iterates over [key, value] pairs.
     */
    entries(): IterableIterator<[string, T]> {
        return this.data.entries();
    }

    /**
     * Iterates over [key, value] pairs.
     */
    forEach(callback: (value: T, key: string, map: SyncedMap<T>) => void): void {
        this.data.forEach((value, key) => callback(value, key, this));
    }

    // ============================================
    //           REMOTE EVENT HANDLERS
    // ============================================

    /**
     * Registers a callback for remote changes.
     * @returns Unsubscribe function.
     */
    onRemoteChange(handler: RemoteChangeHandler<T>): () => void {
        this.remoteChangeListeners.add(handler);
        return () => this.remoteChangeListeners.delete(handler);
    }

    /**
     * Registers a callback for remote deletions.
     * @returns Unsubscribe function.
     */
    onRemoteDelete(handler: RemoteDeleteHandler): () => void {
        this.remoteDeleteListeners.add(handler);
        return () => this.remoteDeleteListeners.delete(handler);
    }

    // ============================================
    //           SNAPSHOT / HYDRATION
    // ============================================

    /**
     * Returns a snapshot of all entries as serialized bytes.
     * Used for peer hydration.
     */
    snapshot(): Map<string, Uint8Array> {
        return new Map(this.serialized);
    }

    /**
     * Applies a snapshot from another peer.
     * Triggers onRemoteChange for each entry.
     */
    hydrate(entries: Map<string, Uint8Array>): void {
        for (const [key, bytes] of entries) {
            this.applyRemoteUpdate(key, bytes);
        }
    }

    /**
     * Applies a remote update from binary transport.
     * Use this when receiving data from custom networking (e.g., Flatbuffers).
     */
    applyRemote(key: string, bytes: Uint8Array): void {
        this.applyRemoteUpdate(key, bytes);
    }

    /**
     * Applies a remote deletion from binary transport.
     * Use this when receiving a deletion from custom networking.
     */
    applyRemoteRemove(key: string): void {
        this.applyRemoteDelete(key);
    }

    /**
     * Sets a value without broadcasting (for local initialization).
     */
    setLocal(key: string, value: T): void {
        const bytes = this.config.serialize(value);
        this.data.set(key, value);
        this.serialized.set(key, bytes);
    }

    // ============================================
    //           INTERNAL
    // ============================================

    private setupListeners(): void {
        // Listen for ephemeral messages containing SyncedMap updates
        this.unsubscribeMessage = this.client.on('ephemeral', (payload: unknown) => {
            if (this.isSyncMessage(payload)) {
                this.handleSyncMessage(payload);
            }
        });

        // Listen for peer joins - hook for custom logic if needed
        // Note: autoSnapshot is handled by GameClient, not here
        this.unsubscribePeerJoin = this.client.on('peerJoin', () => {
            // Reserved for future custom logic
        });
    }

    private isSyncMessage(payload: unknown): payload is SyncMessage {
        if (typeof payload !== 'object' || payload === null) return false;
        const msg = payload as Record<string, unknown>;
        return (msg.type === 'snapshot' || msg.type === 'update') && msg.namespace === this.namespace;
    }

    private handleSyncMessage(msg: SyncMessage): void {
        if (msg.type === 'snapshot') {
            for (const entry of msg.entries) {
                const bytes = this.base64ToUint8Array(entry.data);
                this.applyRemoteUpdate(entry.key, bytes);
            }
        } else if (msg.type === 'update') {
            if (msg.data === null) {
                this.applyRemoteDelete(msg.key);
            } else {
                const bytes = this.base64ToUint8Array(msg.data);
                this.applyRemoteUpdate(msg.key, bytes);
            }
        }
    }

    /**
     * Internal method to apply a remote update to the local state.
     * Deserializes the binary data and triggers reactive listeners.
     */
    private applyRemoteUpdate(key: string, bytes: Uint8Array): void {
        try {
            const value = this.config.deserialize(bytes);
            this.data.set(key, value);
            this.serialized.set(key, bytes);

            for (const handler of this.remoteChangeListeners) {
                try {
                    handler(key, value);
                } catch (e) {
                    console.error('[SyncedMap] Error in onRemoteChange handler:', e);
                }
            }
        } catch (e) {
            console.error('[SyncedMap] Failed to deserialize remote update:', e);
        }
    }

    /**
     * Internal method to apply a remote deletion to the local state.
     * Removes the key-value pair and triggers reactive listeners.
     */
    private applyRemoteDelete(key: string): void {
        const existed = this.data.delete(key);
        this.serialized.delete(key);

        if (existed) {
            for (const handler of this.remoteDeleteListeners) {
                try {
                    handler(key);
                } catch (e) {
                    console.error('[SyncedMap] Error in onRemoteDelete handler:', e);
                }
            }
        }
    }

    private broadcastUpdate(key: string, bytes: Uint8Array | null): void {
        // Use custom binary transport if provided
        if (this.config.onBroadcast) {
            this.config.onBroadcast(key, bytes);
            return;
        }

        // Default: JSON ephemeral transport
        const msg: UpdateMessage = {
            type: 'update',
            namespace: this.namespace,
            key,
            data: bytes ? this.uint8ArrayToBase64(bytes) : null,
        };
        this.client.sendEphemeral(msg);
    }

    /**
     * Sends a full snapshot to a specific peer.
     * Called by MeshClient when autoSnapshot is enabled and a peer joins.
     */
    sendSnapshotTo(peerId: string): void {
        // Use custom binary snapshot if provided
        if (this.config.onSnapshot) {
            this.config.onSnapshot(peerId, new Map(this.serialized));
            return;
        }

        // Default: JSON ephemeral transport
        const entries: Array<{ key: string; data: string }> = [];
        for (const [key, bytes] of this.serialized) {
            entries.push({ key, data: this.uint8ArrayToBase64(bytes) });
        }

        const msg: SnapshotMessage = {
            type: 'snapshot',
            namespace: this.namespace,
            entries,
        };
        this.client.sendEphemeral(msg, peerId);
    }

    /**
     * Cleans up event listeners.
     */
    destroy(): void {
        this.unsubscribeMessage?.();
        this.unsubscribePeerJoin?.();
        this.remoteChangeListeners.clear();
        this.remoteDeleteListeners.clear();
        this.data.clear();
        this.serialized.clear();
    }

    // ============================================
    //           HELPERS
    // ============================================

    private uint8ArrayToBase64(bytes: Uint8Array): string {
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    private base64ToUint8Array(base64: string): Uint8Array {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }
}

/**
 * Factory function to create a SyncedMap.
 *
 * @example
 * ```typescript
 * const entities = createSyncedMap<Entity>(client, 'entities', {
 *     serialize: (e) => EntityState.serialize(e),
 *     deserialize: (buf) => EntityState.deserialize(buf),
 * });
 * ```
 */
export function createSyncedMap<T>(
    client: MeshClient,
    namespace: string,
    config: SyncedMapConfig<T>
): SyncedMap<T> {
    return new SyncedMap(client, namespace, config);
}
