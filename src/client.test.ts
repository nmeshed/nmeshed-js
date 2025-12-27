import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { NMeshedClient } from './client';
import { ConfigurationError, ConnectionError } from './errors';
import {
    MockWebSocket,
    MockRelayServer,
    defaultMockServer,
    MockWasmCore,
    setupTestMocks,
    teardownTestMocks
} from './test-utils/mocks';

// Mock persistence
vi.mock('./persistence', () => ({
    loadQueue: vi.fn().mockReturnValue(Promise.resolve([])),
    saveQueue: vi.fn().mockReturnValue(Promise.resolve()),
}));

import { loadQueue, saveQueue } from './persistence';

// Centralized mocks handling
// MockWasmCore is already designed to be mocked via module replacement if we export it correctly
// However, since client.ts imports wasm/nmeshed_core, we need to mock that module path.
vi.mock('./wasm/nmeshed_core', async () => {
    // We simply return the class from our test utils, but wrapped to match module shape
    // using dynamic import to avoid hoisting issues with require/module scope
    const mocks = await import('./test-utils/mocks');
    return {
        default: vi.fn().mockResolvedValue(undefined),
        NMeshedClientCore: mocks.MockWasmCore,
    };
});

const defaultConfig = {
    url: 'ws://localhost:8080',
    workspaceId: 'test-workspace',
    token: 'test-token',
    autoReconnect: true,
    reconnectInterval: 100, // Fast reconnect for tests
    maxReconnectAttempts: 3,
};

