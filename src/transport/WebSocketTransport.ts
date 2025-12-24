import { EventEmitter } from '../utils/EventEmitter';
import { Transport, TransportEvents, TransportStatus } from './Transport';
import { ConnectionError } from '../errors';
import { OpCode } from './protocol';

export interface WebSocketTransportConfig {
    url: string;
    autoReconnect?: boolean;
    maxReconnectAttempts?: number;
    reconnectBaseDelay?: number;
    maxReconnectDelay?: number;
    connectionTimeout?: number;
    heartbeatInterval?: number;
    heartbeatMaxMissed?: number;
    debug?: boolean;
    /** When true, all messages use JSON format for debugging. Default: false (binary protocol). */
    debugProtocol?: boolean;
}

/**
 * Standardized WebSocket Transport handling connection lifecycle, 
 * heartbeat, and exponential backoff reconnection.
 */
export class WebSocketTransport extends EventEmitter<TransportEvents> implements Transport {
    private ws: WebSocket | null = null;
    private status: TransportStatus = 'DISCONNECTED';
    private config: Required<WebSocketTransportConfig>;
    private latency = 0;
    private packetLoss = 0;

    private reconnectAttempts = 0;
    private isIntentionallyClosed = false;
    private reconnectTimer: any = null;
    private heartbeatTimer: any = null;
    private connectionTimeoutTimer: any = null;
    private missedHeartbeats = 0;
    private peers = new Set<string>();
    private pingResolvers = new Map<string, (latency: number) => void>();
    private pingStarts = new Map<string, number>();

    private DEFAULT_CONFIG: Required<WebSocketTransportConfig> = {
        url: '',
        autoReconnect: true,
        maxReconnectAttempts: 10,
        reconnectBaseDelay: 1000,
        maxReconnectDelay: 30000,
        connectionTimeout: 10000,
        heartbeatInterval: 30000,
        heartbeatMaxMissed: 3,
        debug: false,
        debugProtocol: false
    };

    constructor(config: WebSocketTransportConfig) {
        super();
        this.config = { ...this.DEFAULT_CONFIG, ...config };
    }

    public async connect(): Promise<void> {
        if (this.status === 'CONNECTED' || this.status === 'CONNECTING') return;

        this.isIntentionallyClosed = false;
        this.setStatus('CONNECTING');

        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.config.url);
                this.ws.binaryType = 'arraybuffer';

                if (this.config.connectionTimeout > 0) {
                    this.connectionTimeoutTimer = setTimeout(() => {
                        this.handleError(new Error(`Connection timed out after ${this.config.connectionTimeout}ms`));
                        reject(new ConnectionError('Connection timed out'));
                    }, this.config.connectionTimeout);
                }

                this.ws.onopen = () => {
                    this.clearConnectionTimeout();
                    this.setStatus('CONNECTED');
                    this.reconnectAttempts = 0;
                    this.startHeartbeat();
                    resolve();
                };

                this.ws.onmessage = (event) => this.handleMessage(event);

                this.ws.onclose = (event) => {
                    const wasConnecting = this.status === 'CONNECTING';
                    this.handleClose(event);
                    if (wasConnecting) {
                        reject(new ConnectionError(`WebSocket closed with code ${event.code}`));
                    }
                };

