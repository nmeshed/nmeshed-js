import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNmeshed } from './useNmeshed';
import { NMeshedClient } from '../client';
import { setupTestMocks, teardownTestMocks, MockWebSocket } from '../test-utils/mocks';

const VALID_WS = '00000000-0000-0000-0000-000000000001';

// Sequential to avoid global WebSocket stub collisions
describe.sequential('useNmeshed hook', () => {
    const config = {
        workspaceId: VALID_WS,
        userId: '00000000-0000-0000-0000-000000000010',
        token: 'tk-1',
        connectionTimeout: 2000
    };

    beforeEach(() => {
        setupTestMocks();
    });

    afterEach(() => {
        teardownTestMocks();
    });

    it('should initialize and provide client', async () => {
        const { result } = renderHook(() => useNmeshed(config));
        expect(result.current.client).toBeInstanceOf(NMeshedClient);
    });

    it('should handle optimistic updates in set() and get()', async () => {
        const { result } = renderHook(() => useNmeshed(config));

        await act(async () => {
            result.current.set('ui-theme', 'dark');
        });

        expect(result.current.state?.['ui-theme']).toBe('dark');
        expect(result.current.get('ui-theme')).toBe('dark');
    });

    it('should handle state updates from client messages', async () => {
        const { result } = renderHook(() => useNmeshed(config));
        const client = result.current.client;

        await act(async () => {
            (client as any).emit('message', {
                type: 'init',
                data: { score: 100 }
            });
        });
        expect(result.current.state.score).toBe(100);

        await act(async () => {
            (client as any).emit('message', {
                type: 'op',
                payload: { key: 'level', value: 5 }
            });
        });
        expect(result.current.state.level).toBe(5);
    });

    it('should transition to READY state when socket opens organically', async () => {
        const onConnect = vi.fn();
        const { result } = renderHook(() => useNmeshed({ ...config, onConnect }));

        await vi.waitFor(() => {
            if (MockWebSocket.instances.length === 0) throw new Error('Socket not created yet');
        }, { timeout: 5000 });

        const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];

        await act(async () => {
            socket.simulateOpen();
        });

        await vi.waitFor(() => {
            expect(result.current.status).toBe('READY');
            expect(result.current.isConnected).toBe(true);
        }, { timeout: 5000 });

        expect(onConnect).toHaveBeenCalled();
    });

    it('should handle DISCONNECTED status organically', async () => {
        const onDisconnect = vi.fn();
        const { result } = renderHook(() => useNmeshed({ ...config, onDisconnect }));

        await vi.waitFor(() => {
            if (MockWebSocket.instances.length === 0) throw new Error('Socket not created yet');
        }, { timeout: 5000 });
        const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];

        await act(async () => {
            socket.simulateOpen();
        });
        await vi.waitFor(() => expect(result.current.status).toBe('READY'), { timeout: 5000 });

        await act(async () => {
            socket.simulateClose();
        });

        await vi.waitFor(() => {
            expect(result.current.status).toBe('DISCONNECTED');
        }, { timeout: 5000 });
        expect(onDisconnect).toHaveBeenCalled();
    });

    it('should handle ERROR status organically (Terminal Close)', async () => {
        const onError = vi.fn();
        const { result } = renderHook(() => useNmeshed({ ...config, onError }));

        await vi.waitFor(() => {
            if (MockWebSocket.instances.length === 0) throw new Error('Socket not created yet');
        }, { timeout: 5000 });
        const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];

        await act(async () => {
            socket.simulateClose(4000, 'Terminal Error');
        });

        await vi.waitFor(() => {
            expect(result.current.status).toBe('ERROR');
        }, { timeout: 5000 });

        expect(onError).toHaveBeenCalled();
    });

    it('should handle transient errors via callback', async () => {
        const onError = vi.fn();
        const { result } = renderHook(() => useNmeshed({ ...config, onError }));

        await vi.waitFor(() => {
            if (MockWebSocket.instances.length === 0) throw new Error('Socket not created yet');
        }, { timeout: 5000 });
        const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];

        await act(async () => {
            socket.simulateError(new Error('Auth failed'));
        });

        await vi.waitFor(() => {
            expect(onError).toHaveBeenCalled();
        }, { timeout: 5000 });
    });

    it('should track queue size', async () => {
        const { result } = renderHook(() => useNmeshed(config));
        const client = result.current.client;

        // Force a mock value for getQueueSize to cover the reactive update
        vi.spyOn(client, 'getQueueSize').mockReturnValue(42);

        await act(async () => {
            // Signal a change in the internal engine queue
            (client as any).engine.emit('queueChange', 999);
        });

        await vi.waitFor(() => {
            expect(result.current.queueSize).toBe(42);
        });
    });

    it('should expose connect and disconnect methods', async () => {
        const { result } = renderHook(() => useNmeshed(config));
        const connectSpy = vi.spyOn(result.current.client, 'connect');
        const disconnectSpy = vi.spyOn(result.current.client, 'disconnect');

        await act(async () => {
            result.current.connect();
            result.current.disconnect();
        });
        expect(connectSpy).toHaveBeenCalled();
        expect(disconnectSpy).toHaveBeenCalled();
    });
});
