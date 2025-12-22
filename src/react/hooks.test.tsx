import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { useNmeshed } from './useNmeshed';
import { NMeshedProvider, useNmeshedContext } from './context';
import { useDocument } from './useDocument';
import { usePresence } from './usePresence';
import { useBroadcast } from './useBroadcast';

// Mock the WASM core - simulates binary protocol
vi.mock('../wasm/nmeshed_core', () => {
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
        // Mock merge_remote_delta to return op info like the real WASM
        merge_remote_delta = vi.fn((bytes: Uint8Array) => {
            // Simulate decoding the bytes and returning op info
            // Real WASM returns { type: 'op', key: string, value: Uint8Array }
            // For tests, we decode a simulated init/op format
            try {
                const text = new TextDecoder().decode(bytes);
                const parsed = JSON.parse(text);
                if (parsed.type === 'init') {
                    for (const [k, v] of Object.entries(parsed.data)) {
                        (this as MockCore).state[k] = v;
                    }
                    // Return init type so client dispatches to listeners
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

// Mock WebSocket
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

    /**
     * Simulates receiving a binary CRDT operation from the server.
     * This triggers the binary code path which calls merge_remote_delta.
     */
    simulateBinaryMessage(data: ArrayBuffer) {
        this.onmessage?.({ data });
    }

    simulateClose(code = 1000, reason = '') {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.({ code, reason });
    }
}

const originalWebSocket = global.WebSocket;

beforeEach(() => {
    MockWebSocket.instances = [];
    global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
    global.WebSocket = originalWebSocket;
    vi.restoreAllMocks();
});

describe('useNmeshed', () => {
    const defaultConfig = {
        workspaceId: 'test-workspace',
        token: 'test-token',
    };

    it('initializes with IDLE status', () => {
        const { result } = renderHook(() => useNmeshed(defaultConfig));

        // Initially IDLE, then quickly CONNECTING
        expect(['IDLE', 'CONNECTING']).toContain(result.current.status);
    });

    it('connects and updates status', async () => {
        const { result } = renderHook(() => useNmeshed(defaultConfig));

        // Wait for connection attempt
        await waitFor(() => {
            expect(MockWebSocket.instances.length).toBeGreaterThan(0);
        });

        // Simulate successful connection
        act(() => {
            MockWebSocket.instances[0].simulateOpen();
        });

        await waitFor(() => {
            expect(result.current.status).toBe('CONNECTED');
            expect(result.current.isConnected).toBe(true);
        });
    });

    it('updates state on init message', async () => {
        const { result } = renderHook(() => useNmeshed(defaultConfig));

        await waitFor(() => {
            expect(MockWebSocket.instances.length).toBeGreaterThan(0);
        });

        act(() => {
            MockWebSocket.instances[0].simulateOpen();
        });

        await waitFor(() => {
            expect(result.current.isConnected).toBe(true);
        });

        act(() => {
            // Simulate binary init message (encoded as JSON for test mock)
            const initPayload = JSON.stringify({
                type: 'init',
                data: { counter: 5, title: 'Hello' },
            });
            const bytes = new TextEncoder().encode(initPayload);
            MockWebSocket.instances[0].simulateBinaryMessage(bytes.buffer);
        });

        await waitFor(() => {
            expect(result.current.state.counter).toBe(5);
            expect(result.current.state.title).toBe('Hello');
        });
    });

    it('set() updates local state optimistically', async () => {
        const { result } = renderHook(() => useNmeshed(defaultConfig));

        await waitFor(() => {
            expect(MockWebSocket.instances.length).toBeGreaterThan(0);
        });

        act(() => {
            MockWebSocket.instances[0].simulateOpen();
        });

        await waitFor(() => {
            expect(result.current.isConnected).toBe(true);
        });

        act(() => {
            result.current.set('myKey', 'myValue');
        });

        expect(result.current.state.myKey).toBe('myValue');
    });

    it('calls onConnect callback', async () => {
        const onConnect = vi.fn();

        renderHook(() => useNmeshed({
            ...defaultConfig,
            onConnect,
        }));

        await waitFor(() => {
            expect(MockWebSocket.instances.length).toBeGreaterThan(0);
        });

        act(() => {
            MockWebSocket.instances[0].simulateOpen();
        });

        await waitFor(() => {
            expect(onConnect).toHaveBeenCalled();
        });
    });
});

describe('nMeshedProvider', () => {
    const defaultConfig = {
        workspaceId: 'test-workspace',
        token: 'test-token',
    };

    it('provides client to children via context', async () => {
        const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => {
            return React.createElement(NMeshedProvider, { config: defaultConfig, children });
        };

        const { result } = renderHook(() => useNmeshedContext(), { wrapper });

        expect(result.current).toBeDefined();
        expect(typeof result.current.connect).toBe('function');
        expect(typeof result.current.set).toBe('function');
    });

    it('throws without provider', () => {
        // Suppress console.error for this test
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

        expect(() => {
            renderHook(() => useNmeshedContext());
        }).toThrow('useNmeshedContext must be used within an NMeshedProvider');

        consoleSpy.mockRestore();
    });

    it('auto-connects when autoConnect is true', async () => {
        const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => {
            return React.createElement(NMeshedProvider, { config: defaultConfig, autoConnect: true, children });
        };

        renderHook(() => useNmeshedContext(), { wrapper });

        await waitFor(() => {
            expect(MockWebSocket.instances.length).toBeGreaterThan(0);
        });
    });
});

describe('useDocument', () => {
    const defaultConfig = {
        workspaceId: 'test-workspace',
        token: 'test-token',
    };

    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => {
        return React.createElement(NMeshedProvider, { config: defaultConfig, children });
    };

    it('returns initial value before server data', async () => {
        const { result } = renderHook(
            () => useDocument<number>({ key: 'counter', initialValue: 0 }),
            { wrapper }
        );

        expect(result.current.value).toBe(0);
        expect(result.current.isLoaded).toBe(false);
    });

    it('updates when server sends init', async () => {
        const { result } = renderHook(
            () => useDocument<number>({ key: 'counter', initialValue: 0 }),
            { wrapper }
        );

        await waitFor(() => {
            expect(MockWebSocket.instances.length).toBeGreaterThan(0);
        });

        act(() => {
            MockWebSocket.instances[0].simulateOpen();
        });

        act(() => {
            // Simulate binary init message (encoded as JSON for test mock)
            const initPayload = JSON.stringify({
                type: 'init',
                data: { counter: 42 },
            });
            const bytes = new TextEncoder().encode(initPayload);
            MockWebSocket.instances[0].simulateBinaryMessage(bytes.buffer);
        });

        await waitFor(() => {
            expect(result.current.value).toBe(42);
            expect(result.current.isLoaded).toBe(true);
        });
    });

    it('setValue updates value optimistically', async () => {
        const { result } = renderHook(
            () => useDocument<number>({ key: 'counter', initialValue: 0 }),
            { wrapper }
        );

        await waitFor(() => {
            expect(MockWebSocket.instances.length).toBeGreaterThan(0);
        });

        act(() => {
            MockWebSocket.instances[0].simulateOpen();
        });

        act(() => {
            result.current.setValue(100);
        });

        expect(result.current.value).toBe(100);
    });

    it('retains value when offline', async () => {
        const { result } = renderHook(
            () => useDocument<number>({ key: 'counter', initialValue: 0 }),
            { wrapper }
        );

        // Load data
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());
        act(() => {
            const initPayload = JSON.stringify({ type: 'init', data: { counter: 42 } });
            const bytes = new TextEncoder().encode(initPayload);
            MockWebSocket.instances[0].simulateBinaryMessage(bytes.buffer);
        });
        await waitFor(() => expect(result.current.value).toBe(42));

        // Go offline
        act(() => MockWebSocket.instances[0].simulateClose());

        // Value should persist
        expect(result.current.value).toBe(42);
        expect(result.current.isLoaded).toBe(true);
    });
});

// Re-write usePresence test cleanly

// Re-write usePresence test cleanly
describe('usePresence Hooks', () => {
    const defaultConfig = { workspaceId: 'ws-pres', token: 'tk' };

    // Use top level imports

    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
        React.createElement(NMeshedProvider, { config: defaultConfig, children });

    beforeEach(() => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [{ userId: 'u1', status: 'online' }]
        } as Response);
    });

    it('updates on real-time events', async () => {
        const { result } = renderHook(() => usePresence({}), { wrapper });

        // Connect
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());

        // Wait for fetch (async) - hard to detect exact moment, but state should update
        await waitFor(() => {
            // Check if initial fetch happened
            return result.current.length > 0;
        });
        expect(result.current).toEqual([{ userId: 'u1', status: 'online' }]);

        // Send WS update (new user)
        act(() => {
            const presenceMsg = JSON.stringify({
                type: 'presence',
                payload: { userId: 'u2', status: 'online' }
            });
            // NB: The mock core logic for simple passing messages might need to be verified.
            // In hooks.test.tsx MockCore logic handles "init" and "op".
            // It does NOT handle "presence" type in merge_remote_delta.
            // However, the CLIENT listens to WebSocket messages directly for control messages?
            // No, client uses `this.socket.onmessage`.
            // If binary, it goes to WASM.
            // If text, it parses JSON. 
            // MockWebSocket.simulateBinaryMessage sends arraybuffer.
            // MockWebSocket needs a way to send TEXT message for presence if protocol uses text for presence?
            // Wait, Presence IS broadcast via PubSub which is usually binary in current server?
            // Actually, `client.ts` handleMessage parses text OR binary.
            // Let's verify `client.ts` handleMessage logic.
            // Assuming it handles text JSON for presence.
            MockWebSocket.instances[0].onmessage?.({ data: presenceMsg });
        });

        await waitFor(() => {
            expect(result.current.length).toBe(2);
        });
        expect(result.current).toContainEqual({ userId: 'u2', status: 'online' });

        // Offline update
        act(() => {
            const presenceMsg = JSON.stringify({
                type: 'presence',
                payload: { userId: 'u1', status: 'offline' }
            });
            MockWebSocket.instances[0].onmessage?.({ data: presenceMsg });
        });

        await waitFor(() => {
            expect(result.current.length).toBe(1);
        });
        expect(result.current[0].userId).toBe('u2');
    });
});

describe('useBroadcast', () => {
    const defaultConfig = { workspaceId: 'ws-bc', token: 'tk' };
    // Use top level imports
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
        React.createElement(NMeshedProvider, { config: defaultConfig, children });

    it('receives messages', async () => {
        const handler = vi.fn();
        renderHook(() => useBroadcast(handler), { wrapper });

        // Connect
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());

        act(() => {
            const msg = JSON.stringify({
                type: 'ephemeral',
                payload: { foo: 'bar' }
            });
            MockWebSocket.instances[0].onmessage?.({ data: msg });
        });

        await waitFor(() => {
            expect(handler).toHaveBeenCalledWith({ foo: 'bar' });
        });
    });

    it('sends messages', async () => {
        const { result } = renderHook(() => useBroadcast(), { wrapper });

        // Connect
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        const ws = MockWebSocket.instances[0];
        act(() => ws.simulateOpen());

        act(() => {
            result.current({ baz: 'qux' });
        });

        expect(ws.send).toHaveBeenCalled();
    });
});
