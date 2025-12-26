import { EventEmitter } from '../utils/EventEmitter';
import { Transport, TransportEvents, TransportStatus } from './Transport';
import { ConnectionError } from '../errors';

import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';
import { Op } from '../schema/nmeshed/op';

export interface WebSocketTransportConfig {
    url: string;
    autoReconnect?: boolean;
    maxReconnectAttempts?: number;
    reconnectBaseDelay?: number;
    maxReconnectDelay?: number;
    connectionTimeout?: number;
    heartbeatInterval?: number;
    heartbeatMaxMissed?: number;
    // debug?: boolean; // Removed legacy debugProtocol
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
        heartbeatMaxMissed: 3
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

                this.ws.onerror = (event: any) => {
                    // In WS lib, event IS the error. In browser, it's an Event.
                    const errDetail = event instanceof Error ? event : (event.error || event.message || event);
                    const err = new Error(`WebSocket Error: ${errDetail}`);
                    console.error('WS DEBUG ERROR:', errDetail);
                    this.handleError(err);
                    if (this.status === 'CONNECTING') {
                        reject(new ConnectionError(`WebSocket error during connection: ${errDetail}`));
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

    public send(data: Uint8Array | string): void {
        if (this.status !== 'CONNECTED' || !this.ws) return;

        if (this.packetLoss > 0 && Math.random() < this.packetLoss) {
            this.log('Packet dropped (simulated)');
            return;
        }

        let packet: Uint8Array | string | undefined;

        // Production: Pass through the pre-framed WirePacket from the Core/Wasm
        // The Core is responsible for constructing the full WirePacket with Op, Key, Timestamp, etc.
        // WebSocketTransport should not re-wrap it.

        packet = typeof data === 'string'
            ? new TextEncoder().encode(data)
            : data;

        const sendReady = (p: Uint8Array | string) => {
            if (!this.ws) return;

            this.ws.send(p);
        };

        if (this.latency > 0) {
            setTimeout(() => sendReady(packet!), this.latency);
        } else {
            sendReady(packet);
        }
    }

    public sendEphemeral(payload: unknown, to?: string): void {
        const sendReady = (data: string | Uint8Array) => {
            if (!this.ws) return;
            if (this.packetLoss > 0 && Math.random() < this.packetLoss) {
                this.log('Packet dropped (simulated)');
                return;
            }

            const deliver = () => {
                if (!this.ws) return;

                this.ws.send(data);
            };

            if (this.latency > 0) {
                setTimeout(deliver, this.latency);
            } else {
                deliver();
            }
        };

        const builder = new flatbuffers.Builder(1024);

        if (payload instanceof Uint8Array) {
            // Binary Sync/Ephemeral: Wrap in WirePacket [MsgType.Sync]
            const payloadOffset = WirePacket.createPayloadVector(builder, payload);
            WirePacket.startWirePacket(builder);
            WirePacket.addMsgType(builder, MsgType.Sync);
            WirePacket.addPayload(builder, payloadOffset);
            const packetOffset = WirePacket.endWirePacket(builder);
            builder.finish(packetOffset);
            sendReady(builder.asUint8Array());
        } else {
            // JSON Ephemeral: Still wrap in Signal/Sync if possible, or fall back to JSON string for control
            const json = JSON.stringify({ type: 'ephemeral', payload, to });
            sendReady(json);
        }
    }

    public broadcast(data: Uint8Array): void {
        this.sendEphemeral(data);
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

    private setStatus(status: TransportStatus): void {
        if (this.status !== status) {
            this.status = status;
            if (status === 'ERROR') {
                console.error(`[WebSocketTransport] Status changed to ERROR`);
                console.trace();
            }
            this.emit('status', status);
        }
    }

    private handleRawMessage(data: string | ArrayBuffer | Uint8Array): void {
        if (typeof data === 'string') {
            this.handleJsonMessage(data);
            return;
        }

        const bytes = new Uint8Array(data);
        if (bytes.length === 0) return;

        // Optimized Heuristic: JSON control messages start with '{' (123)
        // We handle these first to avoid misinterpretation as malformed FlatBuffers
        if (bytes[0] === 123) {
            try {
                const text = new TextDecoder().decode(bytes);
                this.handleJsonMessage(text);
                return;
            } catch { /* Not JSON, try binary */ }
        }

        try {
            const buf = new flatbuffers.ByteBuffer(bytes);
            const wire = WirePacket.getRootAsWirePacket(buf);
            const msgType = wire.msgType();



            switch (msgType) {
                case MsgType.Op: {
                    // STRICT BINARY PROTOCOL: Use Op table from FlatBuffers
                    const op = wire.op();
                    if (op) {
                        const key = op.key();
                        const valBytes = op.valueArray();

                        // Propagate { key, value } to SyncEngine
                        // Even deletes (null/empty value) should be propagated if they have a key
                        if (key) {
                            this.emit('message', {
                                key: key,
                                value: valBytes || new Uint8Array(0)
                            });
                        }
                    }
                    break;
                }
                case MsgType.Sync: {
                    const payload = wire.payloadArray();
                    if (payload) {
                        this.emit('sync', payload);
                    }
                    break;
                }
                case MsgType.Signal: {
                    const payload = wire.payloadArray();
                    if (payload) {
                        this.emit('ephemeral', payload, 'server');
                    }
                    break;
                }
                default:
                    this.log(`Unknown MsgType: ${msgType}`);
            }
        } catch (e) {
            this.log(`FB Decode failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private handleMessage(event: MessageEvent): void {
        this.handleRawMessage(event.data);
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
        if (data === '__pong__') {
            this.missedHeartbeats = 0;
            return;
        }

        try {
            const json = JSON.parse(data);



            if (json.type === 'peer_join') {
                const userId = json.userId || json.payload?.userId;
                if (userId) {
                    this.peers.add(userId);
                    this.emit('peerJoin', userId);
                    console.log(`[WebSocketTransport] Emitted peerJoin for ${userId}`);
                }
            } else if (json.type === 'peer_leave') {
                const userId = json.userId || json.payload?.userId;
                if (userId) {
                    this.peers.delete(userId);
                    this.emit('peerDisconnect', userId);
                }
            } else if (json.type === 'presence') {
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
            } else if (json.type === 'ephemeral') {
                this.emit('ephemeral', json.payload, json.from);
            } else if (json.type === 'error') {
                console.error(`[WebSocketTransport] Server Error:`, json.error);
                this.emit('error', new Error(json.error));
            } else if (json.type === '__ping__') {
                this.sendEphemeral({
                    type: '__pong__',
                    requestId: json.requestId,
                    timestamp: Date.now()
                }, json.from);
            } else if (json.type === '__pong__') {
                const resolver = this.pingResolvers.get(json.requestId);
                const start = this.pingStarts.get(json.requestId);
                if (resolver && start) {
                    resolver(performance.now() - start);
                }
            } else if (json.type === 'init') {
                this.emit('init', json.payload || json);
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

        if (this.ws) {
            this.ws.onopen = null;
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.onmessage = null;
            this.ws = null;
        }

        if (WebSocketTransport.TERMINAL_CODES.has(code)) {
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

    // @ts-ignore
    private log(_msg: string, ..._args: unknown[]): void {
        // Debug logging removed
    }
}

