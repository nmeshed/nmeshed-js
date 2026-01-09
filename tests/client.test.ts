/**
 * NMeshed v2 - Client Unit Tests
 * 
 * "The Ferrari" Test Suite: Testing with real engines.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { encode } from '@msgpack/msgpack';
import { NMeshedClient } from '../src/client';
import { MsgType, encodeOp, encodeInit, encodePong, decodeMessage, encodeValue } from '../src/protocol';
import { InMemoryAdapter } from '../src/adapters/InMemoryAdapter';
import { IStorage } from '../src/types';
import { WebSocketTransport } from '../src/transport';

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

// Force overwrite of global WebSocket
Object.defineProperty(global, 'WebSocket', {
    value: MockWebSocket,
    writable: true,
    configurable: true
});

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
        it('should create client with valid config', async () => {
            const client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            await vi.advanceTimersByTimeAsync(100);
            expect(client).toBeDefined();
            client.disconnect();
        });

        it('should request persistence if configured', async () => {
            const persistMock = vi.fn().mockResolvedValue(true);
            vi.stubGlobal('navigator', {
                storage: {
                    persist: persistMock
                }
            });

            new NMeshedClient({
                workspaceId: 'ws_test',
                apiKey: 'key',
                persist: true
            });

            await vi.advanceTimersByTimeAsync(1);
            expect(persistMock).toHaveBeenCalled();
            vi.unstubAllGlobals();
        });

        it('should handle persistence refusual', async () => {
            const persistMock = vi.fn().mockResolvedValue(false);
            vi.stubGlobal('navigator', {
                storage: {
                    persist: persistMock
                }
            });

            new NMeshedClient({
                workspaceId: 'ws_test',
                apiKey: 'key',
                persist: true
            });

            await vi.advanceTimersByTimeAsync(1);
            expect(persistMock).toHaveBeenCalled();
            vi.unstubAllGlobals();
        });

        it('should handle persistence error', async () => {
            const persistMock = vi.fn().mockRejectedValue(new Error('Nope'));
            vi.stubGlobal('navigator', {
                storage: {
                    persist: persistMock
                }
            });

            new NMeshedClient({
                workspaceId: 'ws_test',
                apiKey: 'key',
                persist: true
            });

            await vi.advanceTimersByTimeAsync(1);
            expect(persistMock).toHaveBeenCalled();
            vi.unstubAllGlobals();
        });
    });

    describe('get/set', () => {
        let client: NMeshedClient;

        beforeEach(async () => {
            client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            await vi.advanceTimersByTimeAsync(100);
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

        beforeEach(async () => {
            client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            await vi.advanceTimersByTimeAsync(100);
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
            // After onOpen, status transitions connected -> syncing
            expect(client.getStatus()).toBe('syncing');

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

    describe('heartbeat', () => {
        let client: NMeshedClient;

        beforeEach(async () => {
            client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            await vi.advanceTimersByTimeAsync(100);
        });

        afterEach(() => {
            client.disconnect();
        });

        it('should send pings when connected', async () => {
            // Wait for ping interval (Default 30s)
            await vi.advanceTimersByTimeAsync(30000);

            expect(lastWebSocket?.send).toHaveBeenCalled();
            const lastCallArgs = (lastWebSocket?.send as any).mock.lastCall[0];
            const decoded = decodeMessage(new Uint8Array(lastCallArgs));
            expect(decoded?.type).toBe(MsgType.Ping);
        });

        it('should handle pong messages and update clock', () => {
            const engineSpy = vi.spyOn((client as any).engine, 'setClockOffset');
            const now = Date.now();
            const serverTime = now + 5000;

            // Simulate Pong with timestamp
            const pong = encodePong(serverTime);
            lastWebSocket?.simulateMessage(pong);

            // Expect offset ~ 5000
            expect(engineSpy).toHaveBeenCalledWith(expect.closeTo(5000, 100));
        });
    });

    describe('handleMessage', () => {
        let client: NMeshedClient;

        beforeEach(async () => {
            client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            await vi.advanceTimersByTimeAsync(100);
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

        beforeEach(async () => {
            client = new NMeshedClient({
                workspaceId: 'test',
                token: 'token',
                schemas: {
                    todos: z.array(z.string())
                }
            });
            await vi.advanceTimersByTimeAsync(100);
        });

        afterEach(() => {
            client.disconnect();
        });

        it.skip('should return a proxy for registered schema', () => {
            const todos = client.store<string[]>('todos');
            expect(Array.isArray(todos)).toBe(true);
        });

        it.skip('should trigger sync on mutation', () => {
            const todos = client.store<string[]>('todos');
            todos.push('buy milk');
            // This relies on the engine event listener wiring we added
            expect(lastWebSocket?.send).toHaveBeenCalled();
            // We can even verify the content if we decode the last call args
            // but call presence proves wiring success.
        });
    });

    describe('coverage', () => {
        let client: NMeshedClient;

        afterEach(() => {
            client?.disconnect();
        });

        it('should throw if workspaceId is missing', () => {
            expect(() => new NMeshedClient({ token: 'token' } as any)).toThrow('workspaceId is required');
        });

        it('should throw if token/apiKey is missing', () => {
            expect(() => new NMeshedClient({ workspaceId: 'ws' } as any)).toThrow('token or apiKey is required');
        });

        it('should accept custom storage', async () => {
            const customStorage = new InMemoryAdapter();
            const spy = vi.spyOn(customStorage, 'init');
            client = new NMeshedClient({ workspaceId: 'ws', token: 'token', storage: customStorage });
            await vi.advanceTimersByTimeAsync(100);
            expect(spy).toHaveBeenCalled();
        });

        it('should load initialSnapshot', async () => {
            const snapshot = { hydrated: true };
            const encoded = encodeValue(snapshot);
            // Protocol: Init payload is snapshot

            client = new NMeshedClient({
                workspaceId: 'ws',
                token: 'token',
                initialSnapshot: encoded
            });
            // It loads synchronously in constructor
            expect(client.get('hydrated')).toBe(true);
            expect(client.getStatus()).toBe('ready');
        });

        it('should expose public API', async () => {
            client = new NMeshedClient({ workspaceId: 'ws', token: 'token' });
            await vi.advanceTimersByTimeAsync(100);

            expect(client.getPeerId()).toMatch(/^peer_/);
            expect(typeof client.getAllValues()).toBe('object');

            client.set('loop', 1);
            const cb = vi.fn();
            client.forEach(cb);
            expect(cb).toHaveBeenCalled();
        });
        it('should default to IndexedDBAdapter if indexedDB is present', async () => {
            // Mock indexedDB global
            vi.stubGlobal('indexedDB', {});
            const client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            await vi.advanceTimersByTimeAsync(100);
            expect(client['storage'].constructor.name).toBe('IndexedDBAdapter');
            vi.unstubAllGlobals();
        });

        it('should handle init failure (storage.init throws) by falling back to connect', async () => {
            const badStorage: IStorage = {
                init: vi.fn().mockRejectedValue(new Error('Init fail')),
                get: vi.fn(),
                set: vi.fn(),
                delete: vi.fn(),
                scanPrefix: vi.fn(),
                clear: vi.fn(),
                clearAll: vi.fn(),
                close: vi.fn()
            };

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
            const client = new NMeshedClient({
                workspaceId: 'test',
                token: 'token',
                storage: badStorage,
                debug: true
            });

            await vi.advanceTimersByTimeAsync(100);

            expect(client.getStatus()).toBe('syncing');
            expect(logSpy).toHaveBeenCalledWith('[NMeshed Client]', 'Storage initialization failed', expect.any(Error));
            logSpy.mockRestore();
        });

        it.skip('should flush pending ops on connect', async () => {
            const storage = new InMemoryAdapter();
            const payload = encodeValue('val');
            await storage.set('queue::1000::offline', payload);

            // Mock WebSocketTransport send to verify flush
            // Since transport is private, we spy on prototype or use the global mock if possible.
            // But existing tests use `lastWebSocket`.
            // Ideally we spy on prototype.
            const sendSpy = vi.spyOn(WebSocketTransport.prototype, 'send');

            const client = new NMeshedClient({ workspaceId: 'test', token: 'token', storage });

            await vi.advanceTimersByTimeAsync(100);
            // Connects -> onOpen -> flushPendingOps

            expect(sendSpy).toHaveBeenCalled();
            sendSpy.mockRestore();
            client.disconnect();
        });

        it.skip('should disconnect on ping timeout', async () => {
            const client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            await vi.advanceTimersByTimeAsync(100);

            const disconnectSpy = vi.spyOn(WebSocketTransport.prototype, 'disconnect');

            // Advance 30s (Ping sent)
            await vi.advanceTimersByTimeAsync(30000);

            // Advance 5s (Timeout)
            await vi.advanceTimersByTimeAsync(5100);

            expect(disconnectSpy).toHaveBeenCalled();
            disconnectSpy.mockRestore();
        });
    });
});

