import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NMeshedClient } from './client';
import { ConfigurationError, ConnectionError } from './errors';

// Mock persistence
vi.mock('./persistence', () => ({
    loadQueue: vi.fn().mockReturnValue(Promise.resolve([])),
    saveQueue: vi.fn().mockReturnValue(Promise.resolve()),
}));

import { loadQueue, saveQueue } from './persistence';

const originalWebSocket = globalThis.WebSocket;

vi.mock('./wasm/nmeshed_core', () => {
    class MockCore {
        state: Record<string, unknown> = {};
        constructor() { }
        apply_local_op = vi.fn((key: string, value: Uint8Array) => {
            const raw = new TextDecoder().decode(value);
            try {
                this.state[key] = JSON.parse(raw);
            } catch {
                this.state[key] = raw;
            }
            return new Uint8Array([1, 2, 3]); // Dummy binary op
        });
        merge_remote_delta = vi.fn((bytes: Uint8Array) => {
            try {
                const text = new TextDecoder().decode(bytes);
                const parsed = JSON.parse(text);
                if (parsed.type === 'init') {
                    for (const [k, v] of Object.entries(parsed.data)) {
                        (this as MockCore).state[k] = v;
                    }
                    return { type: 'init', data: parsed.data };
                }
                if (parsed.type === 'op') {
                    const key = parsed.payload.key;
                    const value = parsed.payload.value;
                    (this as MockCore).state[key] = value;
                    return {
                        type: 'op',
                        key,
                        value: new TextEncoder().encode(JSON.stringify(value))
                    };
                }
            } catch {
                // Not a test payload
            }
            return null;
        });
        get_state = vi.fn(() => ({ ...this.state }));
    }
    return {
        default: vi.fn().mockResolvedValue(undefined),
        NMeshedClientCore: MockCore,
    };
});

class MockWebSocket {
    static instances: MockWebSocket[] = [];
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    binaryType = 'arraybuffer';
    onopen: (() => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;

    constructor(public url: string) {
        MockWebSocket.instances.push(this);
    }

    send = vi.fn();
    close = vi.fn();

    simulateOpen() {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.();
    }

    simulateBinaryMessage(data: unknown) {
        const jsonBytes = new TextEncoder().encode(JSON.stringify(data));
        this.onmessage?.({ data: jsonBytes.buffer });
    }

    simulateRawBinaryMessage(data: ArrayBuffer) {
        this.onmessage?.({ data });
    }

    simulateTextMessage(data: unknown) {
        this.onmessage?.({ data: JSON.stringify(data) });
    }

    simulateClose(code = 1000, reason = '') {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.({ code, reason });
    }

    simulateError() {
        this.onerror?.({});
    }
}

beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.useFakeTimers();
});

afterEach(() => {
    if (originalWebSocket) {
        vi.stubGlobal('WebSocket', originalWebSocket);
    } else {
        vi.unstubAllGlobals();
    }
    vi.useRealTimers();
});

