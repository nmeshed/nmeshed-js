import { EventEmitter } from '../utils/EventEmitter';
import { Transport, TransportStatus, TransportEvents } from './Transport';

export interface WebSocketTransportConfig {
    workspaceId: string;
    peerId: string;
    token: string;
    tokenProvider?: () => Promise<string | null>;
    debug?: boolean;
    heartbeatInterval?: number;
    heartbeatMaxMissed?: number;
    connectionTimeout?: number;
    autoReconnect?: boolean;
    maxReconnectAttempts?: number;
    /** Base delay for reconnection backoff in ms (default: 1000) */
    initialReconnectDelay?: number;
    /** Maximum delay between reconnect attempts in ms (default: 10000) */
    maxReconnectDelay?: number;
}

export class WebSocketTransport extends EventEmitter<TransportEvents> implements Transport {
    private ws: WebSocket | null = null;
    private status: TransportStatus = 'IDLE';
    private config: WebSocketTransportConfig;
    private reconnectAttempts = 0;
    private heartbeatTimer: any = null;
    private missedHeartbeats = 0;
    private isIntentionallyClosed = false;
    private latencySim = 0;
    private lossSim = 0;

    private DEFAULT_CONFIG: WebSocketTransportConfig = {
        workspaceId: '',
        peerId: '',
        token: '',
        debug: false,
        heartbeatInterval: 30000,
        heartbeatMaxMissed: 3,
        connectionTimeout: 30000,
        autoReconnect: true,
        maxReconnectAttempts: 5,
        tokenProvider: undefined,
        initialReconnectDelay: 1000,
        maxReconnectDelay: 10000
    };

    constructor(private readonly url: string, config: Partial<WebSocketTransportConfig>) {
        super();
        this.config = { ...this.DEFAULT_CONFIG };
        // Only override with defined values
        Object.keys(config).forEach(key => {
            const val = (config as any)[key];
            if (val !== undefined) {
                (this.config as any)[key] = val;
            }
        });
    }

    public getStatus(): TransportStatus {
        return this.status;
    }

    public async connect(_heads?: string[]): Promise<void> {
        if (this.status === 'CONNECTED' || this.status === 'CONNECTING') {
            return Promise.resolve();
        }

        // Fetch dynamic token if provider exists (BEFORE starting connection)
        if (this.config.tokenProvider) {
            try {
                const token = await this.config.tokenProvider();
                if (token) this.config.token = token;
            } catch (e) {
                console.warn('[WebSocketTransport] Token provider failed', e);
            }
        }

        this.setStatus('CONNECTING');
        this.isIntentionallyClosed = false;

        return new Promise((resolve, reject) => {
            let timeout: any = null;
            if (this.config.connectionTimeout! > 0) {
                timeout = setTimeout(() => {
                    if (this.status === 'CONNECTING') {
                        this.disconnect();
                        const err = new Error('Connection timed out');
                        (err as any).isVisibleInTests = true;
                        reject(err);
                    }
                }, this.config.connectionTimeout);
            }

            try {
                let url = this.url;
                if (this.config.token) {
                    const separator = url.includes('?') ? '&' : '?';
                    url += `${separator}token=${encodeURIComponent(this.config.token)}`;
                }

                this.ws = new WebSocket(url);
                this.ws.binaryType = 'arraybuffer';

                this.ws.onopen = () => {
                    if (timeout) clearTimeout(timeout);
                    this.setStatus('CONNECTED');
                    this.reconnectAttempts = 0;
                    this.startHeartbeat();
                    resolve();
                };

                this.ws.onmessage = (event) => this.handleRawMessage(event);
                this.ws.onclose = (event) => {
                    if (timeout) clearTimeout(timeout);
                    this.handleClose(event);
                    if (this.status === 'CONNECTING') reject(new Error(`Closed with code: ${event.code}`));
                };
                this.ws.onerror = (error) => {
                    if (timeout) clearTimeout(timeout);
                    this.emit('error', error as any);
                    if (this.status === 'CONNECTING') {
                        reject(error);
                    }
                };
            } catch (e) {
                if (timeout) clearTimeout(timeout);
                reject(e);
            }
        });
    }

