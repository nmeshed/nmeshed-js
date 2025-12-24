/**
 * @file SyncedMap.ts
 * @brief Schema-aware reactive state container with automatic synchronization.
 */

/**
 * Minimal interface for a client that supports ephemeral messaging.
 */
export interface SyncClient {
    on(event: string, handler: (...args: any[]) => void): () => void;
    broadcast(payload: any): void;
    sendToPeer(peerId: string, payload: any): void;
}

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
     */
    onBroadcast?: (key: string, bytes: Uint8Array | null) => void;
    /**
     * Custom snapshot handler for binary transport.
     */
    onSnapshot?: (peerId: string, entries: Map<string, Uint8Array>) => void;
}

const DEFAULT_CONFIG: SyncedMapConfig<any> = {
    serialize: (val) => new TextEncoder().encode(JSON.stringify(val)),
    deserialize: (buf) => JSON.parse(new TextDecoder().decode(buf)),
};

/**
 * Event handlers for remote state changes.
 */
type RemoteChangeHandler<T> = (key: string, value: T) => void;
type RemoteDeleteHandler = (key: string) => void;

interface UpdateMessage {
    type: 'snapshot' | 'update';
    namespace: string;
    key: string;
    data: string | null;
}

export class SyncedMap<T> {
    private data: Map<string, T> = new Map();
    private serialized: Map<string, Uint8Array> = new Map();
    private client: SyncClient;
    private namespace: string;
    private config: SyncedMapConfig<T>;

    private remoteChangeListeners: Set<RemoteChangeHandler<T>> = new Set();
    private remoteDeleteListeners: Set<RemoteDeleteHandler> = new Set();

    private unsubscribeMessage: (() => void) | null = null;
    private unsubscribePeerJoin: (() => void) | null = null;

    constructor(client: SyncClient, namespace: string, config?: Partial<SyncedMapConfig<T>>) {
        this.client = client;
        this.namespace = namespace;
        this.config = { ...DEFAULT_CONFIG, ...config } as SyncedMapConfig<T>;

        this.setupListeners();
    }

    set(key: string, value: T): void {
        const bytes = this.config.serialize(value);
        this.data.set(key, value);
        this.serialized.set(key, bytes);
        this.broadcastUpdate(key, bytes);
    }

    get(key: string): T | undefined {
        return this.data.get(key);
    }

    has(key: string): boolean {
        return this.data.has(key);
    }

    delete(key: string): boolean {
        const existed = this.data.delete(key);
        this.serialized.delete(key);
        if (existed) {
            this.broadcastUpdate(key, null);
        }
        return existed;
    }

    clear(): void {
        this.data.clear();
        this.serialized.clear();
    }

    get size(): number {
        return this.data.size;
    }

    keys(): IterableIterator<string> {
        return this.data.keys();
    }

    values(): IterableIterator<T> {
        return this.data.values();
    }

    entries(): IterableIterator<[string, T]> {
        return this.data.entries();
    }

    forEach(callback: (value: T, key: string, map: SyncedMap<T>) => void): void {
        this.data.forEach((value, key) => callback(value, key, this));
    }

    onRemoteChange(handler: RemoteChangeHandler<T>): () => void {
        this.remoteChangeListeners.add(handler);
        return () => this.remoteChangeListeners.delete(handler);
    }

    onRemoteDelete(handler: RemoteDeleteHandler): () => void {
        this.remoteDeleteListeners.add(handler);
        return () => this.remoteDeleteListeners.delete(handler);
    }

    snapshot(): Map<string, Uint8Array> {
        return new Map(this.serialized);
    }

    hydrate(entries: Map<string, Uint8Array>): void {
        for (const [key, bytes] of entries) {
            this.applyRemoteUpdate(key, bytes);
        }
    }

    applyRemote(key: string, bytes: Uint8Array): void {
        this.applyRemoteUpdate(key, bytes);
    }

    applyRemoteRemove(key: string): void {
        this.applyRemoteDelete(key);
    }

    setLocal(key: string, value: T): void {
        const bytes = this.config.serialize(value);
        this.data.set(key, value);
        this.serialized.set(key, bytes);
    }

    private setupListeners(): void {
        this.unsubscribeMessage = this.client.on('ephemeral', (payload: any) => {
            if (this.isSyncMessage(payload)) {
                this.handleSyncMessage(payload);
            }
        });

        this.unsubscribePeerJoin = this.client.on('peerJoin', () => {
            // Handled externally if needed
        });
    }

    private isSyncMessage(payload: any): boolean {
        if (typeof payload !== 'object' || payload === null) return false;
        return (payload.type === 'snapshot' || payload.type === 'update') && payload.namespace === this.namespace;
    }

    private handleSyncMessage(msg: any): void {
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

    private applyRemoteUpdate(key: string, bytes: Uint8Array): void {
        try {
            const value = this.config.deserialize(bytes);
            this.data.set(key, value);
            this.serialized.set(key, bytes);
            for (const handler of this.remoteChangeListeners) {
                try { handler(key, value); } catch (e) {
                    console.error('[SyncedMap] Remote change handler error:', e);
                }
            }
        } catch (e) {
            console.error('[SyncedMap] Failed to apply remote update:', e);
        }
    }

    private applyRemoteDelete(key: string): void {
        const existed = this.data.delete(key);
        this.serialized.delete(key);
        if (existed) {
            for (const handler of this.remoteDeleteListeners) {
                try { handler(key); } catch (e) {
                    console.error('[SyncedMap] Remote delete handler error:', e);
                }
            }
        }
    }

    private broadcastUpdate(key: string, bytes: Uint8Array | null): void {
        if (this.config.onBroadcast) {
            this.config.onBroadcast(key, bytes);
            return;
        }

        const msg = {
            type: 'update',
            namespace: this.namespace,
            key,
            data: bytes ? this.uint8ArrayToBase64(bytes) : null,
        };
        this.client.broadcast(msg);
    }

    sendSnapshotTo(peerId: string): void {
        if (this.config.onSnapshot) {
            this.config.onSnapshot(peerId, new Map(this.serialized));
            return;
        }

        const entries: Array<{ key: string; data: string }> = [];
        for (const [key, bytes] of this.serialized) {
            entries.push({ key, data: this.uint8ArrayToBase64(bytes) });
        }

        const msg = {
            type: 'snapshot',
            namespace: this.namespace,
            entries,
        };
        this.client.sendToPeer(peerId, msg);
    }

    destroy(): void {
        this.unsubscribeMessage?.();
        this.unsubscribePeerJoin?.();
        this.remoteChangeListeners.clear();
        this.remoteDeleteListeners.clear();
        this.data.clear();
        this.serialized.clear();
    }

    private uint8ArrayToBase64(bytes: Uint8Array): string {
        let binary = '';
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    private base64ToUint8Array(base64: string): Uint8Array {
        const binary = atob(base64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }
}

export function createSyncedMap<T>(
    client: SyncClient,
    namespace: string,
    config?: Partial<SyncedMapConfig<T>>
): SyncedMap<T> {
    return new SyncedMap(client, namespace, config);
}
