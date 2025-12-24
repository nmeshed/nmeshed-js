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

// Binary Packing Utilities (Internal)
function packMessage(namespace: string, key: string, value: Uint8Array | null): Uint8Array {
    const encoder = new TextEncoder();
    const nsBytes = encoder.encode(namespace);
    const keyBytes = encoder.encode(key);

    // Header: [NS_LEN(1)][KEY_LEN(1)][HAS_VALUE(1)]
    // Payload: [NS][KEY][VALUE?]
    const totalLen = 3 + nsBytes.length + keyBytes.length + (value ? value.length : 0);
    const buf = new Uint8Array(totalLen);

    let offset = 0;
    buf[offset++] = nsBytes.length; // Limit 255
    buf[offset++] = keyBytes.length; // Limit 255
    buf[offset++] = value ? 1 : 0;

    buf.set(nsBytes, offset); offset += nsBytes.length;
    buf.set(keyBytes, offset); offset += keyBytes.length;

    if (value) {
        buf.set(value, offset);
    }

    return buf;
}

function unpackMessage(buf: Uint8Array): { namespace: string, key: string, data: Uint8Array | null } | null {
    if (buf.length < 3) return null;
    let offset = 0;

    const nsLen = buf[offset++];
    const keyLen = buf[offset++];
    const hasValue = buf[offset++] === 1;

    if (buf.length < 3 + nsLen + keyLen) return null;

    const decoder = new TextDecoder();
    const namespace = decoder.decode(buf.subarray(offset, offset + nsLen));
    offset += nsLen;

    const key = decoder.decode(buf.subarray(offset, offset + keyLen));
    offset += keyLen;

    const data = hasValue ? buf.subarray(offset) : null;
    return { namespace, key, data };
}

const MAX_KEY_LEN = 255;

function packSnapshot(entries: Map<string, Uint8Array>): Uint8Array {
    let size = 4; // Count (Uint32)
    const encoder = new TextEncoder();
    const encodedKeys = new Map<string, Uint8Array>();

    for (const [key, val] of entries) {
        const kBytes = encoder.encode(key);
        if (kBytes.length > MAX_KEY_LEN) continue;
        encodedKeys.set(key, kBytes);
        size += 1 + kBytes.length + 4 + val.length;
    }

    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    let offset = 0;
    view.setUint32(offset, encodedKeys.size, true);
    offset += 4;

    for (const [key, val] of entries) {
        const kBytes = encodedKeys.get(key);
        if (!kBytes) continue;

        buf[offset++] = kBytes.length;
        buf.set(kBytes, offset);
        offset += kBytes.length;

        view.setUint32(offset, val.length, true);
        offset += 4;

        buf.set(val, offset);
        offset += val.length;
    }

    return buf;
}

function unpackSnapshot(buf: Uint8Array): Map<string, Uint8Array> {
    const entries = new Map<string, Uint8Array>();
    if (buf.length < 4) return entries;

    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let offset = 0;

    const count = view.getUint32(offset, true);
    offset += 4;

    const decoder = new TextDecoder();

    for (let i = 0; i < count; i++) {
        if (offset >= buf.length) break;

        const kLen = buf[offset++];
        const key = decoder.decode(buf.subarray(offset, offset + kLen));
        offset += kLen;

        const vLen = view.getUint32(offset, true);
        offset += 4;

        const val = buf.slice(offset, offset + vLen);
        offset += vLen;

        entries.set(key, val);
    }

    return entries;
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
        // Force notify engine of "external" op if needed, but SyncedMap is usually top-level
    }

    applyRemoteRemove(key: string): void {
        const existed = this.data.delete(key);
        this.serialized.delete(key);
        if (existed) {
            this.remoteDeleteListeners.forEach(l => { try { l(key) } catch { } });
        }
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
        // Binary payload from new protocol
        if (payload instanceof Uint8Array) return true;
        // Legacy JSON payload (backwards compatibility)
        if (typeof payload === 'object' && payload !== null) {
            return (payload.type === 'update' || payload.type === 'snapshot') && payload.namespace === this.namespace;
        }
        return false;
    }

    private handleSyncMessage(payload: any): void {
        // New binary protocol path
        if (payload instanceof Uint8Array) {
            // Check first byte for message type: 0=Update, 1=Snapshot
            const type = payload[0];
            if (type === 0) { // Update
                const msg = unpackMessage(payload.subarray(1));
                if (!msg || msg.namespace !== this.namespace) return;

                if (msg.data) {
                    this.applyRemoteUpdate(msg.key, msg.data);
                } else {
                    this.applyRemoteDelete(msg.key);
                }
            } else if (type === 1) { // Snapshot
                let offset = 1;
                const nsLen = payload[offset++];
                const decoder = new TextDecoder();
                const ns = decoder.decode(payload.subarray(offset, offset + nsLen));
                offset += nsLen;

                if (ns !== this.namespace) return;

                const entries = unpackSnapshot(payload.subarray(offset));
                for (const [key, val] of entries) {
                    this.applyRemoteUpdate(key, val);
                }
            }
            return;
        }

        // Legacy JSON path (backwards compatibility for tests/older clients)
        if (typeof payload === 'object' && payload !== null) {
            if (payload.type === 'snapshot' && payload.namespace === this.namespace) {
                for (const entry of payload.entries || []) {
                    const bytes = this.base64ToUint8Array(entry.data);
                    this.applyRemoteUpdate(entry.key, bytes);
                }
            } else if (payload.type === 'update' && payload.namespace === this.namespace) {
                if (payload.data === null) {
                    this.applyRemoteDelete(payload.key);
                } else {
                    const bytes = this.base64ToUint8Array(payload.data);
                    this.applyRemoteUpdate(payload.key, bytes);
                }
            }
        }
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

        // Prefix 0 for Update
        const body = packMessage(this.namespace, key, bytes);
        const packet = new Uint8Array(1 + body.length);
        packet[0] = 0; // Type: Update
        packet.set(body, 1);

        this.client.broadcast(packet);
    }

    sendSnapshotTo(peerId: string): void {
        if (this.config.onSnapshot) {
            this.config.onSnapshot(peerId, new Map(this.serialized));
            return;
        }

        // Prefix 1 for Snapshot
        // Header: [1][NS_LEN][NS]
        const encoder = new TextEncoder();
        const nsBytes = encoder.encode(this.namespace);

        const snapshotBytes = packSnapshot(this.serialized);

        const packet = new Uint8Array(1 + 1 + nsBytes.length + snapshotBytes.length);
        let offset = 0;
        packet[offset++] = 1; // Type: Snapshot
        packet[offset++] = nsBytes.length;
        packet.set(nsBytes, offset);
        offset += nsBytes.length;
        packet.set(snapshotBytes, offset);

        this.client.sendToPeer(peerId, packet);
    }

    destroy(): void {
        this.unsubscribeMessage?.();
        this.unsubscribePeerJoin?.();
        this.remoteChangeListeners.clear();
        this.remoteDeleteListeners.clear();
        this.data.clear();
        this.serialized.clear();
    }

    // Removed base64 utils
}

export function createSyncedMap<T>(
    client: SyncClient,
    namespace: string,
    config?: Partial<SyncedMapConfig<T>>
): SyncedMap<T> {
    return new SyncedMap(client, namespace, config);
}
