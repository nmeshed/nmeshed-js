/**
 * NMeshed v2 - Client Unit Tests
 * 
 * "The Ferrari" Test Suite: Testing with real engines.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { encode } from '@msgpack/msgpack';
import { NMeshedClient } from '../src/client';
import { MsgType, encodeOp, encodeInit } from '../src/protocol';

// Store last created WebSocket instance for message simulation
let lastWebSocket: MockWebSocket | null = null;

// Mock WebSocket
class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.OPEN;
    binaryType = 'arraybuffer';
    url: string;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(url: string) {
        this.url = url;
        lastWebSocket = this;
        // Simulate connection
        setTimeout(() => {
            this.readyState = MockWebSocket.OPEN;
            this.onopen?.();
        }, 0);
    }

    send = vi.fn((data) => {
        // console.log('[MockWS] Send:', data);
    });
    close = vi.fn(() => {
        this.readyState = MockWebSocket.CLOSED;
        setTimeout(() => this.onclose?.(), 0);
    });

    // Helper to simulate receiving a message
    simulateMessage(data: Uint8Array) {
        this.onmessage?.({ data: data.buffer });
    }
}

vi.stubGlobal('WebSocket', MockWebSocket);

describe('NMeshedClient', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        lastWebSocket = null;
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    describe('constructor', () => {
        it('should create client with valid config', () => {
            const client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            vi.advanceTimersByTime(100);
            expect(client).toBeDefined();
            client.disconnect();
        });
    });

    describe('get/set', () => {
        let client: NMeshedClient;

        beforeEach(() => {
            client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            vi.advanceTimersByTime(100);
        });

        afterEach(() => {
            client.disconnect();
        });

        it('should set and get values', () => {
            client.set('key', 'value');
            expect(client.get('key')).toBe('value');
        });

        it('should delete values (set to null tombstone)', () => {
            client.set('key', 'value');
            client.delete('key');
            expect(client.get('key')).toBeNull();
        });

        it('should send data over WebSocket on set', () => {
            client.set('key', 'value');
            // Client auto-broadcasts local ops
            expect(lastWebSocket?.send).toHaveBeenCalled();
            // Verify payload integrity if we wanted, but call presence is main check
        });
    });

    describe('events', () => {
        let client: NMeshedClient;

        beforeEach(() => {
            client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            vi.advanceTimersByTime(100);
        });

        afterEach(() => {
            client.disconnect();
        });

        it('should emit op events', () => {
            const handler = vi.fn();
            client.on('op', handler);
            client.set('key', 'value');
            expect(handler).toHaveBeenCalledWith('key', 'value', true);
        });

        it('should emit status events on status change', () => {
            const handler = vi.fn();
            client.on('status', handler);

            // Simulate Init message
            const snapshot = { test: 'data' };
            // Real Protocol Encoding!
            const msg = encodeInit(encode(snapshot));
            lastWebSocket?.simulateMessage(msg);

            expect(handler).toHaveBeenCalled(); // Should transition to 'ready'
            expect(client.getStatus()).toBe('ready');
        });
    });

    describe('awaitReady', () => {
        it('should resolve when Init received', async () => {
            const client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            await vi.advanceTimersByTimeAsync(100);

            // Ensure we are connected before simulating Init
            expect(client.getStatus()).toBe('connected');

            const promise = client.awaitReady();

            // Send Init
            if (lastWebSocket) {
                const msg = encodeInit(encode({ initialized: true }));
                lastWebSocket.simulateMessage(msg);
            }

            await vi.advanceTimersByTimeAsync(10);
            await promise;
            expect(client.getStatus()).toBe('ready');
            client.disconnect();
        });
    });

    describe('handleMessage', () => {
        let client: NMeshedClient;

        beforeEach(() => {
            client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            vi.advanceTimersByTime(100);
        });

        afterEach(() => {
            client.disconnect();
        });

        it('should handle Init message', () => {
            const snapshot = { key1: 'value1' };
            const msg = encodeInit(encode(snapshot));
            lastWebSocket?.simulateMessage(msg);

            expect(client.get('key1')).toBe('value1');
        });

        it('should handle Op message', () => {
            const opHandler = vi.fn();
            client.on('op', opHandler);

            const key = 'remoteKey';
            const val = 'remoteValue';
            const msg = encodeOp(key, encode(val)); // Real encoding
            lastWebSocket?.simulateMessage(msg);

            expect(opHandler).toHaveBeenCalledWith('remoteKey', 'remoteValue', false);
        });
    });

    describe('store() API', () => {
        let client: NMeshedClient;

        beforeEach(() => {
            client = new NMeshedClient({
                workspaceId: 'test',
                token: 'token',
                schemas: {
                    todos: z.array(z.string())
                }
            });
            vi.advanceTimersByTime(100);
        });

        afterEach(() => {
            client.disconnect();
        });

        it('should return a proxy for registered schema', () => {
            const todos = client.store<string[]>('todos');
            expect(Array.isArray(todos)).toBe(true);
        });

        it('should trigger sync on mutation', () => {
            const todos = client.store<string[]>('todos');
            todos.push('buy milk');
            // This relies on the engine event listener wiring we added
            expect(lastWebSocket?.send).toHaveBeenCalled();
            // We can even verify the content if we decode the last call args
            // but call presence proves wiring success.
        });
    });
});