describe('NMeshedClient', () => {
    // Global WebSocket Stubbing for all tests in this file
    const originalWebSocket = (globalThis as any).WebSocket;

    class TestMockWebSocket extends MockWebSocket {
        constructor(url: string) {
            super(url, defaultMockServer);
        }
    }

    beforeAll(() => {
        // No-op
    });

    afterAll(() => {
        vi.stubGlobal('WebSocket', originalWebSocket);
        (globalThis as any).WebSocket = originalWebSocket;
        if (typeof window !== 'undefined') {
            (window as any).WebSocket = originalWebSocket;
        }
    });

    beforeEach(() => {
        vi.useFakeTimers();

        // Enforce mock in beforeEach to survive environment resets
        vi.stubGlobal('WebSocket', TestMockWebSocket);
        (globalThis as any).WebSocket = TestMockWebSocket;
        if (typeof window !== 'undefined') {
            (window as any).WebSocket = TestMockWebSocket;
        }

        // Reset centralized mocks (instances, server state)
        setupTestMocks();

        // Spy on MockWebSocket methods so we can expect(ws.send).toHaveBeenCalled()
        vi.spyOn(MockWebSocket.prototype, 'send');
        vi.spyOn(MockWebSocket.prototype, 'close');

        // Reset all VIMocks to clear spies
        vi.clearAllMocks();

        // Reset persistence mocks to default success state to prevent test pollution
        (loadQueue as any).mockResolvedValue([]);
        (saveQueue as any).mockResolvedValue(undefined);
    });

    afterEach(() => {
        defaultMockServer.reset();
        MockWebSocket.instances = [];
    });

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
            // Zen: CONNECTED is now transient. 
            // Depending on mock server speed, we might be SYNCING or already READY.
            const status = client.getStatus();
            expect(['SYNCING', 'READY']).toContain(status);
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
                connectionTimeout: 100,
            });
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));

            // Trigger timeout
            vi.advanceTimersByTime(200);

            await expect(connectPromise).rejects.toThrow(/timed out/i);
        });

        it('awaitReady resolves when sync is complete', async () => {
            const client = new NMeshedClient(defaultConfig);
            client.connect(); // Start connection
            const readyPromise = client.awaitReady();

            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();

            // Should still be pending until init message
            let resolved = false;
            readyPromise.then(() => { resolved = true; });
            vi.advanceTimersByTime(0); // Process microtasks
            expect(resolved).toBe(false);

            MockWebSocket.instances[0].simulateBinaryMessage({ type: 'init', data: {} });
            await readyPromise;
            expect(client.getStatus()).toBe('READY');
        });
    });

    describe('messaging', () => {
        it('handles binary init message and updates state', async () => {
            const client = new NMeshedClient(defaultConfig);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();
            await connectPromise;

            MockWebSocket.instances[0].simulateBinaryMessage({
                type: 'init',
                data: { greeting: 'Hello', count: 42 },
            });

            expect(client.get('greeting')).toBe('Hello');
            expect(client.get('count')).toBe(42);
        });

        it('handles binary op message and updates state', async () => {
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
            listener.mockClear(); // Clear any init message calls

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
            l1.mockClear(); // Clear any init message calls
            l2.mockClear(); // Clear any init message calls
            MockWebSocket.instances[0].simulateBinaryMessage({ type: 'op', payload: { key: 'a', value: 1 } });

            expect(l1).not.toHaveBeenCalled();
            expect(l2).toHaveBeenCalledTimes(1);
        });

        it('onKeyChange filters by pattern and provides typed values', async () => {
            const client = new NMeshedClient(defaultConfig);
            const handler = vi.fn();
            client.onKeyChange('player:*', handler);

            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;

            // Matching key
            MockWebSocket.instances[0].simulateBinaryMessage({
                type: 'op',
                payload: { key: 'player:123', value: { x: 10 }, timestamp: 100 }
            });

            // Non-matching key
            MockWebSocket.instances[0].simulateBinaryMessage({
                type: 'op',
                payload: { key: 'config:main', value: { d: 1 }, timestamp: 101 }
            });

            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler).toHaveBeenCalledWith('player:123', { x: 10 }, expect.objectContaining({ isOptimistic: false }));
        });
    });

    describe('set', () => {
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
            // Depending on timing, we might see SYNCING or move straight to READY
            const calls = listener.mock.calls.map(c => c[0]);
            expect(calls).toContain('CONNECTING');
            expect(calls.some(s => s === 'SYNCING' || s === 'READY')).toBe(true);
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
            // Engine should be destroyed, so getState should be empty
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
            const client = new NMeshedClient({ ...defaultConfig, serverUrl: 'wss://api.test.com' });
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
        });

        it('saves queued operations', async () => {
            const client = new NMeshedClient(defaultConfig);
            client.set('key', 'value');
            vi.advanceTimersByTime(150);
            expect(saveQueue).toHaveBeenCalled();
        });

        it('loads queued operations on init', async () => {
            const op = { key: 'saved', value: 'old', timestamp: 123 };
            (loadQueue as any).mockResolvedValue([op]);
            const client = new NMeshedClient(defaultConfig);
            // Wait for boot and persistence check
            await vi.waitFor(() => expect(client.getQueueSize()).toBe(1));
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
            client.onEphemeral(ephemeralHandler);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;
            MockWebSocket.instances[0].simulateTextMessage({
                type: 'ephemeral',
                payload: { userId: 'user-456', cursor: { x: 100, y: 200 } },
            });
            expect(ephemeralHandler).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'user-456' }),
                undefined
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
            // triggers onEphemeral which handler is subscribed to

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
            client.onEphemeral(badHandler);
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
            const sendCalls = (MockWebSocket.instances[0].send as ReturnType<typeof vi.fn>).mock.calls;
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



        it('respects maxQueueSize config', async () => {
            // Test that maxQueueSize is respected by checking via public API
            const client = new NMeshedClient({ ...defaultConfig, maxQueueSize: 2 });

            // Set values while disconnected - they queue in preConnectState
            client.set('k1', 'v1');
            client.set('k2', 'v2');
            client.set('k3', 'v3');

            // Queue should be limited to maxQueueSize
            expect(client.getQueueSize()).toBeLessThanOrEqual(2);
        });

        it('get() retrieves values from core state', async () => {
            const client = new NMeshedClient(defaultConfig);
            // Inject state via handleRemoteOp to populate confirmed state
            (client as any).engine.handleRemoteOp('foo', 'bar');

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
            const status = client.getStatus();
            expect(['SYNCING', 'READY']).toContain(status);
        });

        it('throws if onEphemeral handler is not a function', () => {
            const client = new NMeshedClient(defaultConfig);
            expect(() => client.onEphemeral('not-a-function' as any)).toThrow('Ephemeral handler must be a function');
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

    describe('Unified Transport Architecture', () => {
        describe('broadcast() (Ephemeral)', () => {
            it('sends non-binary data as ephemeral message', async () => {
                const client = new NMeshedClient(defaultConfig);
                const connectPromise = client.connect();
                await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
                const ws = MockWebSocket.instances[0];
                ws.simulateOpen();
                await connectPromise;

                client.broadcast({ type: 'test', data: 123 });
                expect(ws.send).toHaveBeenCalled();
            });

            it('can send to a specific peer using sendToPeer', async () => {
                const client = new NMeshedClient(defaultConfig);
                const connectPromise = client.connect();
                await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
                const ws = MockWebSocket.instances[0];
                ws.simulateOpen();
                await connectPromise;

                client.sendToPeer('specific-user', { msg: 'hello' });
                expect(ws.send).toHaveBeenCalled();
            });
        });

        describe('onPeerJoin() and onPeerDisconnect()', () => {
            it('subscribes to peer join events', () => {
                const client = new NMeshedClient(defaultConfig);
                const handler = vi.fn();
                const unsub = client.onPeerJoin(handler);
                expect(typeof unsub).toBe('function');
            });

            it('subscribes to peer disconnect events', () => {
                const client = new NMeshedClient(defaultConfig);
                const handler = vi.fn();
                const unsub = client.onPeerDisconnect(handler);
                expect(typeof unsub).toBe('function');
            });

            it('calls onPeerJoin when presence indicates online', async () => {
                const client = new NMeshedClient(defaultConfig);
                const peerJoinHandler = vi.fn();
                client.onPeerJoin(peerJoinHandler);

                const connectPromise = client.connect();
                await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
                MockWebSocket.instances[0].simulateOpen();
                await connectPromise;

                MockWebSocket.instances[0].simulateTextMessage({
                    type: 'presence',
                    payload: { userId: 'new-peer-123', status: 'online' },
                });

                expect(peerJoinHandler).toHaveBeenCalledWith('new-peer-123');
            });

            it('calls onPeerDisconnect when presence indicates offline', async () => {
                const client = new NMeshedClient(defaultConfig);
                const peerDisconnectHandler = vi.fn();
                client.onPeerDisconnect(peerDisconnectHandler);

                const connectPromise = client.connect();
                await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
                MockWebSocket.instances[0].simulateOpen();
                await connectPromise;

                MockWebSocket.instances[0].simulateTextMessage({
                    type: 'presence',
                    payload: { userId: 'left-peer-456', status: 'offline' },
                });

                expect(peerDisconnectHandler).toHaveBeenCalledWith('left-peer-456');
            });

            it('allows unsubscribing from peer join events', async () => {
                const client = new NMeshedClient(defaultConfig);
                const handler = vi.fn();
                const unsub = client.onPeerJoin(handler);

                const connectPromise = client.connect();
                await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
                MockWebSocket.instances[0].simulateOpen();
                await connectPromise;

                unsub();

                MockWebSocket.instances[0].simulateTextMessage({
                    type: 'presence',
                    payload: { userId: 'peer-789', status: 'online' },
                });

                expect(handler).not.toHaveBeenCalled();
            });

            it('allows unsubscribing from peer disconnect events', async () => {
                const client = new NMeshedClient(defaultConfig);
                const handler = vi.fn();
                const unsub = client.onPeerDisconnect(handler);

                const connectPromise = client.connect();
                await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
                MockWebSocket.instances[0].simulateOpen();
                await connectPromise;

                unsub();

                MockWebSocket.instances[0].simulateTextMessage({
                    type: 'presence',
                    payload: { userId: 'peer-101', status: 'offline' },
                });

                expect(handler).not.toHaveBeenCalled();
            });
        });

        describe('on() compatibility method', () => {
            it('maps peerJoin to onPeerJoin', () => {
                const client = new NMeshedClient(defaultConfig);
                const handler = vi.fn();
                const unsub = client.on('peerJoin', handler);
                expect(typeof unsub).toBe('function');
            });

            it('maps peerDisconnect to onPeerDisconnect', () => {
                const client = new NMeshedClient(defaultConfig);
                const handler = vi.fn();
                const unsub = client.on('peerDisconnect', handler);
                expect(typeof unsub).toBe('function');
            });

            it('returns no-op for unknown events', () => {
                const client = new NMeshedClient(defaultConfig);
                const unsub = client.on('unknownEvent', vi.fn());
                expect(typeof unsub).toBe('function');
                unsub(); // Should not throw
            });
        });

        describe('transport config', () => {
            it('defaults to server transport', () => {
                const client = new NMeshedClient(defaultConfig);
                expect((client as any).config.transport).toBe('server');
            });

            it('accepts p2p transport config', () => {
                const client = new NMeshedClient({ ...defaultConfig, transport: 'p2p' });
                expect((client as any).config.transport).toBe('p2p');
            });

            it('accepts hybrid transport config', () => {
                const client = new NMeshedClient({ ...defaultConfig, transport: 'hybrid' });
                expect((client as any).config.transport).toBe('hybrid');
            });

            it('rejects invalid transport values', () => {
                expect(() => new NMeshedClient({ ...defaultConfig, transport: 'invalid' as any }))
                    .toThrow();
            });
        });

        describe('broadcast routing', () => {
            it('broadcasts binary data via WebSocket in server mode', async () => {
                const client = new NMeshedClient(defaultConfig);
                const connectPromise = client.connect();
                await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
                const ws = MockWebSocket.instances[0];
                ws.simulateOpen();
                await connectPromise;

                const binaryData = new Uint8Array([1, 2, 3, 4]);
                client.broadcast(binaryData);
                expect(ws.send).toHaveBeenCalled();
            });

            it('broadcasts ArrayBuffer via WebSocket in server mode', async () => {
                const client = new NMeshedClient(defaultConfig);
                const connectPromise = client.connect();
                await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
                const ws = MockWebSocket.instances[0];
                ws.simulateOpen();
                await connectPromise;

                const buffer = new ArrayBuffer(4);
                client.broadcast(buffer);
                expect(ws.send).toHaveBeenCalled();
            });

            it('warns when broadcast is called while disconnected', () => {
                const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
                const client = new NMeshedClient(defaultConfig);
                client.broadcast({ type: 'test' });
                expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/broadcast.*called while/i));
                warnSpy.mockRestore();
            });
        });
    });

    describe('Reconnection and Edge Cases', () => {
        it('stops reconnecting after maxReconnectAttempts', async () => {
            const client = new NMeshedClient({
                ...defaultConfig,
                maxReconnectAttempts: 2,
                autoReconnect: true
            });
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;

            // Force disconnect (abnormal)
            MockWebSocket.instances[0].simulateClose(1006, 'Abnormal');
            expect(client.getStatus()).toBe('RECONNECTING');

            vi.advanceTimersByTime(2000);
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(2));
            MockWebSocket.instances[1].simulateClose(1006);

            vi.advanceTimersByTime(4000);
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(3));
            MockWebSocket.instances[2].simulateClose(1006);

            // 3rd attempt fails = maxReconnectAttempts (2) exceeded
            // Status should be ERROR
            expect(client.getStatus()).toBe('ERROR');
        });

        it('does not reconnect if autoReconnect is false', async () => {
            const client = new NMeshedClient({ ...defaultConfig, autoReconnect: false });
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;

            MockWebSocket.instances[0].simulateClose(1006, 'Abnormal');
            expect(client.getStatus()).toBe('DISCONNECTED');

            vi.advanceTimersByTime(10000);
            expect(MockWebSocket.instances.length).toBe(1);
        });

        it('resolves immediately if connecting while already connecting', async () => {
            const client = new NMeshedClient(defaultConfig);
            const p1 = client.connect();
            const p2 = client.connect();

            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();

            await p1;
            await p2;
            expect(MockWebSocket.instances.length).toBe(1);
        });

        it('rejects connect() on destroyed client', async () => {
            const client = new NMeshedClient(defaultConfig);
            client.destroy();
            await expect(client.connect()).rejects.toThrow('destroyed');
        });
    });
});
