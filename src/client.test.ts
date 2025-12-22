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

// ... MockWebSocket class definition must be available here, or we need to move it up ...
// Wait, MockWebSocket is defined further down in the file. Javascript hoisting works for classes? No.
// We need to move MockWebSocket to the top or stub it differently. 
// Given the previous structure, MockWebSocket was defined before usage.

// Let's defer stubbing until inside setup to be safe, or assume MockWebSocket is available if I don't delete it.
// I'll check where MockWebSocket is. It was around line 35.

// I will just restore the imports for now and let the rest be.

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
        // Mock merge_remote_delta to work with binary protocol test messages
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

// Mock WebSocket with binary message support
class MockWebSocket {
    static instances: MockWebSocket[] = [];

    // WebSocket ready state constants (must match browser WebSocket)
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

    /**
     * Simulates receiving a binary message (primary path).
     * Encodes the data as JSON bytes for the mock WASM to decode.
     */
    simulateBinaryMessage(data: unknown) {
        const jsonBytes = new TextEncoder().encode(JSON.stringify(data));
        this.onmessage?.({ data: jsonBytes.buffer });
    }

    /**
     * Simulates receiving raw binary data (ArrayBuffer).
     */
    simulateRawBinaryMessage(data: ArrayBuffer) {
        this.onmessage?.({ data });
    }

    /**
     * Simulates receiving a JSON text message (control messages: presence, errors, ephemeral).
     * This exercises the handleControlMessage path.
     */
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

            // Should not throw
            expect(() => client.set('circular', circular)).not.toThrow();

            // Should not be sent (as serialization fails) and NOT queued
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

    describe('getState', () => {
        it('returns a copy of the state', async () => {
            const client = new NMeshedClient(defaultConfig);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();
            await connectPromise;
            ws.simulateBinaryMessage({
                type: 'init',
                data: { a: 1, b: 2 },
            });
            const state = client.getState();
            expect(state).toEqual({ a: 1, b: 2 });
            state.c = 3;
            expect(client.get('c')).toBeUndefined();
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

            // Wait for async load (microtasks)
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(client.getQueueSize()).toBe(1);
        });
    });

    // =========================================================================
    // BINARY PATH TESTS (CRDT Operations - Hot Path)
    // =========================================================================
    describe('binary CRDT path', () => {
        it('processes binary init messages via merge_remote_delta', async () => {
            const client = new NMeshedClient(defaultConfig);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();
            await connectPromise;

            // Simulate binary init message
            ws.simulateBinaryMessage({
                type: 'init',
                data: { score: 100, player: 'Alice' },
            });

            expect(client.get('score')).toBe(100);
            expect(client.get('player')).toBe('Alice');
        });

        it('processes binary op messages and notifies listeners', async () => {
            const client = new NMeshedClient(defaultConfig);
            const listener = vi.fn();
            client.onMessage(listener);

            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;

            MockWebSocket.instances[0].simulateBinaryMessage({
                type: 'op',
                payload: { key: 'health', value: 75, timestamp: 456 },
            });

            expect(listener).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'op',
                    payload: expect.objectContaining({ key: 'health' }),
                })
            );
        });
    });

    // =========================================================================
    // JSON CONTROL MESSAGE TESTS (Presence, Errors, Ephemeral)
    // =========================================================================
    describe('JSON control message path', () => {
        it('handles presence updates from server', async () => {
            const client = new NMeshedClient(defaultConfig);
            const presenceHandler = vi.fn();
            client.onPresence(presenceHandler);

            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;

            // Simulate presence message as JSON text
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

            // Simulate ephemeral message (cursor update)
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

            // Should not throw
            expect(() => {
                MockWebSocket.instances[0].simulateTextMessage({
                    type: 'error',
                    error: 'Rate limit exceeded',
                });
            }).not.toThrow();
        });

        it('ignores unknown control message types', async () => {
            const client = new NMeshedClient(defaultConfig);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;

            // Should not throw on unknown type
            expect(() => {
                MockWebSocket.instances[0].simulateTextMessage({
                    type: 'unknown_future_type',
                    data: {},
                });
            }).not.toThrow();
        });

        it('ignores malformed JSON text messages', async () => {
            const client = new NMeshedClient(defaultConfig);
            const connectPromise = client.connect();
            await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
            MockWebSocket.instances[0].simulateOpen();
            await connectPromise;

            // Send raw invalid text (not JSON)
            expect(() => {
                MockWebSocket.instances[0].onmessage?.({ data: 'not valid json {{' });
            }).not.toThrow();
        });
    });
});
