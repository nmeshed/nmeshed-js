/**
 * P2PTransport Integration Tests
 * 
 * These tests exercise the full message handling pipeline using real
 * FlatBuffer WirePacket binaries, testing the handleRawMessage method.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { P2PTransport } from './P2PTransport';
import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';
import { Op } from '../schema/nmeshed/op';
import { SyncPacket } from '../schema/nmeshed/sync-packet';
import { encodeValue } from '../codec';

// Capture listeners set on mocks
let signalingListeners: any = {};
let connectionListeners: any = {};

vi.mock('./p2p/SignalingClient', () => {
    return {
        SignalingClient: class {
            connect = vi.fn();
            close = vi.fn();
            setListeners = vi.fn((listeners: any) => { signalingListeners = listeners; });
            sendSignal = vi.fn();
            sendEphemeral = vi.fn();
            sendSync = vi.fn();
            updateToken = vi.fn();
            get connected() { return true; }
        }
    };
});

vi.mock('./p2p/ConnectionManager', () => {
    return {
        ConnectionManager: class {
            setListeners = vi.fn((listeners: any) => { connectionListeners = listeners; });
            closeAll = vi.fn();
            broadcast = vi.fn();
            initiateConnection = vi.fn();
            handleOffer = vi.fn();
            handleAnswer = vi.fn();
            handleCandidate = vi.fn();
            hasPeer = vi.fn();
            isDirect = vi.fn();
            getPeerIds = vi.fn(() => []);
        }
    };
});

// Helper: Create WirePacket with MsgType.Op
function createOpPacket(key: string, value: unknown): Uint8Array {
    const builder = new flatbuffers.Builder(1024);

    const keyOffset = builder.createString(key);
    const valueBytes = encodeValue(value);
    const valueOffset = Op.createValueVector(builder, valueBytes);
    const wsOffset = builder.createString('test-ws');

    Op.startOp(builder);
    Op.addWorkspaceId(builder, wsOffset);
    Op.addKey(builder, keyOffset);
    Op.addValue(builder, valueOffset);
    Op.addTimestamp(builder, BigInt(Date.now()));
    const opOffset = Op.endOp(builder);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Op);
    WirePacket.addOp(builder, opOffset);
    const packetOffset = WirePacket.endWirePacket(builder);

    builder.finish(packetOffset);
    return builder.asUint8Array();
}

// Helper: Create WirePacket with MsgType.Sync containing SyncPacket
function createSyncPacket(snapshotData: Uint8Array): Uint8Array {
    const builder = new flatbuffers.Builder(1024);

    const snapOffset = SyncPacket.createSnapshotVector(builder, snapshotData);
    SyncPacket.startSyncPacket(builder);
    SyncPacket.addSnapshot(builder, snapOffset);
    const syncOffset = SyncPacket.endSyncPacket(builder);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Sync);
    WirePacket.addSync(builder, syncOffset);
    const packetOffset = WirePacket.endWirePacket(builder);

    builder.finish(packetOffset);
    return builder.asUint8Array();
}

// Helper: Create WirePacket with MsgType.Sync and payload (for ephemeral fallback)
function createSyncPayloadPacket(payload: Uint8Array): Uint8Array {
    const builder = new flatbuffers.Builder(1024);

    const payloadOffset = WirePacket.createPayloadVector(builder, payload);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Sync);
    WirePacket.addPayload(builder, payloadOffset);
    const packetOffset = WirePacket.endWirePacket(builder);

    builder.finish(packetOffset);
    return builder.asUint8Array();
}

describe('P2PTransport Integration Tests', () => {
    let transport: P2PTransport;

    const config = {
        workspaceId: 'integ-ws',
        userId: 'integ-user',
        token: 'integ-token'
    };

    beforeEach(() => {
        vi.useFakeTimers();
        signalingListeners = {};
        connectionListeners = {};
        vi.clearAllMocks();
        transport = new P2PTransport(config);
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    describe('handleRawMessage with real WirePackets', () => {

        it('emits message event for MsgType.Op packets', () => {
            transport.connect();
            const messageSpy = vi.fn();
            transport.on('message', messageSpy);

            const opPacket = createOpPacket('test-key', { foo: 'bar' });

            // Simulate receiving via P2P DataChannel
            connectionListeners.onMessage('peer-1', opPacket);

            expect(messageSpy).toHaveBeenCalled();
            // The emitted data should be the value bytes from the Op
            const emittedData = messageSpy.mock.calls[0][0];
            expect(emittedData).toBeInstanceOf(Uint8Array);
        });

        it('emits message event for MsgType.Sync packets (dumb pipe architecture)', () => {
            transport.connect();
            const messageSpy = vi.fn();
            transport.on('message', messageSpy);

            const syncPacket = createSyncPacket(encodeValue({ syncData: 123 }));

            // Simulate receiving via P2P - Transport emits raw bytes, SyncEngine parses
            connectionListeners.onMessage('peer-1', syncPacket);

            expect(messageSpy).toHaveBeenCalled();
        });

        it('emits message event for MsgType.Sync with payload (dumb pipe architecture)', () => {
            transport.connect();
            const messageSpy = vi.fn();
            transport.on('message', messageSpy);

            // Binary ephemeral payload (not JSON - strict binary protocol)
            const binaryPayload = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
            const packet = createSyncPayloadPacket(binaryPayload);

            // Transport emits raw bytes - SyncEngine's MessageRouter handles parsing
            connectionListeners.onMessage('peer-1', packet);

            expect(messageSpy).toHaveBeenCalled();
            // Verify the raw WirePacket is emitted (not parsed components)
            const emittedPayload = messageSpy.mock.calls[0][0];
            expect(emittedPayload).toBeInstanceOf(Uint8Array);
        });

        it('handles relay signal with binary data', () => {
            transport.connect();
            const messageSpy = vi.fn();
            transport.on('message', messageSpy);

            const opPacket = createOpPacket('relay-key', { relayed: true });

            // Simulate relay signal (server-forwarded message)
            signalingListeners.onSignal({
                from: 'relay-peer',
                signal: { type: 'relay', data: opPacket }
            });

            expect(messageSpy).toHaveBeenCalled();
        });

        it('handles invalid WirePacket without crashing', () => {
            transport.connect();

            // Invalid binary - not a valid FlatBuffer
            const junkData = new Uint8Array([0xFF, 0xFE, 0xFD, 0, 1, 2]);

            // Should not throw - graceful error handling
            expect(() => {
                connectionListeners.onMessage('peer-1', junkData);
            }).not.toThrow();
        });
    });

    describe('send() creates valid WirePacket', () => {

        it('wraps data in WirePacket.Op and broadcasts', () => {
            transport.connect();

            const data = encodeValue({ key: 'val' });
            transport.send(data);

            // Verify broadcast was called
            const broadcastCall = (transport as any).connections.broadcast.mock.calls[0];
            const broadcastedData = broadcastCall[0];

            // Parse it back to verify it's a valid WirePacket
            const buf = new flatbuffers.ByteBuffer(broadcastedData);
            const wire = WirePacket.getRootAsWirePacket(buf);

            expect(wire.msgType()).toBe(MsgType.Op);
            expect(wire.op()).not.toBeNull();
        });
    });


    describe('ephemeral ping/pong flow', () => {

        it('responds to __ping__ with __pong__', () => {
            transport.connect();

            signalingListeners.onEphemeral({
                type: '__ping__',
                requestId: 'ping-123',
                from: 'pinger'
            }, 'pinger');

            const signaling = (transport as any).signaling;
            expect(signaling.sendEphemeral).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: '__pong__',
                    requestId: 'ping-123'
                }),
                'pinger'
            );
        });

        it('resolves ping promise on __pong__ receipt', async () => {
            transport.connect();

            const pingPromise = transport.ping('target');

            // Get the requestId that was sent
            const signaling = (transport as any).signaling;
            const sentPayload = signaling.sendEphemeral.mock.calls[0][0];
            const requestId = sentPayload.requestId;

            // Advance time and respond
            vi.advanceTimersByTime(100);
            signalingListeners.onEphemeral({
                type: '__pong__',
                requestId
            }, 'target');

            const latency = await pingPromise;
            expect(latency).toBe(100);
        });
    });
});
