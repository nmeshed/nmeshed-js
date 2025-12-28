
/**
 * Unified interface for moving bytes and ephemeral messages.
 * This decouples the 'How' (WebSocket, WebRTC, Bluetooth) from the 'What' (CRDTs, Cursors).
 */
export type TransportStatus = 'IDLE' | 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'ERROR' | 'READY';

export interface TransportEvents {
    [key: string]: any[];
    status: [status: TransportStatus];
    message: [data: Uint8Array];              // All binary data (Ops, Syncs, Signals)
    init: [data: Record<string, unknown>];    // JSON init snapshots
    ephemeral: [payload: any, from?: string]; // Unreliable/Lossy (Cursors)
    presence: [user: any];
    peerJoin: [peerId: string];
    peerDisconnect: [peerId: string];
    error: [error: Error];
}

export interface Transport {
    connect(heads?: string[]): Promise<void>;
    disconnect(): void;
    getStatus(): TransportStatus;

    // Core Data
    send(data: Uint8Array): void;            // Direct send to authority/everyone
    broadcast(data: Uint8Array): void;       // Optimized broadcast

    // Ephemeral Data
    sendEphemeral(payload: any, to?: string): void;
    simulateLatency(ms: number): void;
    simulatePacketLoss(rate: number): void;

    // Discovery
    getPeers(): string[];
    ping(peerId: string): Promise<number>;

    // Event Subscription
    on<K extends keyof TransportEvents>(
        event: K,
        handler: (...args: TransportEvents[K]) => void
    ): () => void;
}
