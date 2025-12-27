import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useStore } from './useStore';
import { usePresence } from './usePresence';
import { NMeshedProvider } from './context';
import { NMeshedClient } from '../client';
import { defineSchema } from '../schema/SchemaBuilder';
import { setupTestMocks } from '../test-utils/mocks';

// Mock WASM Core
vi.mock('../wasm/nmeshed_core', async () => {
    const mocks = await import('../test-utils/mocks');
    return {
        default: vi.fn().mockResolvedValue(undefined),
        NMeshedClientCore: mocks.MockWasmCore
    };
});

// Mock persistence
vi.mock('../persistence', () => ({
    loadQueue: vi.fn().mockResolvedValue([]),
    saveQueue: vi.fn().mockResolvedValue(undefined),
}));

describe('Coverage Hardening: React Hooks', () => {
    const config = { workspaceId: 'ws-react', token: 'tok', userId: 'user-react' };
    const TestSchema = defineSchema({
        count: 'int32',
        title: 'string',
        meta: { type: 'object', schema: { color: 'string' } },
        big: 'int64'
    });

    beforeEach(() => {
        setupTestMocks();
        vi.useFakeTimers();
    });

    const wrapper = ({ children }: { children: React.ReactNode }) => (
        <NMeshedProvider config={config}>
            {children}
        </NMeshedProvider>
    );

    describe('useStore Branch Coverage', () => {
        it('handles setStore with invalid updates (branch coverage)', () => {
            const { result } = renderHook(() => useStore(TestSchema), { wrapper });
            const [, setStore] = result.current;

            // @ts-ignore - testing runtime error
            expect(() => setStore(null as any)).toThrow(/invalid updates/);
            // @ts-ignore - testing runtime error
            expect(() => setStore("not an object" as any)).toThrow(/invalid updates/);
        });

        it('handles encoding failures in setStore (branch coverage)', () => {
            const { result } = renderHook(() => useStore(TestSchema), { wrapper });
            const [, setStore] = result.current;

            // @ts-ignore - trigger BigInt conversion error
            expect(() => setStore({ big: { cannot: 'convert' } as any })).toThrow(/Failed to encode field "big"/);
        });

        it('uses client.transaction if available (branch coverage)', () => {
            const mockClient = new NMeshedClient(config);
            const spy = vi.spyOn(mockClient, 'transaction');

            const customWrapper = ({ children }: { children: React.ReactNode }) => (
                <NMeshedProvider client={mockClient}>
                    {children}
                </NMeshedProvider>
            );

            const { result } = renderHook(() => useStore(TestSchema), { wrapper: customWrapper });
            const [, setStore] = result.current;

            act(() => {
                setStore({ count: 10 });
            });

            expect(spy).toHaveBeenCalled();
        });

        it('supports client.isPending for metadata (branch coverage)', async () => {
            const mockClient = new NMeshedClient(config);
            (mockClient as any).isPending = vi.fn().mockImplementation((key) => key === 'count');

            const customWrapper = ({ children }: { children: React.ReactNode }) => (
                <NMeshedProvider client={mockClient}>
                    {children}
                </NMeshedProvider>
            );

            const { result } = renderHook(() => useStore(TestSchema), { wrapper: customWrapper });

            expect(result.current[2].pending.has('count')).toBe(true);
            expect(result.current[2].pending.has('title')).toBe(false);
        });
    });

    describe('usePresence Branch Coverage', () => {
        it('handles ping errors gracefully (branch coverage)', async () => {
            const mockClient = new NMeshedClient(config);
            (mockClient as any)._status = 'READY';
            // @ts-ignore - add ping method to trigger branch
            mockClient.ping = vi.fn().mockRejectedValue(new Error('Ping failed'));

            // Setup some users
            const users = [{ userId: 'peer-1', status: 'online' }];
            vi.spyOn(mockClient, 'getPresence').mockResolvedValue(users as any);

            const customWrapper = ({ children }: { children: React.ReactNode }) => (
                <NMeshedProvider client={mockClient}>
                    {children}
                </NMeshedProvider>
            );

            const { result } = renderHook(() => usePresence(), { wrapper: customWrapper });

            // Wait for initial users to load
            await vi.waitFor(() => expect(result.current.length).toBe(1));

            // Advance time to trigger ping
            await act(async () => {
                await vi.advanceTimersByTimeAsync(5000);
            });

            expect(mockClient.ping).toHaveBeenCalledWith('peer-1');
        });

        it('handles initial fetch failure (branch coverage)', async () => {
            const mockClient = new NMeshedClient(config);
            (mockClient as any)._status = 'READY';
            vi.spyOn(mockClient, 'getPresence').mockRejectedValue(new Error('Fetch failed'));
            const spy = vi.spyOn(console, 'warn').mockImplementation(() => { });

            const customWrapper = ({ children }: { children: React.ReactNode }) => (
                <NMeshedProvider client={mockClient}>
                    {children}
                </NMeshedProvider>
            );

            renderHook(() => usePresence(), { wrapper: customWrapper });

            await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch initial presence'), expect.any(Error)));
            spy.mockRestore();
        });
    });
});
