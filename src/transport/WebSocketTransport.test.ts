/**
 * @file WebSocketTransport.test.ts
 * @brief Tests for binary protocol handling in WebSocketTransport.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketTransport } from './WebSocketTransport';
import { OpCode } from './protocol';

import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';
import { Op } from '../schema/nmeshed/op';
import { SyncPacket } from '../schema/nmeshed/sync-packet';

// Mock WebSocket
class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];

    url: string;
    readyState = MockWebSocket.CONNECTING;
    binaryType = 'arraybuffer';
    onopen: (() => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;
    send = vi.fn();
    close = vi.fn();

    constructor(url: string) {
        this.url = url;
        MockWebSocket.instances.push(this);
    }

    simulateOpen() {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.();
    }

    simulateBinaryMessage(data: ArrayBuffer | Uint8Array) {
        const buffer = data instanceof Uint8Array ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
        this.onmessage?.({ data: buffer as ArrayBuffer });
    }

    simulateTextMessage(data: string) {
        this.onmessage?.({ data });
    }
}

describe('WebSocketTransport', () => {
    const originalWebSocket = globalThis.WebSocket;

    beforeEach(() => {
        MockWebSocket.instances = [];
        (globalThis as any).WebSocket = MockWebSocket;
    });

    afterEach(() => {
        (globalThis as any).WebSocket = originalWebSocket;
        vi.restoreAllMocks();
    });

    function createWireOp(key: string, value: Uint8Array): Uint8Array {
        const builder = new flatbuffers.Builder(1024);
        const keyOffset = builder.createString(key);
        const valOffset = Op.createValueVector(builder, value);
        Op.startOp(builder);
        Op.addKey(builder, keyOffset);
        Op.addValue(builder, valOffset);
        const opOffset = Op.endOp(builder);

        WirePacket.startWirePacket(builder);
        WirePacket.addMsgType(builder, MsgType.Op);
        WirePacket.addOp(builder, opOffset);
        const packetOffset = WirePacket.endWirePacket(builder);
        builder.finish(packetOffset);
        return builder.asUint8Array().slice();
    }

    function createWireSync(payload: Uint8Array): Uint8Array {
        const builder = new flatbuffers.Builder(1024);
        const payOffset = WirePacket.createPayloadVector(builder, payload);
        WirePacket.startWirePacket(builder);
        WirePacket.addMsgType(builder, MsgType.Sync);
        WirePacket.addPayload(builder, payOffset);
        const packetOffset = WirePacket.endWirePacket(builder);
        builder.finish(packetOffset);
        return builder.asUint8Array().slice();
    }

    describe('Binary Protocol - send()', () => {
        it('passes through binary data without re-wrapping (assumes Pre-Framed)', () => {
            const transport = new WebSocketTransport({ url: 'wss://test.com' });
            transport.connect();
            MockWebSocket.instances[0].simulateOpen();

            const payload = new Uint8Array([1, 2, 3, 4]);
            transport.send(payload);

            expect(MockWebSocket.instances[0].send).toHaveBeenCalled();
            const sentData = MockWebSocket.instances[0].send.mock.calls[0][0] as Uint8Array;
            expect(sentData).toEqual(payload);

            transport.disconnect();
        });
    });

    describe('Binary Protocol - sendEphemeral()', () => {
        it('uses MsgType.Sync for binary payloads', () => {
            const transport = new WebSocketTransport({ url: 'wss://test.com' });
            transport.connect();
            MockWebSocket.instances[0].simulateOpen();

            const payload = new Uint8Array([10, 20, 30]);
            transport.sendEphemeral(payload);

            expect(MockWebSocket.instances[0].send).toHaveBeenCalled();
            const sentData = MockWebSocket.instances[0].send.mock.calls[0][0] as Uint8Array;

            const buf = new flatbuffers.ByteBuffer(sentData);
            const wire = WirePacket.getRootAsWirePacket(buf);
            expect(wire.msgType()).toBe(MsgType.Sync);
            expect(wire.payloadArray()).toEqual(payload);

            transport.disconnect();
        });

        it('sends raw JSON for control/administrative messages', () => {
            const transport = new WebSocketTransport({ url: 'wss://test.com' });
            transport.connect();
            MockWebSocket.instances[0].simulateOpen();

            const payload = { type: 'presence', status: 'online' };
            transport.sendEphemeral(payload);

            expect(MockWebSocket.instances[0].send).toHaveBeenCalled();
            const sentData = MockWebSocket.instances[0].send.mock.calls[0][0] as string;
            expect(typeof sentData).toBe('string');
            expect(sentData).toContain('"presence"');

            transport.disconnect();
        });
    });

    describe('Binary Protocol - handleMessage()', () => {
        it('emits raw bytes for MsgType.Op packets', () => {
            const transport = new WebSocketTransport({ url: 'wss://test.com' });
            const messageHandler = vi.fn();
            transport.on('message', messageHandler);

            transport.connect();
            MockWebSocket.instances[0].simulateOpen();

            const opPacket = createWireOp('testKey', new Uint8Array([42]));
            MockWebSocket.instances[0].simulateBinaryMessage(opPacket);

            expect(messageHandler).toHaveBeenCalled();
            // Verify raw bytes are emitted (not parsed object)
            const emittedData = messageHandler.mock.calls[0][0];
            expect(emittedData).toBeInstanceOf(Uint8Array);
            transport.disconnect();
        });

        it('emits raw bytes for MsgType.Sync packets', () => {
            const transport = new WebSocketTransport({ url: 'wss://test.com' });
            const messageHandler = vi.fn();
            transport.on('message', messageHandler);

            transport.connect();
            MockWebSocket.instances[0].simulateOpen();

            const syncPacket = createWireSync(new Uint8Array([1, 2, 3]));
            MockWebSocket.instances[0].simulateBinaryMessage(syncPacket);

            expect(messageHandler).toHaveBeenCalled();
            // Verify raw bytes are emitted
            const emittedData = messageHandler.mock.calls[0][0];
            expect(emittedData).toBeInstanceOf(Uint8Array);
            transport.disconnect();
        });

        it('handles raw JSON control messages via heuristic', () => {
            const transport = new WebSocketTransport({ url: 'wss://test.com' });
            const peerJoinHandler = vi.fn();
            transport.on('peerJoin', peerJoinHandler);

            transport.connect();
            MockWebSocket.instances[0].simulateOpen();

            const json = JSON.stringify({ type: 'peer_join', userId: 'user1' });
            const bytes = new TextEncoder().encode(json);
            MockWebSocket.instances[0].simulateBinaryMessage(bytes);

            expect(peerJoinHandler).toHaveBeenCalledWith('user1');
            transport.disconnect();
        });
    });
    describe('Heartbeat', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('resets missedHeartbeats when __pong__ is received', () => {
            const transport = new WebSocketTransport({
                url: 'wss://test.com',
                heartbeatInterval: 1000,
                heartbeatMaxMissed: 3
            });
            transport.connect();
            MockWebSocket.instances[0].simulateOpen();

            // Advance time to trigger one heartbeat
            vi.advanceTimersByTime(1100);
            expect(MockWebSocket.instances[0].send).toHaveBeenCalledWith('__ping__');

            // At this point missedHeartbeats should be 1
            // Simulate receiving __pong__
            MockWebSocket.instances[0].simulateTextMessage('__pong__');

            // Advance time to trigger another heartbeat
            vi.advanceTimersByTime(1000);

            // If missedHeartbeats was reset, it should now be 1 again, not 2.
            // Advance another 1000ms
            vi.advanceTimersByTime(1000);

            // Total of 3 heartbeats triggered since first pong. 
            // If reset worked, we should NOT have closed yet.
            expect(MockWebSocket.instances[0].close).not.toHaveBeenCalled();

            transport.disconnect();
        });

        it('closes connection after max missed heartbeats', () => {
            const transport = new WebSocketTransport({
                url: 'wss://test.com',
                heartbeatInterval: 1000,
                heartbeatMaxMissed: 2
            });
            transport.connect();
            MockWebSocket.instances[0].simulateOpen();

            // Trigger 1 missed heartbeat
            vi.advanceTimersByTime(1000);
            expect(MockWebSocket.instances[0].close).not.toHaveBeenCalled();

            // Trigger 2nd missed heartbeat -> Should close
            vi.advanceTimersByTime(1000);
            expect(MockWebSocket.instances[0].close).toHaveBeenCalledWith(4000, 'Heartbeat Timeout');

            transport.disconnect();
        });
    });
});
