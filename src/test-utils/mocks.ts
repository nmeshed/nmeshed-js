import { vi } from 'vitest';
import { ByteBuffer, Builder } from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';
import { Op } from '../schema/nmeshed/op';
import { encodeValue, decodeValue } from '../codec';

/**
 * A centralized Mock WebSocket that simulates binary protocol exchanges.
 * It integrates with MockRelayServer to facilitate simulated P2P/Server communication.
 */
export class MockWebSocket {
    static instances: MockWebSocket[] = [];
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;
    onclose: ((event: any) => void) | null = null;
    onerror: ((event: any) => void) | null = null;

    constructor(public url: string, public server: MockRelayServer) {
        MockWebSocket.instances.push(this);
        // Do not auto-connect. Tests call simulateOpen().
    }

    send(data: any) {
        let parsed: any = { type: 'unknown', data };
        if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) {
            const bytes = ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array(data);

            try {
                const buf = new ByteBuffer(bytes);
                const wire = WirePacket.getRootAsWirePacket(buf);
                const msgType = wire.msgType();
                if (typeof MsgType === 'undefined' || typeof MsgType.Op === 'undefined') {
                    console.error("MOCK WS: MsgType enum is UNDEFINED!");
                }
                // console.log('[MockWebSocket] Parsed MsgType:', msgType);

                if (msgType === MsgType.Op) {
                    const op = wire.op();
                    if (!op) {
                        console.error('MOCK WS: wire.op() returned null!');
                    } else {
                        const key = op.key();
                        const timestamp = Number(op.timestamp());
                        const valBytes = op.valueArray();

                        if (valBytes) {
                            try {
                                const value = decodeValue(valBytes);
                                parsed = {
                                    type: 'op',
                                    payload: {
                                        key: key || '',
                                        value: value,
                                        timestamp: timestamp
                                    }
                                };
                            } catch (e) {
                                // console.error("MOCK WS: Decode Failed on strict Op value", e);
                            }
                        }
                    }
                } else if (msgType === MsgType.Sync) {
                    // Just pass through for now
                    parsed = { type: 'sync', data: bytes };
                }
            } catch (e) {
                console.error("MOCK WS: Binary parse error", e);
            }
        } else if (typeof data === 'object' && data !== null) {
            // Pass-through if already object (MockRelayServer internal optimized path)
            parsed = data;
        } else {
            // String data
            try {
                parsed = JSON.parse(data);
            } catch {
                parsed = { type: 'unknown_string', data };
            }
        }

        if (parsed.type === 'unknown_binary') {
            console.error("MOCK WS: Received UNKNOWN BINARY from client:", Array.from(new Uint8Array(data)));
        } else if (parsed.type === 'unknown') {
            console.error("MOCK WS: Received UNKNOWN message:", parsed);
        } else if (parsed.type === 'op') {
            // console.log("MOCK WS: Parsed OP:", parsed.payload);
        }

        this.server.onMessage(this, parsed);
    }

    close() {
        this.readyState = MockWebSocket.CLOSED;
        this.server.disconnect(this);
        this.onclose?.({ code: 1000, reason: 'Test Close' });
    }

    // Helper to receive message FROM the Mock Server -> Client
    simulateServerMessage(msg: any) {
        if (!this.onmessage) return;

        // Special handling for 'init' messages which traverse as plain JSON in tests
        if (msg.type === 'init') {
            const json = JSON.stringify(msg);
            this.onmessage({ data: json });
            return;
        }

        // For ops, wrap in a proper WirePacket to simulate production server
        if (msg.type === 'op' && msg.payload) {
            const builder = new Builder(1024);
            const valBytes = encodeValue(msg.payload.value);
            const valOffset = Op.createValueVector(builder, valBytes);
            const keyOffset = builder.createString(msg.payload.key);
            const wsOffset = builder.createString('');

            Op.startOp(builder);
            Op.addKey(builder, keyOffset);
            Op.addWorkspaceId(builder, wsOffset);
            Op.addValue(builder, valOffset);
            Op.addTimestamp(builder, BigInt(msg.payload.timestamp || Date.now()));
            const opOffset = Op.endOp(builder);

            // STRICT: Op only
            // const payloadOffset = WirePacket.createPayloadVector(builder, valBytes);

            WirePacket.startWirePacket(builder);
            WirePacket.addMsgType(builder, MsgType.Op);
            WirePacket.addOp(builder, opOffset);
            // WirePacket.addPayload(builder, payloadOffset);
            const packetOffset = WirePacket.endWirePacket(builder);
            builder.finish(packetOffset);

            const bytes = builder.asUint8Array();
            // Emit as array buffer slice to mimic WS behavior (often gives ArrayBuffer)
            this.onmessage({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as any });
            return;
        }

        // Fallback for generic/ephemeral messages
        const json = JSON.stringify(msg);
        const bytes = new TextEncoder().encode(json);
        this.onmessage({
            data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        });
    }

    // Compatibility methods for client.test.ts
    simulateOpen() {
        this.readyState = MockWebSocket.OPEN;
        this.server.connect(this); // Register with mock server
        this.onopen?.();
    }

    simulateClose(code: number = 1000, reason: string = '') {
        this.readyState = MockWebSocket.CLOSED;
        this.server.disconnect(this);
        this.onclose?.({ code, reason, wasClean: true, type: 'close', target: this });
    }

    simulateError(error: any = {}) {
        this.onerror?.({ type: 'error', error, message: 'Simulated Error', target: this });
    }

    simulateBinaryMessage(data: any) {
        this.simulateServerMessage(data);
    }

    simulateTextMessage(data: any) {
        if (!this.onmessage) return;
        const text = typeof data === 'string' ? data : JSON.stringify(data);
        this.onmessage({ data: text });
    }

    simulateRawBinaryMessage(data: ArrayBuffer) {
        if (!this.onmessage) return;
        this.onmessage({ data });
    }
}

