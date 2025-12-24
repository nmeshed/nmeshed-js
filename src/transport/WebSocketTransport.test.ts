/**
 * @file WebSocketTransport.test.ts
 * @brief Tests for binary protocol handling in WebSocketTransport.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketTransport } from './WebSocketTransport';
import { OpCode } from './protocol';

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

    simulateBinaryMessage(data: ArrayBuffer) {
        this.onmessage?.({ data });
    }

    simulateTextMessage(data: string) {
        this.onmessage?.({ data });
    }
}

describe('WebSocketTransport', () => {
    const originalWebSocket = global.WebSocket;

    beforeEach(() => {
        MockWebSocket.instances = [];
        global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    });

    afterEach(() => {
        global.WebSocket = originalWebSocket;
        vi.restoreAllMocks();
    });

    describe('Binary Protocol - send()', () => {
        it('prefixes data with OpCode.ENGINE', () => {
            const transport = new WebSocketTransport({ url: 'wss://test.com' });
            transport.connect();
            MockWebSocket.instances[0].simulateOpen();

            const payload = new Uint8Array([1, 2, 3, 4]);
            transport.send(payload);

            expect(MockWebSocket.instances[0].send).toHaveBeenCalled();
            const sentData = MockWebSocket.instances[0].send.mock.calls[0][0] as Uint8Array;
            expect(sentData[0]).toBe(OpCode.ENGINE);
            expect(sentData.slice(1)).toEqual(payload);

            transport.disconnect();
        });
    });

    describe('Binary Protocol - sendEphemeral()', () => {
        it('uses OpCode.EPHEMERAL for broadcast Uint8Array', () => {
            const transport = new WebSocketTransport({ url: 'wss://test.com' });
            transport.connect();
            MockWebSocket.instances[0].simulateOpen();

            const payload = new Uint8Array([10, 20, 30]);
            transport.sendEphemeral(payload);

            expect(MockWebSocket.instances[0].send).toHaveBeenCalled();
            const sentData = MockWebSocket.instances[0].send.mock.calls[0][0] as Uint8Array;
            expect(sentData[0]).toBe(OpCode.EPHEMERAL);
            expect(sentData.slice(1)).toEqual(payload);

            transport.disconnect();
        });

        it('uses OpCode.DIRECT for targeted Uint8Array', () => {
            const transport = new WebSocketTransport({ url: 'wss://test.com' });
            transport.connect();
            MockWebSocket.instances[0].simulateOpen();

            const payload = new Uint8Array([10, 20, 30]);
            transport.sendEphemeral(payload, 'peer-123');

            expect(MockWebSocket.instances[0].send).toHaveBeenCalled();
            const sentData = MockWebSocket.instances[0].send.mock.calls[0][0] as Uint8Array;
            expect(sentData[0]).toBe(OpCode.DIRECT);
            // Byte 1 = peer ID length, rest = peer ID + payload

            transport.disconnect();
        });

        it('uses OpCode.SYSTEM for JSON objects', () => {
            const transport = new WebSocketTransport({ url: 'wss://test.com' });
            transport.connect();
            MockWebSocket.instances[0].simulateOpen();

            const payload = { type: 'presence', userId: 'test' };
            transport.sendEphemeral(payload);

            expect(MockWebSocket.instances[0].send).toHaveBeenCalled();
            const sentData = MockWebSocket.instances[0].send.mock.calls[0][0] as Uint8Array;
            expect(sentData[0]).toBe(OpCode.SYSTEM);

            transport.disconnect();
        });
    });

    describe('Binary Protocol - handleMessage()', () => {
        it('routes OpCode.ENGINE to message event', () => {
            const transport = new WebSocketTransport({ url: 'wss://test.com' });
            const messageHandler = vi.fn();
            transport.on('message', messageHandler);

            transport.connect();
            MockWebSocket.instances[0].simulateOpen();

            // Create ENGINE message with JSON payload
            const jsonPayload = JSON.stringify({ type: 'op', key: 'a', value: 1 });
            const jsonBytes = new TextEncoder().encode(jsonPayload);
            const framedMessage = new Uint8Array(jsonBytes.length + 1);
            framedMessage[0] = OpCode.ENGINE;
            framedMessage.set(jsonBytes, 1);

            MockWebSocket.instances[0].simulateBinaryMessage(framedMessage.buffer);

            expect(messageHandler).toHaveBeenCalled();
            transport.disconnect();
        });

        it('routes OpCode.EPHEMERAL to ephemeral event', () => {
            const transport = new WebSocketTransport({ url: 'wss://test.com' });
            const ephemeralHandler = vi.fn();
            transport.on('ephemeral', ephemeralHandler);

            transport.connect();
            MockWebSocket.instances[0].simulateOpen();

            // Create EPHEMERAL message
            const payload = new Uint8Array([5, 6, 7]);
            const framedMessage = new Uint8Array(payload.length + 1);
            framedMessage[0] = OpCode.EPHEMERAL;
            framedMessage.set(payload, 1);

            MockWebSocket.instances[0].simulateBinaryMessage(framedMessage.buffer);

            expect(ephemeralHandler).toHaveBeenCalled();
            transport.disconnect();
        });

        it('routes OpCode.SYSTEM to JSON handler', () => {
            const transport = new WebSocketTransport({ url: 'wss://test.com' });
            const presenceHandler = vi.fn();
            transport.on('presence', presenceHandler);

            transport.connect();
            MockWebSocket.instances[0].simulateOpen();

            // Create SYSTEM message with presence JSON
            const jsonPayload = JSON.stringify({ type: 'presence', payload: { userId: 'u1' } });
            const jsonBytes = new TextEncoder().encode(jsonPayload);
            const framedMessage = new Uint8Array(jsonBytes.length + 1);
            framedMessage[0] = OpCode.SYSTEM;
            framedMessage.set(jsonBytes, 1);

            MockWebSocket.instances[0].simulateBinaryMessage(framedMessage.buffer);

            expect(presenceHandler).toHaveBeenCalled();
            transport.disconnect();
        });

        it('warns and drops unknown OpCodes', () => {
            const transport = new WebSocketTransport({ url: 'wss://test.com' });
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

            transport.connect();
            MockWebSocket.instances[0].simulateOpen();

            // Create message with unknown OpCode 0xFF
            const framedMessage = new Uint8Array([0xFF, 1, 2, 3]);
            MockWebSocket.instances[0].simulateBinaryMessage(framedMessage.buffer);

            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown OpCode'));
            warnSpy.mockRestore();
            transport.disconnect();
        });

        it('routes string messages to JSON handler', () => {
            const transport = new WebSocketTransport({ url: 'wss://test.com' });
            const messageHandler = vi.fn();
            transport.on('message', messageHandler);

            transport.connect();
            MockWebSocket.instances[0].simulateOpen();

            // String init message should be converted to binary and emitted as 'message'
            const jsonMessage = JSON.stringify({ type: 'init', data: { a: 1 } });
            MockWebSocket.instances[0].simulateTextMessage(jsonMessage);

            expect(messageHandler).toHaveBeenCalled();
            transport.disconnect();
        });
    });
});