    public disconnect(): void {
        this.isIntentionallyClosed = true;
        this.setStatus('DISCONNECTED');
        this.stopHeartbeat();
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
    }

    public send(data: Uint8Array): void {
        this.transmit(data);
    }

    public broadcast(payload: Uint8Array): void {
        // console.log(`[WebSocketTransport] Broadcasting ${payload.length} bytes. Status: ${this.status}`);
        this.transmit(payload);
    }

    public sendEphemeral(payload: Uint8Array, _to?: string): void {
        // Wrap in WirePacket (MsgType::Signal = 0x04)
        // [MsgType(1)] [Len(4)] [Payload]
        const len = payload.length;
        const packet = new Uint8Array(1 + 4 + len);
        const view = new DataView(packet.buffer);

        view.setUint8(0, 0x04); // MsgType::Signal
        view.setUint32(1, len, true); // Little Endian
        packet.set(payload, 5);

        this.transmit(packet);
    }

    private transmit(data: string | Uint8Array | ArrayBuffer): void {
        if (!this.ws || this.status !== 'CONNECTED') return;

        try {
            if (this.lossSim > 0 && Math.random() < this.lossSim) return;

            if (this.latencySim > 0) {
                setTimeout(() => {
                    try {
                        this.ws?.send(data);
                    } catch (e) {
                        if (this.config.debug) console.warn('[WebSocketTransport] Delayed send failed', e);
                    }
                }, this.latencySim);
            } else {
                this.ws.send(data);
            }
        } catch (e) {
            // if (this.config.debug) console.error('[WebSocketTransport] Send failed', e);
        }
    }

    private handleRawMessage(event: MessageEvent): void {
        const data = event.data;

        if (typeof data === 'string') {
            if (data === '\x00') {
                this.missedHeartbeats = 0;
                return;
            }
            // Legacy/Debug: If we receive a string, emit it as bytes
            this.emit('message', new TextEncoder().encode(data));
            return;
        }

        if (data instanceof ArrayBuffer) {
            // Browser ArrayBuffer
            this.emit('message', new Uint8Array(data));
        } else if (data instanceof Uint8Array) {
            // Already Uint8Array
            this.handleBinaryMessage(data);
        } else if (ArrayBuffer.isView(data)) {
            // TypedArray or DataView
            this.handleBinaryMessage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
            // Node.js Buffer (common in ws library)
            this.handleBinaryMessage(new Uint8Array(data));
        } else if (data && typeof data === 'object' && (data as any).byteLength !== undefined) {
            // Duck-typed ArrayBuffer-like object
            this.handleBinaryMessage(new Uint8Array(data as any));
        } else {
            console.warn('[WebSocketTransport] Received unknown data type:', typeof data, (data as any)?.constructor?.name);
        }
    }

