import { EventEmitter } from '../utils/EventEmitter';
import { vi } from 'vitest';

export interface MockClientConfig {
    workspaceId: string;
    userId: string;
    token: string;
}

export class MockWebSocket extends EventEmitter<{
    open: [];
    close: [number, string];
    message: [any];
    error: [any];
}> {
    static instances: MockWebSocket[] = [];
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    public readyState: number = MockWebSocket.CONNECTING;
    public url: string;
    public onopen: (() => void) | null = null;
    public onclose: ((event: any) => void) | null = null;
    public onmessage: ((event: any) => void) | null = null;
    public onerror: ((event: any) => void) | null = null;
    public binaryType: string = 'blob';

    constructor(url: string, public server: any = null) {
        super();
        this.url = url;
        MockWebSocket.instances.push(this);
    }

    public send(_data: any): void {
        if (this.server && this.server.broadcast) {
            this.server.broadcast(_data);
        }
    }

    public close(code: number = 1000, reason: string = ''): void {
        this.simulateClose(code, reason);
    }

    public simulateOpen() {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.();
        this.emit('open');
        if (this.server && this.server.handleConnect) {
            this.server.handleConnect(this);
        }
    }

    public simulateClose(code: number = 1000, reason: string = '') {
        this.readyState = MockWebSocket.CLOSED;
        if (this.server && this.server.handleDisconnect) {
            this.server.handleDisconnect(this);
        }
        this.onclose?.({ code, reason, wasClean: true, type: 'close', target: this } as any);
        this.emit('close', code, reason);
    }


    public simulateMessage(data: any) {
        if (!this.onmessage) return;
        this.onmessage({ data } as any);
        this.emit('message', data);
    }

    public simulateTextMessage(data: any) {
        const text = typeof data === 'string' ? data : JSON.stringify(data);
        this.simulateMessage(text);
    }

    public simulateRawBinaryMessage(data: Uint8Array | ArrayBuffer | any) {
        let buffer: ArrayBuffer;
        if (data instanceof Uint8Array) {
            buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        } else if (data instanceof ArrayBuffer) {
            buffer = data;
        } else {
            buffer = data;
        }
        this.simulateMessage(buffer);
    }

    public simulateBinaryMessage(data: Uint8Array) {
        this.simulateRawBinaryMessage(data);
    }

    public simulateError(error: any) {
        this.onerror?.({ error } as any);
        this.emit('error', error);
    }
}


import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';
import { Op } from '../schema/nmeshed/op';
import { encodeValue, decodeValue } from '../codec';

// Helper to create WirePacket for Op
function createWireOp(key: string, value: Uint8Array, timestamp: bigint = BigInt(0)): Uint8Array {
    const builder = new flatbuffers.Builder(1024);
    const keyOffset = builder.createString(key);
    const valOffset = Op.createValueVector(builder, value);
    Op.startOp(builder);
    Op.addKey(builder, keyOffset);
    Op.addValue(builder, valOffset);
    Op.addTimestamp(builder, timestamp);
    const opOffset = Op.endOp(builder);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Op);
    WirePacket.addOp(builder, opOffset);
    const packetOffset = WirePacket.endWirePacket(builder);
    builder.finish(packetOffset);
    return builder.asUint8Array().slice();
}

// Helper to create WirePacket for Init
function createWireInit(payload: Uint8Array): Uint8Array {
    const builder = new flatbuffers.Builder(payload.length + 1024);
    // Use createByteVector for [ubyte] - it's faster and safer
    const payloadOffset = builder.createByteVector(payload);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Init);
    WirePacket.addPayload(builder, payloadOffset);
    const packetOffset = WirePacket.endWirePacket(builder);
    builder.finish(packetOffset);

    const result = builder.asUint8Array().slice();
    console.log(`[createWireInit] PayloadSize=${payload.length} ResultPacketSize=${result.length}`);
    return result;
}

export class MockRelayServer {
    public clients: Set<MockWebSocket> = new Set();
    public state: Map<string, any> = new Map();
    public handleConnect(client: MockWebSocket) {
        this.clients.add(client);

        // 1. Send BINARY Init (using Init helper)
        const initData = {
            type: 'init',
            meshId: 'test-mesh',
            peers: Array.from(this.clients).map(_ => ({ userId: 'peer' }))
        };
        const initPacket = createWireInit(new TextEncoder().encode(JSON.stringify(initData)));
        client.simulateRawBinaryMessage(initPacket);

        // 2. Replay existing state as Op packets
        // This works with both MockWasmCore AND real Automerge WASM core
        // because both understand the Op WirePacket format.
        for (const [key, value] of this.state.entries()) {
            const valBytes = value instanceof Uint8Array ? value : encodeValue(value);
            const opPacket = createWireOp(key, valBytes, BigInt(Date.now()));
            client.simulateRawBinaryMessage(opPacket);
        }
    }
    public handleDisconnect(client: MockWebSocket) {
        this.clients.delete(client);
    }
    public reset() {
        this.clients.clear();
        this.state.clear();
    }
    public disconnect = vi.fn();

