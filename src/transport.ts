/**
 * NMeshed v2 - Transport Layer
 * 
 * Non-Resistance: Like water, data never waits.
 * Simple WebSocket transport with automatic reconnection.
 */

import type { Transport, NMeshedConfig } from './types';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_SERVER_URL = 'wss://api.nmeshed.com';
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];

// =============================================================================
// WebSocket Transport
// =============================================================================

export class WebSocketTransport implements Transport {
    private ws: WebSocket | null = null;
    private url: string;
    private token: string;
    private messageHandlers: Set<(data: Uint8Array) => void> = new Set();
    private closeHandlers: Set<() => void> = new Set();
    private reconnectAttempt = 0;
    private shouldReconnect = true;
    private debug: boolean;

    constructor(config: NMeshedConfig) {
        this.token = config.token || config.apiKey || '';
        this.debug = config.debug || false;

        // "Zero Config" Routing:
        // If the token indicates a local environment, default to localhost.
        // This removes the need for consumers to specify serverUrl in dev.
        const isLocalToken = this.token.startsWith('nm_local_');
        const defaultUrl = isLocalToken ? 'ws://localhost:9000' : DEFAULT_SERVER_URL;

        const baseUrl = config.serverUrl || defaultUrl;
        // Server expects: /ws?workspace_id=...
        this.url = `${baseUrl}/ws?workspace_id=${config.workspaceId}`;
    }

    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                // Append token to the existing query params
                const wsUrl = `${this.url}&token=${encodeURIComponent(this.token)}`;
                this.ws = new WebSocket(wsUrl);
                this.ws.binaryType = 'arraybuffer';

                this.ws.onopen = () => {
                    this.reconnectAttempt = 0;
                    this.log('Connected');
                    resolve();
                };

                this.ws.onerror = (event) => {
                    this.log('WebSocket error', event);
                    reject(new Error('WebSocket connection failed'));
                };

                this.ws.onmessage = (event) => {
                    const data = new Uint8Array(event.data as ArrayBuffer);
                    this.messageHandlers.forEach((handler) => handler(data));
                };

                this.ws.onclose = () => {
                    this.log('Disconnected');
                    this.closeHandlers.forEach((handler) => handler());
                    this.attemptReconnect();
                };
            } catch (error) {
                reject(error);
            }
        });
    }

    disconnect(): void {
        this.shouldReconnect = false;
        this.ws?.close();
        this.ws = null;
    }

    send(data: Uint8Array): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(data);
        }
    }

    onMessage(handler: (data: Uint8Array) => void): () => void {
        this.messageHandlers.add(handler);
        return () => this.messageHandlers.delete(handler);
    }

    onClose(handler: () => void): () => void {
        this.closeHandlers.add(handler);
        return () => this.closeHandlers.delete(handler);
    }

    isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    // ---------------------------------------------------------------------------
    // Private
    // ---------------------------------------------------------------------------

    private attemptReconnect(): void {
        if (!this.shouldReconnect) return;

        const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
        this.reconnectAttempt++;

        this.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

        setTimeout(() => {
            if (this.shouldReconnect) {
                this.connect().catch((error) => {
                    this.log('Reconnect failed', error);
                });
            }
        }, delay);
    }

    private log(...args: unknown[]): void {
        if (this.debug) {
            console.log('[NMeshed Transport]', ...args);
        }
    }
}