export class MockRelayServer {
    clients = new Set<MockWebSocket>();
    state: Record<string, any> = {};

    connect(ws: MockWebSocket) {
        this.clients.add(ws);
        // Send initial state
        // We use JSON for 'init' because client logic (handleInitSnapshot) often uses JSON in legacy paths
        // or expects simple structure.
        ws.simulateServerMessage({ type: 'init', data: { ...this.state } });
    }

    disconnect(ws: MockWebSocket) {
        this.clients.delete(ws);
        // Clean up connection
    }

    onMessage(from: MockWebSocket, data: any) {
        // console.log('[MockRelayServer] onMessage', data);
        if (data.op === 'subscribe') return; // Ignore subscription requests

        if (data.type === 'init') {
            // ignore
        } else if (data.type === 'op' || (data.op === 'set')) {
            // Broadcast to all other clients
            this.broadcast(from, data);

            // Update server state 
            if (data.type === 'op' && data.payload) {
                // DEBUG: console.log('[MockRelayServer] Updating State. Key:', data.payload.key);
                this.state[data.payload.key] = data.payload.value;
            } else if (data.payload && data.payload.key) {
                // Legacy structure support
                this.state[data.payload.key] = data.payload.value;
            }
        }
    }

    private broadcast(from: MockWebSocket, data: any) {
        for (const client of this.clients) {
            if (client !== from) {
                client.simulateServerMessage(data);
            }
        }
    }

    reset() {
        this.clients.clear();
        this.state = {};
    }
}

export const defaultMockServer = new MockRelayServer();

export class MockWasmCore {
    state: Record<string, any> = {};
    workspaceId: string = 'test-ws';

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_token: string) {
        // No-op
    }

    get_value(key: string) {
        return this.state[key];
    }

    get_all_values() {
        return this.state;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async set(key: string, value: any) {
        // Mock implementation
    }
    apply_local_op(key: string, value: Uint8Array) {

        // Update server state 
        // We need to decode value to store in state, as state expects JS objects
        let decoded: any = null;
        try {
            decoded = decodeValue(value);
            this.state[key] = decoded;
        } catch (e) {
            console.error("MockWasmCore: decode failed", e);
        }

        // Construct WirePacket for the op to return to Client
        // STRICT: Use Op table as defined in schema

        const builder = new Builder(1024);
        const valOffset = Op.createValueVector(builder, value);
        const keyOffset = builder.createString(key);
        const wsOffset = builder.createString(this.workspaceId || '');

        Op.startOp(builder);
        Op.addWorkspaceId(builder, wsOffset);
        Op.addKey(builder, keyOffset);
        Op.addTimestamp(builder, BigInt(Date.now()));
        Op.addValue(builder, valOffset);
        const opOffset = Op.endOp(builder);

        WirePacket.startWirePacket(builder);
        WirePacket.addMsgType(builder, MsgType.Op);
        WirePacket.addOp(builder, opOffset);
        const packetOffset = WirePacket.endWirePacket(builder);
        builder.finish(packetOffset);

        // Debug the generated packet
        // const packet = builder.asUint8Array();
        // console.log(`[MockWasmCore] Generated Packet first 20 bytes: ${Array.from(packet.slice(0, 20))}`);


        return builder.asUint8Array();
    }

    merge_remote_delta(arg1: any, arg2?: any) {
        // Hybrid support: Handle (key, value) from SyncEngine (parsed) OR (bytes) from raw
        if (typeof arg1 === 'string') {
            const key = arg1;
            const value = arg2;
            this.state[key] = value;
            return;
        }

        const bytes = arg1 as Uint8Array;
        try {
            // Try parse as WirePacket
            const buf = new ByteBuffer(bytes);
            const wire = WirePacket.getRootAsWirePacket(buf);
            if (wire.msgType() === MsgType.Op) {
                const op = wire.op();
                let key = '';
                let valBytes: Uint8Array | null = null;

                if (op) {
                    key = op.key() || '';
                    valBytes = op.valueArray();
                }

                if (key && valBytes) {
                    this.state[key] = decodeValue(valBytes);
                }
            }
        } catch (e) {
            console.error('[MockWasmCore] Failed to parse wire packet', e);
        }
        // In real WASM, might return state diff or something. Here void.
        return new Uint8Array(0);
    }
}