                this.ws.onerror = () => {
                    const err = new Error('WebSocket Error');
                    this.handleError(err);
                    if (this.status === 'CONNECTING') {
                        reject(new ConnectionError('WebSocket error during connection'));
                    }
                };
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                this.handleError(error);
                reject(error);
            }
        });
    }

    public disconnect(): void {
        this.isIntentionallyClosed = true;
        this.stopHeartbeat();
        this.clearReconnectTimer();
        this.clearConnectionTimeout();

        if (this.ws) {
            this.ws.close(1000, 'Intentional Disconnect');
            this.ws = null;
        }
        this.setStatus('DISCONNECTED');
    }

    public getStatus(): TransportStatus {
        return this.status;
    }

    public send(data: Uint8Array): void {
        if (this.status !== 'CONNECTED' || !this.ws) return;

        if (this.packetLoss > 0 && Math.random() < this.packetLoss) {
            this.log('Packet dropped (simulated)');
            return;
        }

        let packet: Uint8Array | string;

        if (this.config.debugProtocol) {
            // Debug mode: Send as JSON text for human readability
            const json = { type: 'op', payload: Array.from(data) };
            packet = JSON.stringify(json);
        } else {
            // Production mode: Binary with OpCode prefix
            const binary = new Uint8Array(data.length + 1);
            binary[0] = OpCode.ENGINE;
            binary.set(data, 1);
            packet = binary;
        }

        if (this.latency > 0) {
            setTimeout(() => this.ws?.send(packet), this.latency);
        } else {
            this.ws.send(packet);
        }
    }

    public sendEphemeral(payload: any, to?: string): void {
        if (this.status !== 'CONNECTED' || !this.ws) return;

        if (this.packetLoss > 0 && Math.random() < this.packetLoss) {
            this.log('Packet dropped (simulated)');
            return;
        }

        let packet: Uint8Array;

        if (payload instanceof Uint8Array) {
            if (to) {
                // Binary Direct: [OpCode.DIRECT][ToLen][To][Payload]
                const toBytes = new TextEncoder().encode(to);
                packet = new Uint8Array(2 + toBytes.length + payload.length);
                packet[0] = OpCode.DIRECT;
                packet[1] = toBytes.length;
                packet.set(toBytes, 2);
                packet.set(payload, 2 + toBytes.length);
            } else {
                // Binary Broadcast: [OpCode.EPHEMERAL][Payload]
                packet = new Uint8Array(payload.length + 1);
                packet[0] = OpCode.EPHEMERAL;
                packet.set(payload, 1);
            }
        } else {
            // Legacy/JSON System Message: [OpCode.SYSTEM][JSON String]
            const json = JSON.stringify({ type: 'ephemeral', payload, to });
            const encoded = new TextEncoder().encode(json);
            packet = new Uint8Array(encoded.length + 1);
            packet[0] = OpCode.SYSTEM;
            packet.set(encoded, 1);
        }

        if (this.latency > 0) {
            setTimeout(() => this.ws?.send(packet), this.latency);
        } else {
            this.ws.send(packet);
        }
    }

    public broadcast(data: Uint8Array): void {
        this.send(data);
    }

    public simulateLatency(ms: number): void {
        this.latency = ms;
    }

    public simulatePacketLoss(rate: number): void {
        this.packetLoss = rate;
    }

    public getPeers(): string[] {
        return Array.from(this.peers);
    }

    public async ping(peerId: string): Promise<number> {
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(2, 11);
            const start = performance.now();

            const timeout = setTimeout(() => {
                this.pingResolvers.delete(requestId);
                this.pingStarts.delete(requestId);
                reject(new Error('Ping timeout'));
            }, 5000);

            this.pingStarts.set(requestId, start);
            this.pingResolvers.set(requestId, (latency) => {
                clearTimeout(timeout);
                resolve(latency);
            });

            this.sendEphemeral({
                type: '__ping__',
                requestId,
                timestamp: Date.now()
            }, peerId);
        });
    }

    private setStatus(newStatus: TransportStatus): void {
        if (this.status !== newStatus) {
            this.log(`Status: ${this.status} -> ${newStatus}`);
            this.status = newStatus;
            this.emit('status', newStatus);
        }
    }

    private handleMessage(event: MessageEvent): void {
        const data = event.data;

        // Handle string messages directly (legacy/test path)
        if (typeof data === 'string') {
            if (data === '__ping__' || data.includes('__ping__')) {
                this.handlePingPong(data);
                return;
            }
            // Legacy string messages go directly to JSON handler - no OpCode processing
            this.handleJsonMessage(data);
            return;
        }

        // Binary path: data is ArrayBuffer
        const bytes = new Uint8Array(data);
        if (bytes.length === 0) return;

        const opCode = bytes[0];
        const payload = bytes.subarray(1);

        switch (opCode) {
            case OpCode.ENGINE:
                this.emit('message', payload);
                break;
            case OpCode.EPHEMERAL:
                this.emit('ephemeral', payload); // Emit raw binary
                break;
            case OpCode.DIRECT:
                // Direct messages: server strips routing, just emit payload as ephemeral
                this.emit('ephemeral', payload);
                break;
            case OpCode.SYSTEM:
                // System message: payload is JSON string bytes
                try {
                    const text = new TextDecoder().decode(payload);
                    this.handleJsonMessage(text);
                } catch (e) {
                    this.emit('message', bytes);
                }
                break;
            default:
                // Unknown OpCode - drop the packet (protocol violation)
                // In a greenfield project, we enforce strict protocol compliance
                console.warn(`[WebSocketTransport] Unknown OpCode: 0x${opCode.toString(16).padStart(2, '0')}`);
                break;
        }
    }

    private handlePingPong(_data: string): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send('__pong__');
        }
    }

    private handleJsonMessage(data: string): void {
        if (data === '__ping__' || (typeof data === 'string' && data.includes('__ping__'))) {
            this.handlePingPong(data);
            return;
        }
        if (data === '__pong__') return;

        try {
            const json = JSON.parse(data);
            // ... (rest of legacy JSON handling)
            if (json.type === 'ephemeral' || json.type === 'presence') {
                if (json.type === 'presence') {
                    const payload = json.payload || json;
                    const { userId, status } = payload;
                    if (status === 'online') {
                        this.peers.add(userId);
                        this.emit('peerJoin', userId);
                    } else if (status === 'offline') {
                        this.peers.delete(userId);
                        this.emit('peerDisconnect', userId);
                    }
                    this.emit('presence', payload);
                } else {
                    const payload = json.payload;
                    const from = json.from;

                    if (payload && payload.type === '__ping__') {
                        this.sendEphemeral({
                            type: '__pong__',
                            requestId: payload.requestId,
                            timestamp: Date.now()
                        }, from);
                    } else if (payload && payload.type === '__pong__') {
                        const resolver = this.pingResolvers.get(payload.requestId);
                        const start = this.pingStarts.get(payload.requestId);
                        if (resolver && start) {
                            resolver(performance.now() - start);
                            this.pingResolvers.delete(payload.requestId);
                            this.pingStarts.delete(payload.requestId);
                        }
                    }

                    this.emit('ephemeral', payload, from);
                }
            } else if (json.type === 'init' || json.type === 'op' || json.op) {
                // If we receive legacy JSON ops, convert to binary but strip nothing?
                // Just emit the raw original bytes (without OpCode stripping if it was text)
                // But here 'data' is the decoded text payload.
                this.emit('message', new TextEncoder().encode(JSON.stringify(json)));
            } else {
                this.emit('ephemeral', json);
            }
        } catch (e) {
            console.error('Failed to parse system message', e);
        }
    }

    private static readonly TERMINAL_CODES = new Set([
        1008, // Policy Violation
        1011, // Internal Error
        4000, // Invalid Protocol
        4001, // Authentication Failed
        4003  // Access Denied
    ]);

    private handleClose(event: CloseEvent): void {
        this.stopHeartbeat();
        this.clearConnectionTimeout();

        const code = Number(event.code || 0);

        console.error(`[WebSocketTransport] Connection closed: ${code}`);

        // Inline cleanup
        if (this.ws) {
            this.ws.onopen = null;
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.onmessage = null;
            this.ws = null;
        }

        if (WebSocketTransport.TERMINAL_CODES.has(code)) {
            // CRITICAL: Do not retry on terminal codes.
            console.error(`[WebSocketTransport] Terminal code ${code} -> ERROR`);
            this.setStatus('ERROR');
            return;
        }

        if (this.isIntentionallyClosed || code === 1000 || code === 1001 || code === 1005) {
            this.setStatus('DISCONNECTED');
            return;
        }

        if (this.config.autoReconnect === false) {
            this.setStatus('DISCONNECTED');
            return;
        }

        this.setStatus('RECONNECTING');
        this.attemptReconnect();
    }

    private handleError(error: Error): void {
        this.log('Error', error);
        this.emit('error', error);
    }

    private attemptReconnect(): void {
        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
            this.log('Max reconnect attempts reached');
            this.setStatus('ERROR');
            return;
        }

        const delay = Math.min(
            this.config.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts),
            this.config.maxReconnectDelay
        );

        this.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectAttempts++;
            this.connect().catch(() => { });
        }, delay);
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        if (this.config.heartbeatInterval <= 0) return;

        this.missedHeartbeats = 0;
        this.heartbeatTimer = setInterval(() => {
            if (this.status !== 'CONNECTED' || !this.ws) return;

            this.missedHeartbeats++;
            if (this.missedHeartbeats >= (this.config.heartbeatMaxMissed || 3)) {
                this.log('Heartbeat lost - closing connection');
                this.ws.close(4000, 'Heartbeat Timeout');
                this.handleClose({ code: 4000 } as any);
                return;
            }

            try {
                this.ws.send('__ping__');
            } catch (e) {
                this.handleError(e instanceof Error ? e : new Error(String(e)));
            }
        }, this.config.heartbeatInterval);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private clearConnectionTimeout(): void {
        if (this.connectionTimeoutTimer) {
            clearTimeout(this.connectionTimeoutTimer);
            this.connectionTimeoutTimer = null;
        }
    }

    private log(msg: string, ...args: any[]): void {
        if (this.config.debug) {
            console.log(`[WebSocketTransport] ${msg}`, ...args);
        }
    }
}
