import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { SignalingClient } from './SignalingClient';
import { installGlobalMockWebSocket } from '../../test-utils/setup';
import { MockWebSocket, setupTestMocks } from '../../test-utils/mocks';
import { ProtocolUtils } from './ProtocolUtils';
import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../../schema/nmeshed/wire-packet';
import { MsgType } from '../../schema/nmeshed/msg-type';
import { SignalData } from '../../schema/nmeshed/signal-data';
import { Offer } from '../../schema/nmeshed/offer';
import { Signal } from '../../schema/nmeshed/signal';

describe('SignalingClient', () => {
    let restoreWS: () => void;
    let client: SignalingClient;
    let events: any;
    const config = {
        url: 'ws://localhost:9000/signal',
        workspaceId: 'test-ws',
        myId: 'peer1'
    };

    beforeAll(() => {
        // No-op
    });

    afterAll(() => {
        if (restoreWS) restoreWS();
    });

    beforeEach(() => {
        setupTestMocks();
        vi.useFakeTimers();
        restoreWS = installGlobalMockWebSocket({ autoConnect: false });

        events = {
            onSignal: vi.fn(),
            onPresence: vi.fn(),
            onConnect: vi.fn(),
            onDisconnect: vi.fn(),
            onError: vi.fn(),
            onServerMessage: vi.fn(),
            onInit: vi.fn(),
            onEphemeral: vi.fn(),
        };

        client = new SignalingClient(config);
        client.setListeners(events);
    });

    afterEach(() => {
        if (restoreWS) restoreWS();
        vi.clearAllMocks();
    });

    it('connects to WebSocket with token', async () => {
        const tokenConfig = { ...config, token: 'jwt-token' };
        client = new SignalingClient(tokenConfig);
        client.setListeners(events);

        client.connect();
        await vi.advanceTimersByTimeAsync(10);

        const ws = MockWebSocket.instances[0];
        expect(ws.url).toContain('token=jwt-token');
    });

    it('sends join signal on connect', async () => {
        client.connect();
        await vi.advanceTimersByTimeAsync(10);

        const ws = MockWebSocket.instances[0];
        const sendSpy = vi.spyOn(ws, 'send');
        ws.simulateOpen();

        expect(events.onConnect).toHaveBeenCalled();
        expect(sendSpy).toHaveBeenCalled(); // Should send Join

        // Inspect the sent data? ProtocolUtils makes binary, hard to assert exact bytes without decoding
    });

    it('handles JSON presence message', async () => {
        client.connect();
        await vi.advanceTimersByTimeAsync(10);
        const ws = MockWebSocket.instances[0];
        ws.simulateOpen();

        const presenceMsg = JSON.stringify({
            type: 'presence',
            userId: 'user2',
            status: 'online',
            meshId: 'mesh1'
        });

        ws.simulateTextMessage(JSON.parse(presenceMsg));
        // MockWebSocket behaves such that simulateTextMessage passes data.
        // SignalingClient.handleMessage handles 'string' or ArrayBuffer.
        // However, MockWebSocket.simulateServerMessage wraps things. 
        // We'll use raw simulateServerMessage with object to mimic "JSON parsed" or send string directly?

        // MockWebSocket by default tries to be smart. 
        // If we pass an object, it passes it through. SignalingClient expects string for JSON?
        // Let's modify ws.onmessage call directly to be safe or ensure MockWebSocket behavior.

        // SignalingClient implementation:
        // private handleMessage(e: MessageEvent) { 
        //    if (typeof e.data === 'string') ...

        // MockWebSocket:
        // simulateServerMessage(msg) -> ... this.onmessage({ data: json });

        // So passing object to simulateServerMessage results in JSON string in data!
        ws.simulateServerMessage({
            type: 'presence',
            userId: 'user2',
            status: 'online',
            meshId: 'mesh1'
        });

        expect(events.onPresence).toHaveBeenCalledWith('user2', 'online', 'mesh1');
    });

    it('handles binary Signal (Offer)', async () => {
        client.connect();
        await vi.advanceTimersByTimeAsync(10);
        const ws = MockWebSocket.instances[0];
        ws.simulateOpen();

        // Construct binary packet: Offer
        const builder = new flatbuffers.Builder(1024);
        const sdpOffset = builder.createString('offer-sdp');
        const offerOffset = Offer.createOffer(builder, sdpOffset);

        const fromOffset = builder.createString('peer2');

        Signal.startSignal(builder);
        Signal.addFromPeer(builder, fromOffset);
        Signal.addDataType(builder, SignalData.Offer);
        Signal.addData(builder, offerOffset);
        const signalOffset = Signal.endSignal(builder);

        WirePacket.startWirePacket(builder);
        WirePacket.addMsgType(builder, MsgType.Signal);
        WirePacket.addSignal(builder, signalOffset);
        const packet = WirePacket.endWirePacket(builder);
        builder.finish(packet);

        const bytes = builder.asUint8Array();

        // Simulate binary message
        // SignalingClient.handleBinaryMessage expects ArrayBuffer
        // MockWebSocket.simulateRawBinaryMessage passes data directly.

        ws.simulateRawBinaryMessage(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

        expect(events.onSignal).toHaveBeenCalledWith(expect.objectContaining({
            from: 'peer2',
            signal: { type: 'offer', sdp: 'offer-sdp' }
        }));
    });

    it('reconnects on abnormal close', async () => {
        client.connect();
        await vi.advanceTimersByTimeAsync(10);
        const ws = MockWebSocket.instances[0];
        ws.simulateOpen();

        // Close abnormally
        ws.simulateClose(1006);

        expect(events.onDisconnect).toHaveBeenCalled();

        // Should schedule reconnect
        vi.advanceTimersByTime(2000); // 1s base + jitter

        // Should create new WS
        expect(MockWebSocket.instances.length).toBe(2);
    });
});