export function setupTestMocks() {
    defaultMockServer.reset();
    MockWebSocket.instances = [];
}

export function teardownTestMocks() {
    defaultMockServer.reset();
    MockWebSocket.instances = [];
    vi.restoreAllMocks();
}

MockWebSocket.instances = [];
// Removed vi.restoreAllMocks() from here

/**
 * A mock version of the NMeshedClient for use in React hooks and component tests.
 */
export class MockNMeshedClient {
    public status = 'DISCONNECTED';
    private listeners: Record<string, Function> = {};
    private presence: any[] = [];

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(config?: any) {
        // No-op
    }

    async connect() {
        this.status = 'READY';
    }

    disconnect() {
        this.status = 'DISCONNECTED';
    }

    on(event: string, handler: Function) {
        this.listeners[event] = handler;
        return () => { delete this.listeners[event]; };
    }

    off(event: string) {
        delete this.listeners[event];
    }

    onStatusChange(handler: Function) {
        return this.on('status', handler);
    }

    onQueueChange(handler: Function) {
        return this.on('queue', handler);
    }

    onMessage(handler: Function) {
        return this.on('message', handler);
    }

    async getPresence() {
        return this.presence;
    }

    // Test helper to set presence
    setPresence(users: any[]) {
        this.presence = users;
    }

    // Test helper to trigger events
    emit(event: string, ...args: any[]) {
        if (this.listeners[event]) {
            this.listeners[event](...args);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async ping(userId: string) {
        return 10;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async set(key: string, value: any) {
        // Mock implementation
    }
}
// WebRTC Mocks
export class MockRTCDataChannel {
    readyState = 'connecting';
    binaryType = 'blob';
    onopen: (() => void) | null = null;
    onmessage: ((event: any) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    label: string;

    constructor(label: string) {
        this.label = label;
        setTimeout(() => {
            this.readyState = 'open';
            if (this.onopen) this.onopen();
        }, 10);
    }

    send(data: any) {
        // Echo or mock send
    }

    close() {
        this.readyState = 'closed';
        if (this.onclose) this.onclose();
    }
}

export class MockRTCPeerConnection {
    iceServers: any;
    signalingState = 'stable';
    remoteDescription: any = null;
    localDescription: any = null;
    onicecandidate: ((event: any) => void) | null = null;
    ondatachannel: ((event: any) => void) | null = null;
    dataChannels: MockRTCDataChannel[] = [];

    constructor(config: any) {
        this.iceServers = config.iceServers;
    }

    createDataChannel(label: string) {
        const dc = new MockRTCDataChannel(label);
        this.dataChannels.push(dc);
        return dc;
    }

    async createOffer() {
        return { type: 'offer', sdp: 'mock-sdp-offer' };
    }

    async createAnswer() {
        return { type: 'answer', sdp: 'mock-sdp-answer' };
    }

    async setLocalDescription(desc: any) {
        this.localDescription = desc;
    }

    async setRemoteDescription(desc: any) {
        this.remoteDescription = desc;
        this.signalingState = 'stable'; // simplified
    }

    async addIceCandidate(candidate: any) {
        // no-op
    }

    close() {
        this.signalingState = 'closed';
    }
}

export class MockRTCSessionDescription {
    type: string;
    sdp: string;
    constructor(init: { type: string, sdp: string }) {
        this.type = init.type;
        this.sdp = init.sdp;
    }
}

export class MockRTCIceCandidate {
    candidate: string;
    constructor(init: { candidate: string }) {
        this.candidate = init.candidate;
    }
}