    public broadcast(data: any) {
        // Update server state if it's an Op
        if (data instanceof Uint8Array) {
            try {
                const buf = new flatbuffers.ByteBuffer(data);
                const packet = WirePacket.getRootAsWirePacket(buf);
                const msgType = packet.msgType();
                if (msgType === MsgType.Op) {
                    const op = packet.op();
                    if (op) {
                        const key = op.key();
                        const valBytes = op.valueArray();

                        if (key && valBytes) {
                            // Ignore system keys to prevent log noise
                            if (!key.startsWith('__')) {
                                // CRITICAL: Make a defensive copy - Flatbuffer views can become invalid
                                this.state.set(key, new Uint8Array(valBytes));
                                // console.log(`[MockRelayServer] Stored key=${key} (${valBytes.length} bytes). TotalState=${this.state.size}`);
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('[MockRelayServer] Broadcast Parse error:', e);
            }
        }

        // Relay to all clients
        for (const client of this.clients) {
            // In a real server, we wouldn't echo back to sender usually, 
            // but for simplicity and some tests we might.
            // However, typical WebSocket server broadcasts to *others*.
            // But checking integration tests expectations...
            // "Host should eventually see y=2 (via broadcast)"
            // If Peer sends y=2, Host must receive it. Peer is sender.
            // So we must send to everyone else.
            client.simulateMessage(data);
        }
    }

    // Helper for tests to verify server state (handles binary decoding transparently)
    public getValue(key: string): any {
        const raw = this.state.get(key);
        if (raw instanceof Uint8Array) {
            try {
                return decodeValue(raw);
            } catch (e) { return raw; }
        }
        return raw;
    }
}

export const defaultMockServer = new MockRelayServer();

export class MockRTCPeerConnection {
    iceServers: any;
    signalingState = 'stable';
    remoteDescription: any = null;
    localDescription: any = null;
    onicecandidate: ((event: any) => void) | null = null;
    ondatachannel: ((event: any) => void) | null = null;
    dataChannels: MockRTCDataChannel[] = [];
    constructor(config: any) { this.iceServers = config?.iceServers; }
    createDataChannel(label: string) {
        const dc = new MockRTCDataChannel(label);
        this.dataChannels.push(dc);
        return dc;
    }
    async createOffer() { return { type: 'offer', sdp: 'mock-sdp-offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'mock-sdp-answer' }; }
    async setLocalDescription(desc: any) { this.localDescription = desc; }
    async setRemoteDescription(desc: any) { this.remoteDescription = desc; }
    async addIceCandidate(_candidate: any) { }
    close() { this.signalingState = 'closed'; }
}

export class MockRTCDataChannel extends EventEmitter<{ open: []; message: [any]; close: [] }> {
    label: string;
    readyState = 'connecting';
    onopen: (() => void) | null = null;
    onmessage: ((event: any) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(label: string) { super(); this.label = label; }
    public send(data: any): void { }
    simulateOpen() { this.readyState = 'open'; this.onopen?.(); this.emit('open'); }
    simulateMessage(data: any) { this.onmessage?.({ data } as any); this.emit('message', data); }
}

export class MockWasmCore {
    public state: Map<string, Uint8Array> = new Map();

    constructor(public workspaceId: string, public mode: string) { }

    apply_remote_delta(delta: Uint8Array) {
        // Real core returns a list of things to apply. For mock, we'll just return the original if it looks like a WirePacket.
        return [delta];
    }

    apply_local_op(key: string, value: Uint8Array, timestamp: bigint) {
        // In this Mock, 'value' is already encoded binary from SyncEngine.set
        this.state.set(key, value);
        // Return a WirePacket containing the Op
        return createWireOp(key, value, timestamp);
    }

    merge_remote_delta(packet_data: Uint8Array) {
        try {
            const buf = new flatbuffers.ByteBuffer(packet_data);
            const packet = WirePacket.getRootAsWirePacket(buf);

            if (packet.msgType() === MsgType.Op) {
                const op = packet.op();
                if (op) {
                    const key = op.key();
                    const val = op.valueArray();
                    if (key && val) {
                        this.state.set(key, val);
                        return [{ type: 'op', key, value: val }];
                    }
                }
            }
        } catch (e) {
            // Fallback for non-flatbuffer data if needed
        }
        return [];
    }

    receive_sync_message(_message: Uint8Array) {
        return Promise.resolve();
    }

    load_snapshot(snapshot: Uint8Array): void {
        console.log(`[MockWasmCore] load_snapshot starting. Snapshot size=${snapshot.length} bytes`);
        try {
            const json = new TextDecoder().decode(snapshot);
            const data = JSON.parse(json);
            console.log(`[MockWasmCore] Parsed snapshot successfully. KeyCount=${Object.keys(data).length}`);
            for (const [k, v] of Object.entries(data)) {
                if (Array.isArray(v)) {
                    this.state.set(k, new Uint8Array(v));
                } else {
                    // CRITICAL: Must use encodeValue to ensure FBC tags are present
                    this.state.set(k, encodeValue(v));
                }
            }
        } catch (e) {
            console.error('[MockWasmCore] Load Snapshot failed:', e);
        }
    }

    get_state() {
        const result: Record<string, any> = {};
        for (const [k, v] of this.state.entries()) {
            result[k] = decodeValue(v);
        }
        return result;
    }

    get_all_values() {
        const result: Record<string, Uint8Array> = {};
        for (const [k, v] of this.state.entries()) {
            result[k] = v;
        }
        return result;
    }

    get(key: string): Uint8Array | undefined {
        const val = this.state.get(key);
        if (val) {
            // console.log(`[MockWasmCore] get(${key}) -> FOUND. Size=${val.length}`);
        } else {
            // console.log(`[MockWasmCore] get(${key}) -> NOT FOUND`);
        }
        return val;
    }

    set(key: string, value: Uint8Array): void {
        this.state.set(key, value);
    }

    // New state machine compatible methods
    apply_vessel(bytes: Uint8Array): void {
        // Parse the WirePacket and apply the operation
        try {
            const buf = new flatbuffers.ByteBuffer(bytes);
            const packet = WirePacket.getRootAsWirePacket(buf);

            if (packet.msgType() === MsgType.Op) {
                const op = packet.op();
                if (op) {
                    const key = op.key();
                    const val = op.valueArray();
                    if (key && val) {
                        this.state.set(key, new Uint8Array(val));
                    }
                }
            }
        } catch (e) {
            // Silently fail for invalid packets
        }
    }

    get_raw_value(key: string): Uint8Array | undefined {
        return this.state.get(key);
    }

    get_heads(): string[] {
        return [];
    }
}

export function setupTestMocks() {
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection);
    (vi.stubGlobal as any)('RTCSessionDescription', class { constructor(init: any) { return init; } });
    (vi.stubGlobal as any)('RTCIceCandidate', class { constructor(init: any) { return init; } });
}


export class MockNMeshedClient extends EventEmitter<{
    status: [string];
    presence: [string, string, string];
    peerJoin: [string];
    peerDisconnect: [string];
    error: [Error];
}> {
    public status: string = 'IDLE';
    public peers: Map<string, any> = new Map();

    constructor(public config?: any) {
        super();
    }

    public async connect() {
        this.status = 'CONNECTED';
        this.emit('status', this.status);
    }

    public disconnect() {
        this.status = 'DISCONNECTED';
        this.emit('status', this.status);
    }

    public getStatus() {
        return this.status;
    }

    public getPeers() {
        return Array.from(this.peers.keys());
    }

    public async getPresence(): Promise<any[]> {
        return Array.from(this.peers.values());
    }

    public async ping(_peerId: string): Promise<number> {
        return 10;
    }

    public onStatusChange(cb: (status: any) => void) {
        return this.on('status', cb);
    }
    public onQueueChange(_cb: (size: number) => void) {
        // dummy
        return () => { };
    }
    public onMessage(_cb: (msg: any) => void) {
        // dummy
        return () => { };
    }
    public set(_key: string, _value: any) {
        // dummy
    }
}

export function teardownTestMocks() {
    MockWebSocket.instances = [];
    vi.unstubAllGlobals();
}

// Export a test-ready WebSocket that auto-connects (moved from integration.test.ts)
export class AutoMockWebSocket extends MockWebSocket {
    constructor(url: string) {
        super(url, defaultMockServer);
        // Auto-connect using microtask to simulate async network
        Promise.resolve().then(() => {
            this.simulateOpen();
        });
    }
}
