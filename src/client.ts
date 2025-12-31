/**
 * NMeshed v2 - Client
 * 
 * The Zen Garden: Deceptively simple, impossible to use incorrectly.
 * This is the only file users need to understand.
 */

import type { NMeshedConfig, ConnectionStatus, ClientEvents, EventHandler, INMeshedClient } from './types';
import { SyncEngine } from './engine';
import { WebSocketTransport } from './transport';
import { encodeOp, decodeMessage, MsgType } from './protocol';

// =============================================================================
// NMeshed Client
// =============================================================================

export class NMeshedClient implements INMeshedClient {
    private config: NMeshedConfig;
    private engine: SyncEngine;
    private transport: WebSocketTransport;
    private debug: boolean;
    private unsubscribers: (() => void)[] = [];

    constructor(config: NMeshedConfig) {
        // Validate config at the gates
        if (!config.workspaceId) {
            throw new Error('[NMeshed] workspaceId is required');
        }
        if (!config.token && !config.apiKey) {
            throw new Error('[NMeshed] token or apiKey is required');
        }

        this.config = config;
        this.debug = config.debug || false;

        // Generate peer ID
        const peerId = config.userId || this.generatePeerId();

        // Initialize engine and transport
        this.engine = new SyncEngine(peerId, this.debug);
        this.transport = new WebSocketTransport(config);

        // Wire up transport to engine
        this.wireTransport();

        // Auto-connect
        this.connect();
    }

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /** Get a value by key */
    get<T = unknown>(key: string): T | undefined {
        return this.engine.get<T>(key);
    }

    /** Set a key-value pair */
    set<T = unknown>(key: string, value: T): void {
        const payload = this.engine.set(key, value);

        // Send to network
        if (this.transport.isConnected()) {
            const wireData = encodeOp(key, payload);
            this.transport.send(wireData);
        }
    }

    /** Delete a key */
    delete(key: string): void {
        const payload = this.engine.delete(key);

        if (this.transport.isConnected()) {
            const wireData = encodeOp(key, payload);
            this.transport.send(wireData);
        }
    }

    /** Subscribe to events */
    on<K extends keyof ClientEvents>(event: K, handler: EventHandler<K>): () => void {
        return this.engine.on(event, handler);
    }

    /** Get current connection status */
    getStatus(): ConnectionStatus {
        return this.engine.getStatus();
    }

    /** Get client's peer ID */
    getPeerId(): string {
        return this.engine.getPeerId();
    }

    /** Get all values */
    getAllValues(): Record<string, unknown> {
        return this.engine.getAllValues();
    }

    /** Iterate over all entries */
    forEach(callback: (value: unknown, key: string) => void): void {
        this.engine.forEach(callback);
    }

    /** Wait for ready state */
    async awaitReady(): Promise<void> {
        if (this.getStatus() === 'ready') return;

        return new Promise((resolve) => {
            const unsub = this.on('ready', () => {
                unsub();
                resolve();
            });
        });
    }

    /** Disconnect and cleanup */
    disconnect(): void {
        this.unsubscribers.forEach((unsub) => unsub());
        this.transport.disconnect();
        this.engine.destroy();
    }

    // ---------------------------------------------------------------------------
    // Private
    // ---------------------------------------------------------------------------

    private async connect(): Promise<void> {
        this.engine.setStatus('connecting');

        try {
            await this.transport.connect();
            this.engine.setStatus('connected');
            // Server sends Init packet with snapshot, which triggers 'ready'
        } catch (error) {
            this.engine.setStatus('error');
            this.engine.emit('error', error instanceof Error ? error : new Error(String(error)));
        }
    }

    private wireTransport(): void {
        // Handle incoming messages
        const unsubMessage = this.transport.onMessage((data) => {
            this.handleMessage(data);
        });
        this.unsubscribers.push(unsubMessage);

        // Handle disconnection
        const unsubClose = this.transport.onClose(() => {
            this.engine.setStatus('reconnecting');
        });
        this.unsubscribers.push(unsubClose);
    }

    private handleMessage(data: Uint8Array): void {
        const msg = decodeMessage(data); // New helper
        if (!msg) return;

        switch (msg.type) {
            case MsgType.Init:
                // Load snapshot and transition to ready
                if (msg.payload) {
                    this.engine.loadSnapshot(msg.payload);
                    this.engine.setStatus('ready');
                    this.engine.emit('ready');
                }
                break;

            case MsgType.Op:
                // Apply remote operation
                if (msg.key && msg.payload) {
                    this.engine.applyRemote(msg.key, msg.payload, 'remote');
                }
                break;
        }
    }

    private generatePeerId(): string {
        return `peer_${Math.random().toString(36).substring(2, 11)}`;
    }

    private log(...args: unknown[]): void {
        if (this.debug) {
            console.log('[NMeshed Client]', ...args);
        }
    }
}
