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

    simulateBinaryMessage(data: ArrayBuffer) {
        this.onmessage?.({ data });
    }

    simulateClose(code = 1000, reason = '') {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.({ code, reason });
    }

    simulateError() {
        this.onerror?.({});
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
        expect(['IDLE', 'CONNECTING']).toContain(result.current.status);
    });

    it('connects and updates status', async () => {
        const { result } = renderHook(() => useNmeshed(defaultConfig));
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());
        await waitFor(() => expect(result.current.status).toBe('CONNECTED'));
    });

    it('triggers onError callback on connection failure', async () => {
        const onError = vi.fn();
        renderHook(() => useNmeshed({ ...defaultConfig, onError }));
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateError());
        await waitFor(() => expect(onError).toHaveBeenCalled());
    });
});

describe('useDocument', () => {
    const defaultConfig = { workspaceId: 'test-ws', token: 'test-tk' };
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
        React.createElement(NMeshedProvider, { config: defaultConfig, children });

    it('returns initial value before server data', () => {
        const { result } = renderHook(() => useDocument({ key: 'a', initialValue: 1 }), { wrapper });
        expect(result.current.value).toBe(1);
    });

    it('updates when server sends init', async () => {
        const { result } = renderHook(() => useDocument({ key: 'a', initialValue: 1 }), { wrapper });
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());
        act(() => {
            const data = new TextEncoder().encode(JSON.stringify({ type: 'init', data: { a: 42 } }));
            MockWebSocket.instances[0].simulateBinaryMessage(data.buffer);
        });
        await waitFor(() => expect(result.current.value).toBe(42));
    });

    it('ignores init message without the key', async () => {
        const { result } = renderHook(() => useDocument({ key: 'a' }), { wrapper });
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());

        act(() => {
            const data = new TextEncoder().encode(JSON.stringify({ type: 'init', data: { b: 2 } }));
            MockWebSocket.instances[0].simulateBinaryMessage(data.buffer);
        });
        // result.current.value should still be undefined if not in init
        expect(result.current.value).toBeUndefined();
    });

    it('setValue performs optimistic update and sends to server', async () => {
        const { result } = renderHook(() => useDocument({ key: 'myKey', initialValue: 0 }), { wrapper });
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());

        act(() => {
            result.current.setValue(42);
        });

        expect(result.current.value).toBe(42);
        expect(MockWebSocket.instances[0].send).toHaveBeenCalled();
    });
});

describe('usePresence Hooks', () => {
    const defaultConfig = { workspaceId: 'ws-pres', token: 'tk' };
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
        React.createElement(NMeshedProvider, { config: defaultConfig, children });

    beforeEach(() => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [{ userId: 'u1', status: 'online' }]
        } as Response);
    });

    it('updates on real-time events and handles updates to existing users', async () => {
        const { result } = renderHook(() => usePresence({}), { wrapper });
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());

        await waitFor(() => expect(result.current.length).toBe(1));

        // Update existing user
        act(() => {
            const msg = JSON.stringify({ type: 'presence', payload: { userId: 'u1', status: 'away' } });
            MockWebSocket.instances[0].onmessage?.({ data: msg });
        });
        await waitFor(() => expect(result.current[0].status).toBe('away'));

        // Add new user
        act(() => {
            const msg = JSON.stringify({ type: 'presence', payload: { userId: 'u2', status: 'online' } });
            MockWebSocket.instances[0].onmessage?.({ data: msg });
        });
        await waitFor(() => expect(result.current.length).toBe(2));
    });

    it('handles initial fetch failure gracefully', async () => {
        global.fetch = vi.fn().mockRejectedValue(new Error('API Down'));
        const { result } = renderHook(() => usePresence({}), { wrapper });
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());
        // Should remain empty but not crash
        await waitFor(() => expect(result.current.length).toBe(0));
    });

    it('removes user when status is offline', async () => {
        const { result } = renderHook(() => usePresence({}), { wrapper });
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());
        await waitFor(() => expect(result.current.length).toBe(1));

        // Send offline event
        act(() => {
            const msg = JSON.stringify({ type: 'presence', payload: { userId: 'u1', status: 'offline' } });
            MockWebSocket.instances[0].onmessage?.({ data: msg });
        });
        await waitFor(() => expect(result.current.length).toBe(0));
    });

    it('generates stable color for users without color', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [{ userId: 'testuser123', status: 'online' }]
        } as Response);
        const { result } = renderHook(() => usePresence({}), { wrapper });
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());
        await waitFor(() => expect(result.current.length).toBe(1));
        expect(result.current[0].color).toMatch(/^hsl\(/);
    });
});

