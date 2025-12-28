import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { usePresence } from './usePresence';
import { useDocument } from './useDocument';
import { useBroadcast } from './useBroadcast';
import { NMeshedProvider } from './context';
import { MockNMeshedClient, setupTestMocks, teardownTestMocks } from '../test-utils/mocks';

describe('React Hooks Coverage', () => {
    const config = { workspaceId: 'ws', userId: 'user-1', token: 'tk' };
    let client: any;

    const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
        React.createElement(NMeshedProvider, { client, children });

    beforeEach(() => {
        setupTestMocks();
        vi.useFakeTimers();
        client = new MockNMeshedClient(config);
    });

    afterEach(() => {
        teardownTestMocks();
        vi.useRealTimers();
    });

    describe('usePresence', () => {
        it('should fetch initial presence and listen for updates', async () => {
            // Populate mock peers for initial fetch
            client.peers.set('user-2', { userId: 'user-2', status: 'online' });

            const { result } = renderHook(() => usePresence(), { wrapper: Wrapper });

            // Initial fetch happens in useEffect
            await vi.waitFor(() => {
                expect(result.current).toContainEqual(expect.objectContaining({ userId: 'user-2' }));
            });

            // Update via event
            await act(async () => {
                client.emit('presence', { userId: 'user-3', status: 'online' });
            });

            expect(result.current).toContainEqual(expect.objectContaining({ userId: 'user-3' }));

            // Offline update
            await act(async () => {
                client.emit('presence', { userId: 'user-3', status: 'offline' });
            });

            expect(result.current.find(u => u.userId === 'user-3')).toBeUndefined();
        });

        it('should handle ping intervals for latency (periodic updates)', async () => {
            client.peers.set('user-2', { userId: 'user-2', status: 'online' });
            await act(async () => {
                await client.connect();
            });

            const { result } = renderHook(() => usePresence(), { wrapper: Wrapper });

            // Wait for initial load
            await vi.waitFor(() => {
                expect(result.current.some(u => u.userId === 'user-2' && u.status === 'online')).toBe(true);
            });

            // Advance time to trigger ping interval (5s)
            await act(async () => {
                // First tick to set up interval
                await vi.advanceTimersByTimeAsync(0);
                // Second tick to trigger interval
                await vi.advanceTimersByTimeAsync(5000);
            });

            await vi.waitFor(() => {
                const u = result.current.find(u => u.userId === 'user-2');
                expect(u?.latency).toBeDefined();
                expect(u?.latency).toBeGreaterThan(0);
            });
        });
    });

    describe('useDocument', () => {
        it('should sync with client state and handle updates', async () => {
            client.set('test-key', 'initial');

            const { result } = renderHook(() => useDocument({ key: 'test-key' }), { wrapper: Wrapper });

            expect(result.current.value).toBe('initial');
            expect(result.current.isLoaded).toBe(true);

            // Remote update via message
            await act(async () => {
                client.emit('message', {
                    type: 'op',
                    payload: { key: 'test-key', value: 'updated' },
                    timestamp: Date.now()
                });
            });

            expect(result.current.value).toBe('updated');

            // Local update
            const setSpy = vi.spyOn(client, 'set');
            await act(async () => {
                result.current.setValue('local-update');
            });

            expect(setSpy).toHaveBeenCalledWith('test-key', 'local-update');
            expect(result.current.value).toBe('local-update');
        });

        it('should handle init messages', async () => {
            const { result } = renderHook(() => useDocument({ key: 'k1' }), { wrapper: Wrapper });

            await act(async () => {
                client.emit('message', {
                    type: 'init',
                    data: { k1: 'val1', k2: 'val2' }
                });
            });

            expect(result.current.value).toBe('val1');
            expect(result.current.isLoaded).toBe(true);
        });
    });

    describe('useBroadcast', () => {
        it('should send and receive ephemeral messages', async () => {
            const handler = vi.fn();
            const { result } = renderHook(() => useBroadcast(handler), { wrapper: Wrapper });

            // Receive
            await act(async () => {
                client.emit('ephemeral', { msg: 'hello' }, 'peer-1');
            });
            expect(handler).toHaveBeenCalledWith({ msg: 'hello' });

            // Send
            const sendMessageSpy = vi.spyOn(client, 'sendMessage');
            await act(async () => {
                result.current({ foo: 'bar' });
            });
            expect(sendMessageSpy).toHaveBeenCalledWith(expect.anything());
        });
    });
});