describe('NMeshedClient', () => {
    const defaultConfig = {
        workspaceId: 'test-workspace',
        token: 'test-token',
    };

    describe('constructor', () => {
        it('throws ConfigurationError if workspaceId is missing', () => {
            expect(() => new NMeshedClient({ workspaceId: '', token: 'token' }))
                .toThrow(ConfigurationError);
        });

        it('throws ConfigurationError if token is missing', () => {
            expect(() => new NMeshedClient({ workspaceId: 'workspace', token: '' }))
                .toThrow(ConfigurationError);
        });

        it('throws ConfigurationError for invalid config', () => {
            expect(() => new NMeshedClient({
                workspaceId: 'workspace',
                token: 'token',
                maxReconnectAttempts: -1,
            })).toThrow(ConfigurationError);
        });

        it('creates client with valid config', () => {
            const client = new NMeshedClient(defaultConfig);
            expect(client.getStatus()).toBe('IDLE');
        });

        it('returns cached SyncedMap instances', () => {
            const client = new NMeshedClient(defaultConfig);
            const map1 = client.getSyncedMap('test');
            const map2 = client.getSyncedMap('test');
            expect(map1).toBe(map2);
        });
    });

    describe('connect', () => {
        it('establishes WebSocket connection', async () => {
            const client = new NMeshedClient(defaultConfig);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;
            expect(client.getStatus()).toBe('CONNECTED');
        });

        it('resolves immediately if already connected', async () => {
            const client = new NMeshedClient(defaultConfig);
            const promise1 = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await promise1;
            await client.connect();
            expect(MockWebSocket.instances.length).toBe(1);
        });

        it('rejects with ConnectionError on error', async () => {
            const client = new NMeshedClient(defaultConfig);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateError();
            await expect(connectPromise).rejects.toThrow(ConnectionError);
        });

        it('times out if connection takes too long', async () => {
            const client = new NMeshedClient({
                ...defaultConfig,
                connectionTimeout: 1000,
            });
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            vi.advanceTimersByTime(1001);
            await expect(connectPromise).rejects.toThrow('timed out');
        });
    });

    describe('messaging', () => {
        it('handles init message and updates state', async () => {
            const client = new NMeshedClient(defaultConfig);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();
            await connectPromise;
            ws.simulateBinaryMessage({
                type: 'init',
                data: { greeting: 'Hello', count: 42 },
            });
            expect(client.get('greeting')).toBe('Hello');
            expect(client.get('count')).toBe(42);
        });

        it('handles op message and updates state', async () => {
            const client = new NMeshedClient(defaultConfig);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;
            MockWebSocket.instances[0].simulateBinaryMessage({
                type: 'op',
                payload: { key: 'title', value: 'New Title', timestamp: 123 },
            });
            expect(client.get('title')).toBe('New Title');
        });

        it('notifies message listeners', async () => {
            const client = new NMeshedClient(defaultConfig);
            const listener = vi.fn();
            client.onMessage(listener);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;
            MockWebSocket.instances[0].simulateBinaryMessage({
                type: 'op',
                payload: { key: 'test', value: 'value', timestamp: 123 },
            });
            expect(listener).toHaveBeenCalled();
        });

        it('allows unsubscribing from messages', async () => {
            const client = new NMeshedClient(defaultConfig);
            const listener = vi.fn();
            const unsubscribe = client.onMessage(listener);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;
            unsubscribe();
            MockWebSocket.instances[0].simulateBinaryMessage({
                type: 'op',
                payload: { key: 'test', value: 'value', timestamp: 123 },
            });
            expect(listener).not.toHaveBeenCalled();
        });

        it('throws if message handler is not a function', () => {
            const client = new NMeshedClient(defaultConfig);
            expect(() => (client as any).onMessage(null)).toThrow();
        });

        it('supports multiple listeners and respects their unique unsubscribe', async () => {
            const client = new NMeshedClient(defaultConfig);
            const l1 = vi.fn();
            const l2 = vi.fn();
            const u1 = client.onMessage(l1);
            const u2 = client.onMessage(l2);

            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;

            u1(); // u1 is removed
            MockWebSocket.instances[0].simulateBinaryMessage({ type: 'op', payload: { key: 'a', value: 1 } });

            expect(l1).not.toHaveBeenCalled();
            expect(l2).toHaveBeenCalledTimes(1);
        });
    });

    describe('sendOperation', () => {
        it('sends operation when connected', async () => {
            const client = new NMeshedClient(defaultConfig);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();
            await connectPromise;
            client.set('key', 'value');
            expect(ws.send).toHaveBeenCalled();
        });

        it('queues operations when disconnected', () => {
            const client = new NMeshedClient(defaultConfig);
            client.set('queued', 'value');
            expect(client.get('queued')).toBe('value');
            expect(client.getQueueSize()).toBe(1);
        });

        it('respects maxQueueSize by dropping oldest', async () => {
            const client = new NMeshedClient({ ...defaultConfig, maxQueueSize: 2 });

            // Connect once to initialize core and clear preConnectState
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;

            // Disconnect to force queuing
            client.disconnect();
            expect(client.getStatus()).toBe('DISCONNECTED');

            client.set('k1', 1);
            client.set('k2', 2);
            client.set('k3', 3);

            expect(client.getQueueSize()).toBe(2);
        });

        it('flushes queue on connect', async () => {
            const client = new NMeshedClient(defaultConfig);
            client.set('key1', 'value1');
            client.set('key2', 'value2');
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();
            await connectPromise;
            expect(ws.send).toHaveBeenCalledTimes(2);
            expect(client.getQueueSize()).toBe(0);
        });

        it('handles circular JSON gracefully', async () => {
            const client = new NMeshedClient(defaultConfig);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;
            const circular: any = { a: 1 };
            circular.self = circular;
            expect(() => client.set('circular', circular)).not.toThrow();
            expect(MockWebSocket.instances[0].send).not.toHaveBeenCalled();
            expect(client.getQueueSize()).toBe(0);
        });
    });

    describe('status changes', () => {
        it('notifies status listeners', async () => {
            const client = new NMeshedClient(defaultConfig);
            const listener = vi.fn();
            client.onStatusChange(listener);
            expect(listener).toHaveBeenCalledWith('IDLE');
            const connectPromise = client.connect();
            expect(listener).toHaveBeenCalledWith('CONNECTING');
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;
            expect(listener).toHaveBeenCalledWith('CONNECTED');
        });
    });

    describe('disconnect', () => {
        it('closes WebSocket connection', async () => {
            const client = new NMeshedClient(defaultConfig);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();
            await connectPromise;
            client.disconnect();
            expect(ws.close).toHaveBeenCalled();
            expect(client.getStatus()).toBe('DISCONNECTED');
        });
    });

    describe('destroy', () => {
        it('cleans up all resources', async () => {
            const client = new NMeshedClient(defaultConfig);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;
            client.set('key', 'value');
            client.destroy();
            expect(client.getStatus()).toBe('DISCONNECTED');
            expect(client.getState()).toEqual({});
            expect(client.getQueueSize()).toBe(0);
        });
    });

    describe('getPresence', () => {
        it('uses HTTPS protocol even if serverUrl is WSS', async () => {
            const mockFetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve([]),
            });
            vi.stubGlobal('fetch', mockFetch);
            const client = new NMeshedClient({
                ...defaultConfig,
                serverUrl: 'wss://api.example.com/socket'
            });
            await client.getPresence();
            expect(mockFetch).toHaveBeenCalledWith(
                expect.stringMatching(/^https:\/\/api\.example\.com\/socket\/v1\/presence/),
                expect.any(Object)
            );
            vi.unstubAllGlobals();
        });

        it('handles fetch errors', async () => {
            const mockFetch = vi.fn().mockResolvedValue({
                ok: false,
                statusText: 'Not Found',
            });
            vi.stubGlobal('fetch', mockFetch);
            const client = new NMeshedClient(defaultConfig);
            await expect(client.getPresence()).rejects.toThrow('Failed to fetch presence: Not Found');
            vi.unstubAllGlobals();
        });
    });

    describe('Chaos Mode', () => {
        it('supports packet loss in simulateNetwork', async () => {
            const client = new NMeshedClient(defaultConfig);
            client.simulateNetwork({ packetLoss: 100 });
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();
            await connectPromise;
            client.broadcast('lost-message');
            expect(ws.send).not.toHaveBeenCalled();
            client.simulateNetwork(null);
            client.broadcast('safe-message');
            expect(ws.send).toHaveBeenCalled();
        });

        it('supports latency in simulateNetwork', async () => {
            const client = new NMeshedClient(defaultConfig);
            client.simulateNetwork({ latency: 500, jitter: 0 });
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();
            await connectPromise;
            client.broadcast('delayed');
            expect(ws.send).not.toHaveBeenCalled();
            vi.advanceTimersByTime(501);
            expect(ws.send).toHaveBeenCalled();
        });
    });

    describe('persistence', () => {
        beforeEach(() => {
            vi.clearAllMocks();
            (saveQueue as any).mockResolvedValue(undefined);
            (loadQueue as any).mockResolvedValue([]);
        });

        it('saves queued operations', () => {
            const client = new NMeshedClient(defaultConfig);
            client.set('key', 'value');
            expect(saveQueue).toHaveBeenCalled();
        });

        it('loads queued operations on init', async () => {
            const op = { key: 'saved', value: 'old', timestamp: 123 };
            (loadQueue as any).mockResolvedValue([op]);
            const client = new NMeshedClient(defaultConfig);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            expect(client.getQueueSize()).toBe(1);
        });
    });

    describe('JSON control message path', () => {
        it('handles presence updates from server', async () => {
            const client = new NMeshedClient(defaultConfig);
            const presenceHandler = vi.fn();
            client.onPresence(presenceHandler);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;
            MockWebSocket.instances[0].simulateTextMessage({
                type: 'presence',
                payload: { userId: 'user-123', status: 'online' },
            });
            expect(presenceHandler).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'user-123', status: 'online' })
            );
        });

        it('handles ephemeral events from server', async () => {
            const client = new NMeshedClient(defaultConfig);
            const ephemeralHandler = vi.fn();
            client.onBroadcast(ephemeralHandler);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;
            MockWebSocket.instances[0].simulateTextMessage({
                type: 'ephemeral',
                payload: { userId: 'user-456', cursor: { x: 100, y: 200 } },
            });
            expect(ephemeralHandler).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'user-456' })
            );
        });

        it('logs server errors without crashing', async () => {
            const client = new NMeshedClient(defaultConfig);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;
            expect(() => {
                MockWebSocket.instances[0].simulateTextMessage({
                    type: 'error',
                    error: 'Rate limit exceeded',
                });
            }).not.toThrow();
        });

        it('ignores malformed JSON text messages', async () => {
            const client = new NMeshedClient(defaultConfig);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;
            expect(() => {
                MockWebSocket.instances[0].onmessage?.({ data: 'not valid json {{' });
            }).not.toThrow();
        });
    });

    describe('Advanced Events and Lifecycle', () => {
        it('supports onQueueChange', () => {
            const client = new NMeshedClient(defaultConfig);
            const handler = vi.fn();
            client.onQueueChange(handler);
            expect(handler).toHaveBeenCalledWith(0);

            client.set('key', 'value');
            expect(handler).toHaveBeenCalledWith(1);
        });

        it('supports compatibility on() method', () => {
            const client = new NMeshedClient(defaultConfig);
            const handler = vi.fn();

            client.on('ephemeral', handler);
            client.broadcast('msg');
            // triggers onBroadcast which handler is subscribed to

            client.on('presence', handler);
            client.on('status', handler);
            client.on('message', handler);

            client.destroy();
        });

        it('destroy cleans up state', () => {
            const client = new NMeshedClient(defaultConfig);
            client.destroy();
            expect(client.getQueueSize()).toBe(0);
        });

        it('handles saveQueue and loadQueue errors', async () => {
            (saveQueue as any).mockRejectedValue(new Error('DB Fail'));
            (loadQueue as any).mockRejectedValue(new Error('DB Fail'));

            const client = new NMeshedClient(defaultConfig);
            client.set('a', 'b'); // should not crash

            await vi.waitFor(() => expect(loadQueue).toHaveBeenCalled());
        });

        it('handles listener errors gracefully', async () => {
            const client = new NMeshedClient(defaultConfig);
            const badHandler = () => { throw new Error('Bad'); };
            client.onMessage(badHandler);
            client.onBroadcast(badHandler);
            client.onPresence(badHandler);
            client.onStatusChange(badHandler);

            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;

            // Should not crash
            MockWebSocket.instances[0].simulateTextMessage({ type: 'presence', payload: {} });
            MockWebSocket.instances[0].simulateTextMessage({ type: 'ephemeral', payload: {} });
        });

        it('handles binary merge failure', async () => {
            const client = new NMeshedClient(defaultConfig);
            (client as any).core = { merge_remote_delta: () => { throw new Error('Merge Fail'); } };
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;

            // Should just warn and continue
            MockWebSocket.instances[0].simulateRawBinaryMessage(new Uint8Array([1, 2]).buffer);
        });

        it('supports reconnection logic', async () => {
            const client = new NMeshedClient({ ...defaultConfig, maxReconnectAttempts: 2 });
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();
            await connectPromise;

            // Simulate abnormal disconnect
            ws.simulateClose(1006, 'Abnormal');
            expect(client.getStatus()).toBe('RECONNECTING');

            await vi.advanceTimersByTime(2000);
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(2));
        });

        it('handles non-reconnectable close codes', async () => {
            const client = new NMeshedClient(defaultConfig);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;

            MockWebSocket.instances[0].simulateClose(4001);
            expect(client.getStatus()).toBe('ERROR');
        });

        it('handles internal ping/pong protocol', async () => {
            const client = new NMeshedClient(defaultConfig);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;

            const clientUserId = client.getId();

            // Receive a ping request targeted at this client
            MockWebSocket.instances[0].simulateTextMessage({
                type: 'ephemeral',
                payload: {
                    type: '__ping__',
                    to: clientUserId,
                    from: 'peer-1',
                    requestId: 'req-123',
                    timestamp: Date.now()
                }
            });

            // Client should have responded with pong
            const sendCalls = MockWebSocket.instances[0].send.mock.calls;
            const pongCall = sendCalls.find((call: any) => {
                const data = call[0];
                const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
                return str.includes('__pong__');
            });
            expect(pongCall).toBeDefined();
        });

        it('handles server error messages', async () => {
            const client = new NMeshedClient(defaultConfig);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;

            // Should not throw
            MockWebSocket.instances[0].simulateTextMessage({
                type: 'error',
                message: 'Something went wrong'
            });
        });

        it('handles close() alias', async () => {
            const client = new NMeshedClient(defaultConfig);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;

            client.close();
            expect(client.getStatus()).toBe('DISCONNECTED');
        });

        it('respects maxQueueSize config', async () => {
            const client = new NMeshedClient({ ...defaultConfig, maxQueueSize: 2 });
            (client as any).core = {
                apply_operation: vi.fn()
            };

            client.set('k1', 'v1');
            client.set('k2', 'v2');
            client.set('k3', 'v3');

            // Queue should be limited
            expect((client as any).operationQueue.length).toBe(2);
        });

        it('get() retrieves values from core state', async () => {
            const client = new NMeshedClient(defaultConfig);
            (client as any).core = {
                get_state: () => ({ foo: 'bar' })
            };

            expect(client.get('foo')).toBe('bar');
            expect(client.get('missing')).toBeUndefined();
        });

        it('getId() returns userId', () => {
            const client = new NMeshedClient({ ...defaultConfig, userId: 'my-user-id' });
            expect(client.getId()).toBe('my-user-id');
        });

        it('handles queue listener throwing errors', async () => {
            const client = new NMeshedClient(defaultConfig);
            (client as any).core = { apply_operation: vi.fn() };

            // Add a listener that throws after first call (subscribe triggers first call)
            let callCount = 0;
            const badListener = vi.fn(() => {
                callCount++;
                if (callCount > 1) throw new Error('Boom!');
            });
            const goodListener = vi.fn();

            client.onQueueChange(badListener);
            client.onQueueChange(goodListener);

            // Should not throw despite bad listener throwing on queue change
            expect(() => client.set('k', 'v')).not.toThrow();

            // Good listener should still be called
            expect(goodListener).toHaveBeenCalled();
        });

        it('disconnect cancels pending reconnect timeout', async () => {
            const client = new NMeshedClient({ ...defaultConfig, autoReconnect: true });
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;

            // Simulate abnormal close to trigger reconnect scheduling
            MockWebSocket.instances[0].simulateClose(1006, 'Abnormal');
            expect(client.getStatus()).toBe('RECONNECTING');

            // Now disconnect - should cancel the pending reconnect
            client.disconnect();
            expect(client.getStatus()).toBe('DISCONNECTED');

            // Advance time and verify no reconnection happened
            vi.advanceTimersByTime(10000);
            expect(MockWebSocket.instances.length).toBe(1); // Still only the original instance
        });

        it('handles heartbeat send failure gracefully', async () => {
            const client = new NMeshedClient({ ...defaultConfig, heartbeatInterval: 100 });
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;

            // Make send throw
            MockWebSocket.instances[0].send = vi.fn(() => { throw new Error('Send failed'); });

            // Advance time to trigger heartbeat - should not throw
            vi.advanceTimersByTime(200);
            expect(client.getStatus()).toBe('CONNECTED');
        });

        it('throws if onBroadcast handler is not a function', () => {
            const client = new NMeshedClient(defaultConfig);
            expect(() => client.onBroadcast('not-a-function' as any)).toThrow('Broadcast handler must be a function');
        });

        it('throws if onPresence handler is not a function', () => {
            const client = new NMeshedClient(defaultConfig);
            expect(() => client.onPresence(123 as any)).toThrow('Presence handler must be a function');
        });

        it('throws if onStatusChange handler is not a function', () => {
            const client = new NMeshedClient(defaultConfig);
            expect(() => client.onStatusChange(null as any)).toThrow('Status handler must be a function');
        });

        it('handles status handler throwing on subscribe', () => {
            const client = new NMeshedClient(defaultConfig);
            const throwingHandler = vi.fn(() => { throw new Error('Handler error'); });

            // Should not throw
            expect(() => client.onStatusChange(throwingHandler)).not.toThrow();
            expect(throwingHandler).toHaveBeenCalled();
        });
    });
});