describe('useBroadcast', () => {
    const defaultConfig = { workspaceId: 'ws-bc', token: 'tk' };
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
        React.createElement(NMeshedProvider, { config: defaultConfig, children });

    it('receives messages', async () => {
        const handler = vi.fn();
        renderHook(() => useBroadcast(handler), { wrapper });
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());
        act(() => {
            const msg = JSON.stringify({ type: 'ephemeral', payload: { ping: 'pong' } });
            MockWebSocket.instances[0].onmessage?.({ data: msg });
        });
        await waitFor(() => expect(handler).toHaveBeenCalledWith({ ping: 'pong' }));
    });

    it('returns a send function', async () => {
        const handler = vi.fn();
        const { result } = renderHook(() => useBroadcast(handler), { wrapper });
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());

        act(() => {
            result.current({ action: 'test' });
        });
        expect(MockWebSocket.instances[0].send).toHaveBeenCalled();
    });
});

describe('useNmeshed Extras', () => {
    const defaultConfig = { workspaceId: 'ws-extra', token: 'tk' };

    it('handles connection error callback', async () => {
        const onError = vi.fn();
        renderHook(() => useNmeshed({ ...defaultConfig, onError }));
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].onerror?.(new Error('fail')));
        await waitFor(() => expect(onError).toHaveBeenCalled());
    });

    it('performs optimistic updates', async () => {
        const { result } = renderHook(() => useNmeshed(defaultConfig));
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());

        act(() => result.current.set('key', 'val'));
        expect(result.current.state.key).toBe('val');
    });

    it('disconnects on unmount', async () => {
        const { unmount } = renderHook(() => useNmeshed(defaultConfig));
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        const ws = MockWebSocket.instances[0];
        unmount();
        expect(ws.close).toHaveBeenCalled();
    });

    it('calls onConnect callback', async () => {
        const onConnect = vi.fn();
        renderHook(() => useNmeshed({ ...defaultConfig, onConnect }));
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());
        await waitFor(() => expect(onConnect).toHaveBeenCalled());
    });

    it('get method retrieves value from state', async () => {
        const { result } = renderHook(() => useNmeshed(defaultConfig));
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());

        act(() => result.current.set('myKey', 'myValue'));
        expect(result.current.get<string>('myKey')).toBe('myValue');
        expect(result.current.get<string>('missing')).toBeUndefined();
    });

    it('exposes isConnected computed property', async () => {
        const { result } = renderHook(() => useNmeshed(defaultConfig));
        expect(result.current.isConnected).toBe(false);

        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());
        await waitFor(() => expect(result.current.isConnected).toBe(true));
    });

    it('exposes queueSize', async () => {
        const { result } = renderHook(() => useNmeshed(defaultConfig));
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());

        expect(result.current.queueSize).toBeGreaterThanOrEqual(0);
    });

    it('exposes connect and disconnect methods', async () => {
        const { result } = renderHook(() => useNmeshed(defaultConfig));
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());

        expect(typeof result.current.connect).toBe('function');
        expect(typeof result.current.disconnect).toBe('function');
    });

    it('handles init message from server', async () => {
        const { result } = renderHook(() => useNmeshed(defaultConfig));
        await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        act(() => MockWebSocket.instances[0].simulateOpen());

        act(() => {
            const msg = { type: 'init', data: { counter: 42, name: 'Test' } };
            const data = new TextEncoder().encode(JSON.stringify(msg));
            MockWebSocket.instances[0].simulateBinaryMessage(data.buffer);
        });

        await waitFor(() => expect(result.current.state.counter).toBe(42));
        expect(result.current.state.name).toBe('Test');
    });
});

describe('Context and Provider', () => {
    it('useNmeshedContext throws when used outside provider', () => {
        expect(() => {
            renderHook(() => useNmeshedContext());
        }).toThrow('useNmeshedContext must be used within an NMeshedProvider');
    });

    it('NMeshedProvider with autoConnect=false does not auto-connect', async () => {
        const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
            React.createElement(NMeshedProvider, { config: { workspaceId: 'ws', token: 'tk' }, autoConnect: false, children });

        renderHook(() => useNmeshedContext(), { wrapper });

        // Wait a bit and check no WebSocket was created
        await new Promise(r => setTimeout(r, 50));
        expect(MockWebSocket.instances.length).toBe(0);
    });
});
