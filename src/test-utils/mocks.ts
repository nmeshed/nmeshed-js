import { EventEmitter } from '../utils/EventEmitter';
import { vi } from 'vitest';
import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';
import { Op } from '../schema/nmeshed/op';
import { SyncEngine } from '../core/SyncEngine';

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

/**
 * Helper to create a WirePacket for Op.
 * @internal Reserved for future use in advanced mock scenarios.
 */
function _createWireOp(key: string, value: Uint8Array, timestamp: bigint = BigInt(0)): Uint8Array {
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

// Suppress unused warning - reserved for future mock scenarios
void _createWireOp;

// Helper to create WirePacket for Init
function createWireInit(payload: Uint8Array): Uint8Array {
    const builder = new flatbuffers.Builder(payload.length + 1024);
    const payloadOffset = builder.createByteVector(payload);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Init);
    WirePacket.addPayload(builder, payloadOffset);
    const packetOffset = WirePacket.endWirePacket(builder);
    builder.finish(packetOffset);

    return builder.asUint8Array().slice();
}

/**
 * MockRelayServer: A test double for the nMeshed relay server.
 * 
 * Uses a real SyncEngine internally for authoritative state management,
 * ensuring test behavior matches production exactly.
 * 
 * @remarks
 * This mock intentionally sends an empty Init packet on connect to simulate
 * a fresh workspace. For state-carrying scenarios, tests should manually
 * inject deltas after connection.
 */
export class MockRelayServer {
    public clients: Set<MockWebSocket> = new Set();
    private engine: SyncEngine | null = null;
    private enginePromise: Promise<SyncEngine> | null = null;

    private async ensureEngine(): Promise<SyncEngine> {
        if (this.engine) return this.engine;
        if (this.enginePromise) return this.enginePromise;

        this.enginePromise = (async () => {
            const engine = new SyncEngine('00000000-0000-0000-0000-000000000000', 'server', 1000, false);
            await engine.boot();
            this.engine = engine;
            return engine;
        })();
        return this.enginePromise;
    }

    public async handleConnect(client: MockWebSocket) {
        this.clients.add(client);
        // Send empty Init packet - clients start fresh
        const initPacket = createWireInit(new Uint8Array(0));
        client.simulateRawBinaryMessage(initPacket);
    }

    public handleDisconnect(client: MockWebSocket) {
        this.clients.delete(client);
    }

    public reset() {
        this.clients.clear();
        if (this.engine) {
            this.engine.destroy();
            this.engine = null;
        }
        this.enginePromise = null;
    }

    public disconnect = vi.fn();

    public async broadcast(data: any) {
        if (data instanceof Uint8Array) {
            const engine = await this.ensureEngine();
            engine.applyRawMessage(data);
        }

        // Relay to all clients
        for (const client of this.clients) {
            client.simulateMessage(data);
        }
    }

    public getValue(key: string): any {
        if (!this.engine) return undefined;
        return this.engine.get(key);
    }

    public get state(): Map<string, any> {
        // For test compatibility - real state is in WASM core
        return new Map();
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
    public send(_data: any): void { /* stub */ }
    simulateOpen() { this.readyState = 'open'; this.onopen?.(); this.emit('open'); }
    simulateMessage(data: any) { this.onmessage?.({ data } as any); this.emit('message', data); }
}

export function setupTestMocks() {
    class TestWebSocket extends MockWebSocket {
        constructor(url: string) {
            super(url, defaultMockServer);
        }
    }
    vi.stubGlobal('WebSocket', TestWebSocket);
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

    public get workspaceId(): string {
        return this.config?.workspaceId || 'mock-ws';
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

    public get isLive(): boolean {
        return this.status === 'CONNECTED' || this.status === 'READY';
    }

    public getId(): string {
        return this.config?.userId || 'mock-user';
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

    public getLatency(): number {
        return 0;
    }

    public onStatusChange(cb: (status: any) => void) {
        this.on('status', cb);
        return () => this.off('status', cb);
    }
    public onQueueChange(cb: (size: number) => void) {
        this.on('queueChange' as any, cb);
        return () => this.off('queueChange' as any, cb);
    }
    public onMessage(cb: (msg: any) => void) {
        this.on('message' as any, cb);
        return () => this.off('message' as any, cb);
    }
    public onPresence(cb: (p: any) => void) {
        this.on('presence' as any, cb);
        return () => this.off('presence' as any, cb);
    }
    public onEphemeral(cb: (p: any, from?: string) => void) {
        this.on('ephemeral' as any, cb);
        return () => this.off('ephemeral' as any, cb);
    }
    public sendMessage(payload: Uint8Array, _to?: string) {
        this.emit('ephemeral' as any, payload, this.getId());
    }

    private mockState = new Map<string, any>();
    public get<T>(key: string): T | undefined {
        return this.mockState.get(key);
    }
    public set(key: string, value: any) {
        this.mockState.set(key, value);
        this.emit('message' as any, { type: 'op', payload: { key, value }, timestamp: Date.now() });
    }
}

export function teardownTestMocks() {
    MockWebSocket.instances = [];
    vi.unstubAllGlobals();
}

export class AutoMockWebSocket extends MockWebSocket {
    constructor(url: string) {
        super(url, defaultMockServer);
        Promise.resolve().then(() => {
            this.simulateOpen();
        });
    }
}
export class MockSyncEngine extends EventEmitter<{
    op: [string, any];
    status: [any];
    error: [Error];
}> {
    public state: Map<string, any> = new Map();
    public schemas: Map<string, any> = new Map();

    constructor() {
        super();
    }

    public registerSchema(prefix: string, schema: any) {
        this.schemas.set(prefix, schema);
    }

    public getSchema(prefix: string) {
        return this.schemas.get(prefix);
    }

    public set(key: string, value: any) {
        if (value === null || value === undefined) {
            this.state.delete(key);
        } else {
            this.state.set(key, value);
        }
        this.emit('op', key, value);
    }

    public forEach(callback: (value: any, key: string) => void) {
        this.state.forEach((v, k) => callback(v, k));
    }
}
