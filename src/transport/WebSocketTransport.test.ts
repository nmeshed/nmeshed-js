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

    describe('Heartbeat', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('resets missedHeartbeats when binary pong is received', () => {
            const transport = new WebSocketTransport('wss://test.com', {
                heartbeatInterval: 1000,
                heartbeatMaxMissed: 3
            });
            transport.connect();
            MockWebSocket.instances[0].simulateOpen();

            // Advance time to trigger one heartbeat
            vi.advanceTimersByTime(1100);
            expect(MockWebSocket.instances[0].send).toHaveBeenCalledWith('\x01');

            // Simulate receiving binary pong (\x00)
            MockWebSocket.instances[0].simulateTextMessage('\x00');

            // Advance time to trigger another heartbeat
            vi.advanceTimersByTime(1000);

            expect(MockWebSocket.instances[0].close).not.toHaveBeenCalled();

            transport.disconnect();
        });

        it('closes connection after max missed heartbeats', () => {
            const transport = new WebSocketTransport('wss://test.com', {
                heartbeatInterval: 1000,
                heartbeatMaxMissed: 2
            });
            transport.connect();
            MockWebSocket.instances[0].simulateOpen();

            // Trigger 1 missed heartbeat
            vi.advanceTimersByTime(1000);
            expect(MockWebSocket.instances[0].close).not.toHaveBeenCalled();

            // Trigger 2nd missed heartbeat (missed -> 2). Next tick will close.
            vi.advanceTimersByTime(1000);
            expect(MockWebSocket.instances[0].close).not.toHaveBeenCalled();

            // Trigger 3rd tick -> missed is 2 >= 2 -> Close
            vi.advanceTimersByTime(1000);
            expect(MockWebSocket.instances[0].close).toHaveBeenCalled();

            transport.disconnect();
        });
    });
});
