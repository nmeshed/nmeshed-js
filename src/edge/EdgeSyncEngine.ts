/**
 * Edge Sync Engine
 * 
 * Simplified sync engine wrapper for Cloudflare Durable Objects
 * and other edge runtimes. Handles auto-hydration and persistence
 * invisibly, so developers can focus on business logic.
 * 
 * @example
 * ```typescript
 * // In your Durable Object
 * export class SyncDurableObject implements DurableObject {
 *   private engine: EdgeSyncEngine;
 *   
 *   constructor(state: DurableObjectState) {
 *     this.engine = new EdgeSyncEngine(state);
 *   }
 *   
 *   async fetch(request: Request): Promise<Response> {
 *     return this.engine.handleRequest(request);
 *   }
 * }
 * ```
 */

// Types for Cloudflare Workers runtime
export interface DurableObjectState {
    id: DurableObjectId;
    storage: DurableObjectStorage;
    acceptWebSocket(ws: WebSocket): void;
    getWebSockets(): WebSocket[];
}

export interface DurableObjectId {
    toString(): string;
    name?: string;
}

export interface DurableObjectStorage {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTime: number | Date): Promise<void>;
}

declare class WebSocketPair {
    0: WebSocket;
    1: WebSocket;
}


export interface EdgeSyncConfig {
    /** Mode: 'lww' (last-write-wins) or 'crdt' (conflict-free) */
    mode?: 'lww' | 'crdt';
    /** Auto-persist snapshots after N operations (default: 10) */
    persistInterval?: number;
    /** Enable debug logging */
    debug?: boolean;
}

/** Cloudflare-specific Response extensions */
interface WorkersResponseInit extends ResponseInit {
    webSocket?: WebSocket;
}

// Simple Init packet structure (matches WirePacket MsgType.Init = 1)

const INIT_MSG_TYPE = 1;

/**
 * Edge-optimized sync engine for Cloudflare Durable Objects.
 * 
 * Auto-handles:
 * - WebSocket upgrade and hibernation API
 * - State hydration on first connection
 * - Broadcasting to all connected clients
 * - Periodic snapshot persistence
 */
export class EdgeSyncEngine {
    private state: DurableObjectState;
    private config: Required<EdgeSyncConfig>;
    private operationCount = 0;
    private operations: Uint8Array[] = [];
    private roomId: string;

    constructor(state: DurableObjectState, config: EdgeSyncConfig = {}) {
        this.state = state;
        this.roomId = state.id.name ?? state.id.toString();
        this.config = {
            mode: config.mode ?? 'lww',
            persistInterval: config.persistInterval ?? 10,
            debug: config.debug ?? false
        };
    }

    /**
     * Handle an incoming HTTP request.
     * Upgrades WebSocket connections and returns appropriate responses.
     */
    async handleRequest(request: Request): Promise<Response> {
        const upgradeHeader = request.headers.get('Upgrade');

        if (upgradeHeader !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 });
        }

        // Hydrate from storage if needed
        await this.hydrate();

        // Create WebSocket pair
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        // Accept with Hibernation API
        this.state.acceptWebSocket(server);

        // Send Init packet to new client with all operations
        const initPacket = this.createInitPacket();
        server.send(initPacket);

        if (this.config.debug) {
            console.log(`[EdgeSync] Client connected to room ${this.roomId}`);
        }

        return new Response(null, { status: 101, webSocket: client } as WorkersResponseInit);

    }

    /**
     * Handle incoming WebSocket message (Hibernation API callback)
     */
    async handleMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
        if (typeof message === 'string') {
            ws.send(JSON.stringify({ error: 'Binary protocol required' }));
            return;
        }

        if (message.byteLength === 0) return;

        const data = new Uint8Array(message);

        try {
            // Buffer the operation
            this.operations.push(data);

            // Broadcast to all connected clients
            this.broadcast(message);

            // Persist snapshot periodically
            this.operationCount++;
            if (this.operationCount >= this.config.persistInterval) {
                await this.persist();
                this.operationCount = 0;
            }
        } catch (error) {
            console.error('[EdgeSync] Error processing message:', error);
        }
    }



    /**
     * Handle WebSocket close (Hibernation API callback)
     */
    handleClose(_ws: WebSocket, code: number, reason: string): void {
        if (this.config.debug) {
            console.log(`[EdgeSync] Client disconnected: ${code} ${reason}`);
        }
    }

    /**
     * Handle WebSocket error (Hibernation API callback)
     */
    handleError(_ws: WebSocket, error: unknown): void {
        console.error('[EdgeSync] WebSocket error:', error);
    }

    /**
     * Create Init packet from current state for new clients.
     * The Init packet contains all operations that need to be replayed.
     */
    createInitPacket(): Uint8Array {
        // Simple Init packet format:
        // [1 byte: msgType=1] [4 bytes: operation count] [operations...]
        const header = new Uint8Array(5);
        header[0] = INIT_MSG_TYPE;

        // Write operation count as little-endian uint32
        const count = this.operations.length;
        header[1] = count & 0xff;
        header[2] = (count >> 8) & 0xff;
        header[3] = (count >> 16) & 0xff;
        header[4] = (count >> 24) & 0xff;

        // Concatenate all operations
        const totalLength = header.length + this.operations.reduce((sum, op) => sum + 4 + op.length, 0);
        const packet = new Uint8Array(totalLength);
        packet.set(header, 0);

        let offset = header.length;
        for (const op of this.operations) {
            // Write operation length as little-endian uint32
            packet[offset++] = op.length & 0xff;
            packet[offset++] = (op.length >> 8) & 0xff;
            packet[offset++] = (op.length >> 16) & 0xff;
            packet[offset++] = (op.length >> 24) & 0xff;
            packet.set(op, offset);
            offset += op.length;
        }

        return packet;
    }

    /**
     * Get current operations count
     */
    getOperationCount(): number {
        return this.operations.length;
    }

    /**
     * Broadcast message to all connected WebSockets
     */
    private broadcast(message: ArrayBuffer): void {
        const sockets = this.state.getWebSockets();
        for (const socket of sockets) {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(message);
            }
        }
    }

    /**
     * Hydrate state from persistent storage
     */
    private async hydrate(): Promise<void> {
        try {
            const data = await this.state.storage.get<Uint8Array[] | { operations: number[][] }>('snapshot');

            if (data) {
                if (Array.isArray(data)) {
                    this.operations = data as Uint8Array[];
                } else if (data.operations) {
                    // Migration path for legacy snapshots
                    this.operations = data.operations.map(arr => new Uint8Array(arr));
                }

                if (this.config.debug) {
                    console.log(`[EdgeSync] Hydrated ${this.operations.length} operations`);
                }
            }
        } catch (e) {
            console.error('[EdgeSync] Hydration FAILED:', e);
        }
    }


    /**
     * Persist current state to storage.
     * Zen Goal: Zero allocations during persistence.
     */
    private async persist(): Promise<void> {
        try {
            // In Cloudflare, we can store Uint8Array directly. 
            // Storing as JSON-serialized number arrays (Array.from) is a "Happy Path" trap.
            await this.state.storage.put('snapshot', this.operations);
            if (this.config.debug) {
                console.log(`[EdgeSync] Persisted ${this.operations.length} operations`);
            }
        } catch (e) {
            console.error('[EdgeSync] Persistence FAILED:', e);
        }
    }

}