    private handleBinaryMessage(data: Uint8Array): void {
        if (data.length < 5) return;

        const msgType = data[0];
        // 0x01 = Op, 0x02 = Sync, 0x03 = Presence, 0x04 = Signal

        if (msgType === 0x03) { // Presence
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            const payloadLen = view.getUint32(1, true); // Little Endian

            if (data.length < 5 + payloadLen) {
                console.warn('[WebSocketTransport] Truncated Presence packet');
                return;
            }

            // Parse Presence Payload
            // [WorkspaceUuid (16)] [UserIdLen (4)] [UserId (?)] [Status (1)]
            let offset = 5;
            // Skip Workspace UUID (16 bytes)
            offset += 16;

            if (offset + 4 > data.length) return;
            const userIdLen = view.getUint32(offset, true);
            offset += 4;

            if (offset + userIdLen + 1 > data.length) return;
            const userIdBytes = data.subarray(offset, offset + userIdLen);
            const userId = new TextDecoder().decode(userIdBytes);
            offset += userIdLen;

            const status = data[offset]; // 0=Join, 1=Leave

            if (status === 0) {
                this.emit('peerJoin', userId);
            } else if (status === 1) {
                this.emit('peerDisconnect', userId);
            }
            return;
        } else if (msgType === 0x04) { // Signal (Ephemeral)
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            const payloadLen = view.getUint32(1, true);

            if (data.length < 5 + payloadLen) {
                console.warn('[WebSocketTransport] Truncated Signal packet');
                return;
            }

            // Parse Signal Payload (S->C)
            // [SenderIdLen (4)] [SenderId] [ValueLen (4)] [Value]
            let offset = 5;
            if (offset + 4 > data.length) return;

            const senderIdLen = view.getUint32(offset, true);
            offset += 4;

            if (offset + senderIdLen > data.length) return;
            const senderIdBytes = data.subarray(offset, offset + senderIdLen);
            const senderId = new TextDecoder().decode(senderIdBytes);
            offset += senderIdLen;

            if (offset + 4 > data.length) return;
            const valueLen = view.getUint32(offset, true);
            offset += 4;

            if (offset + valueLen > data.length) return;
            const value = data.subarray(offset, offset + valueLen);

            // Emit ephemeral event
            this.emit('ephemeral', value, senderId);
            return;
        }

        // For Ops (0x01) and Sync (0x02), we emit as generic 'message'
        // The SyncEngine handles parsing Ops/Sync via WASM or internal logic.
        // We do strictly pass generic messages to the engine.
        this.emit('message', data);
    }


    private handleClose(event: CloseEvent): void {
        this.stopHeartbeat();

        const code = event.code;
        const isClean = code === 1000 || code === 1001 || code === 1005;

        // Reset ws if closed
        this.ws = null;

        if (this.isIntentionallyClosed || isClean) {
            this.setStatus('DISCONNECTED');
            return;
        }

        const TERMINAL_CODES = new Set([4000, 4001, 4002, 4003, 1002, 1003, 1007, 1008, 1009, 1010]);
        if (TERMINAL_CODES.has(code)) {
            this.setStatus('ERROR');
            return;
        }

        if (this.config.autoReconnect && this.reconnectAttempts < this.config.maxReconnectAttempts!) {
            this.status = 'IDLE';
            this.setStatus('RECONNECTING');
            this.reconnectAttempts++;
            const baseDelay = this.config.initialReconnectDelay ?? 1000;
            const maxDelay = this.config.maxReconnectDelay ?? 10000;
            const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), maxDelay);
            setTimeout(() => {
                if (!this.isIntentionallyClosed && this.status === 'RECONNECTING') {
                    this.connect().catch(() => { });
                }
            }, delay);
        } else {
            this.setStatus(this.reconnectAttempts >= this.config.maxReconnectAttempts! ? 'ERROR' : 'DISCONNECTED');
        }
    }

    private setStatus(s: TransportStatus): void {
        if (this.status === s) return;
        this.status = s;
        this.emit('status', s);
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.missedHeartbeats = 0;
        this.heartbeatTimer = setInterval(() => {
            if (this.missedHeartbeats >= this.config.heartbeatMaxMissed!) {
                this.ws?.close();
                return;
            }
            // Send binary ping (\x01)
            this.transmit('\x01');
            this.missedHeartbeats++;
        }, this.config.heartbeatInterval!);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    public getPeers(): string[] { return []; }
    public async ping(_peerId: string): Promise<number> { return 0; }
    public getLatency(): number {
        // Return simulated latency for testing or 0
        return this.latencySim > 0 ? this.latencySim : 0;
    }

    public simulateLatency(ms: number): void { this.latencySim = ms; }
    public simulatePacketLoss(rate: number): void { this.lossSim = rate; }
}
