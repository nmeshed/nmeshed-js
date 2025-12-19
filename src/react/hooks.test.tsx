import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { useNmeshed } from './useNmeshed';
import { NMeshedProvider, useNmeshedContext } from './context';
import { useDocument } from './useDocument';

// Mock the WASM core
vi.mock('../wasm/nmeshed_core', () => {
    class MockCore {
        state: Record<string, string> = {};
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
        merge_remote_delta = vi.fn();
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
    onopen: (() => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;

    constructor(public url: string) {
        MockWebSocket.instances.push(this);
    }

    send = vi.fn();
    close = vi.fn();

    simulateOpen() {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.();
    }

    simulateMessage(data: unknown) {
        this.onmessage?.({ data: JSON.stringify(data) });
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
            MockWebSocket.instances[0].simulateMessage({
                type: 'init',
                data: { counter: 5, title: 'Hello' },
            });
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
            MockWebSocket.instances[0].simulateMessage({
                type: 'init',
                data: { counter: 42 },
            });
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
});
