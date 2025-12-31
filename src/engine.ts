/**
 * NMeshed v2 - CRDT Engine
 * 
 * Action through Inaction: Prediction and reconciliation happen invisibly.
 * This is the heart of the sync engine - CRDT operations without the noise.
 */

import type { CRDTCore, Operation, ConnectionStatus, ClientEvents, EventHandler } from './types';
import { encodeValue, decodeValue, MsgType } from './protocol';

// =============================================================================
// Event Emitter
// =============================================================================

type ListenerMap = {
    [K in keyof ClientEvents]: Set<ClientEvents[K]>;
};

class EventEmitter {
    private listeners: ListenerMap = {
        op: new Set(),
        status: new Set(),
        error: new Set(),
        peerJoin: new Set(),
        peerLeave: new Set(),
        ready: new Set(),
    };

    on<K extends keyof ClientEvents>(event: K, handler: EventHandler<K>): () => void {
        (this.listeners[event] as Set<EventHandler<K>>).add(handler);
        return () => (this.listeners[event] as Set<EventHandler<K>>).delete(handler);
    }

    emit<K extends keyof ClientEvents>(event: K, ...args: Parameters<ClientEvents[K]>): void {
        (this.listeners[event] as Set<ClientEvents[K]>).forEach((handler) => {
            try {
                (handler as (...args: Parameters<ClientEvents[K]>) => void)(...args);
            } catch (error) {
                console.error(`[NMeshed] Error in ${event} handler:`, error);
            }
        });
    }

    clear(): void {
        Object.values(this.listeners).forEach((set) => set.clear());
    }
}

// =============================================================================
// Sync Engine
// =============================================================================

export class SyncEngine extends EventEmitter {
    private state = new Map<string, unknown>();
    private status: ConnectionStatus = 'disconnected';
    private peerId: string;
    private pendingOps: Operation[] = [];
    private debug: boolean;

    // WASM core (optional - for CRDT merge logic)
    private core: CRDTCore | null = null;

    constructor(peerId: string, debug = false) {
        super();
        this.peerId = peerId;
        this.debug = debug;
    }

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /** Get a value by key */
    get<T = unknown>(key: string): T | undefined {
        return this.state.get(key) as T | undefined;
    }

    /** Set a key-value pair (local operation) */
    set<T = unknown>(key: string, value: T): Uint8Array {
        const timestamp = Date.now();

        // Apply locally immediately (optimistic)
        this.state.set(key, value);

        // Emit change event
        this.emit('op', key, value, true);

        // Create wire payload
        const payload = encodeValue(value);

        // Queue for network send
        this.pendingOps.push({ key, value, timestamp, peerId: this.peerId });

        this.log(`Set: ${key} = ${JSON.stringify(value)}`);

        return payload;
    }

    /** Delete a key */
    delete(key: string): Uint8Array {
        this.state.delete(key);
        this.emit('op', key, null, true);
        return this.set(key, null as unknown);
    }

    /** Apply a remote operation */
    applyRemote(key: string, payload: Uint8Array, peerId: string): void {
        const value = decodeValue(payload);

        // Simple LWW merge (last-write-wins based on receipt order)
        // In production, the WASM core handles proper CRDT merge
        this.state.set(key, value);

        this.emit('op', key, value, false);
        this.log(`Remote: ${key} from ${peerId}`);
    }

    /** Load initial state from snapshot */
    /** Load initial state from snapshot */
    loadSnapshot(data: Uint8Array): void {
        // Zen Principle: The State Machine knows its capabilities.

        // 1. If we have the Core (WASM), we delegate immediately.
        if (this.core) {
            this.core.loadSnapshot(data);
            return;
        }

        // 2. "Light Mode": Try to decode as a JS Object (MsgPack/JSON)
        // Since we moved to MsgPack, there is no magic byte to sniff easily for "JSON vs Binary".
        // Use an optimistic approach.
        try {
            const snapshot = decodeValue<Record<string, unknown>>(data);
            if (snapshot && typeof snapshot === 'object') {
                for (const [key, value] of Object.entries(snapshot)) {
                    this.state.set(key, value);
                    this.emit('op', key, value, false);
                }
                this.log(`Loaded snapshot (${Object.keys(snapshot).length} keys)`);
            }
        } catch (e) {
            // 3. Binary/Opaque Snapshot?
            // If decode fails, we assume it's a binary blob correctly meant for WASM (which we lack).
            // Action through Inaction: We start fresh.
            this.log('Could not decode snapshot in Light Mode (likely binary/WASM only). Starting fresh.');
        }
    }

    private isJson(data: Uint8Array): boolean {
        // Simple heuristic: Look for '{' (0x7B) or '[' (0x5B)
        // In a perfect world, we'd have a Content-Type header, 
        // but bytes are precious, so we infer from content.
        if (data.length === 0) return false;

        // Skip BOM/Whitespace if needed (simplified for Zen clarity)
        const firstByte = data[0];
        return firstByte === 0x7B || firstByte === 0x5B;
    }

    /** Export current state as snapshot */
    getSnapshot(): Record<string, unknown> {
        const snapshot: Record<string, unknown> = {};
        this.state.forEach((value, key) => {
            snapshot[key] = value;
        });
        return snapshot;
    }

    /** Get all values */
    getAllValues(): Record<string, unknown> {
        return this.getSnapshot();
    }

    /** Iterate over all entries */
    forEach(callback: (value: unknown, key: string) => void): void {
        this.state.forEach((value, key) => callback(value, key));
    }

    /** Get current status */
    getStatus(): ConnectionStatus {
        return this.status;
    }

    /** Update connection status */
    setStatus(status: ConnectionStatus): void {
        if (this.status !== status) {
            this.status = status;
            this.emit('status', status);
            this.log(`Status: ${status}`);
        }
    }

    /** Get peer ID */
    getPeerId(): string {
        return this.peerId;
    }

    /** Get pending operations count */
    getPendingCount(): number {
        return this.pendingOps.length;
    }

    /** Clear pending operations */
    clearPending(): void {
        this.pendingOps = [];
    }

    /** Drain pending operations */
    drainPending(): Operation[] {
        const ops = this.pendingOps;
        this.pendingOps = [];
        return ops;
    }

    /** Clean up */
    destroy(): void {
        this.clear();
        this.state.clear();
        this.pendingOps = [];
    }

    // ---------------------------------------------------------------------------
    // WASM Core Integration
    // ---------------------------------------------------------------------------

    /** Attach WASM core for proper CRDT operations */
    attachCore(core: CRDTCore): void {
        this.core = core;
        this.log('WASM core attached');
    }

    // ---------------------------------------------------------------------------
    // Private
    // ---------------------------------------------------------------------------

    private log(...args: unknown[]): void {
        if (this.debug) {
            console.log('[NMeshed Engine]', ...args);
        }
    }
}
