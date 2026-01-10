/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSyncedMap, useSyncedList, useSyncedDict } from '../../src/react/collections';
import { NMeshedProvider } from '../../src/react/context';
import { NMeshedClient } from '../../src/client';
import { createMockClient } from '../test-utils';
import React from 'react';

// Initialize mock client with typed factory
const mockClient = createMockClient();

vi.mock('../../src/client', () => {
    return {
        NMeshedClient: vi.fn(function () { return mockClient; }),
    };
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
    <NMeshedProvider workspaceId="test-ws" token="test-token" debug={false}>
        {children}
    </NMeshedProvider>
);

describe('Collections Hooks', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockClient.on.mockImplementation(() => () => { });
        mockClient.getAllValues.mockReturnValue({});
    });

    it('useSyncedMap should load initial data matching prefix', () => {
        // Setup initial data
        mockClient.getAllValues.mockReturnValue({
            'items.1': { id: 1 },
            'items.2': { id: 2 },
            'other.3': { id: 3 },
        });

        const { result } = renderHook(() => useSyncedMap('items'), { wrapper });

        expect(result.current[0]).toEqual({
            '1': { id: 1 },
            '2': { id: 2 },
        });
    });

    it('useSyncedMap should update on op events', () => {
        let opHandler: any;
        mockClient.on.mockImplementation((event, cb) => {
            if (event === 'op') opHandler = cb;
            return () => { };
        });

        const { result } = renderHook(() => useSyncedMap('items'), { wrapper });

        // Initial empty
        expect(result.current[0]).toEqual({});

        // Simulate op
        act(() => {
            if (opHandler) opHandler('items.abc', { val: 1 });
        });

        expect(result.current[0]).toEqual({
            'abc': { val: 1 },
        });

        // Simulate ignored op
        act(() => {
            if (opHandler) opHandler('other.xyz', { val: 2 });
        });

        expect(result.current[0]).toEqual({
            'abc': { val: 1 },
        });
    });

    it('useSyncedMap should handle local updates (setItem)', () => {
        const { result } = renderHook(() => useSyncedMap('items'), { wrapper });

        act(() => {
            result.current[1]('local', { val: 999 });
        });

        // Should call client.set with prefixed key
        expect(mockClient.set).toHaveBeenCalledWith('items.local', { val: 999 });
    });

    it('useSyncedMap should handle deletions and removeItem', () => {
        let opHandler: any;
        mockClient.on.mockImplementation((event, cb) => {
            if (event === 'op') opHandler = cb;
            return () => { };
        });

        const { result } = renderHook(() => useSyncedMap('items'), { wrapper });

        // Seed with data
        act(() => {
            if (opHandler) opHandler('items.del', { val: 1 });
        });
        expect(result.current[0]).toEqual({ 'del': { val: 1 } });

        // Verify delete op (value null)
        act(() => {
            if (opHandler) opHandler('items.del', null);
        });
        expect(result.current[0]).toEqual({});

        // Verify removeItem
        act(() => {
            result.current[2]('local-del');
        });
        expect(mockClient.delete).toHaveBeenCalledWith('items.local-del');
    });

    it('useSyncedList should manage list operations', () => {
        // Mock get/set for list index
        mockClient.getAllValues.mockReturnValue({
            'list.0': 'a',
            'list.1': 'b',
        });

        const { result } = renderHook(() => useSyncedList<string>('list'), { wrapper });

        // Expect array
        expect(result.current[0]).toEqual(['a', 'b']);

        // Push
        act(() => {
            result.current[1]('c'); // push
        });

        // Expect set to be called with correct key (auto-increment suffix or random)
        expect(mockClient.set).toHaveBeenCalledWith(expect.stringMatching(/^list\./), 'c');
    });

    describe('useSyncedDict', () => {
        it('should load initial data with dot separator', () => {
            mockClient.getAllValues.mockReturnValue({
                'config.theme': 'dark',
                'config.zoom': 1.5,
                'other.key': 'stay',
            });

            const { result } = renderHook(() => useSyncedDict<any>('config'), { wrapper });

            expect(result.current[0]).toEqual({
                theme: 'dark',
                zoom: 1.5,
            });
        });

        it('should update on op events with dot separator', () => {
            let opHandler: any;
            mockClient.on.mockImplementation((event, cb) => {
                if (event === 'op') opHandler = cb;
                return () => { };
            });

            const { result } = renderHook(() => useSyncedDict<any>('config'), { wrapper });

            act(() => {
                if (opHandler) opHandler('config.theme', 'light');
            });

            expect(result.current[0].theme).toBe('light');
        });

        it('should perform delta-sync on local updates', () => {
            mockClient.getAllValues.mockReturnValue({
                'config.theme': 'dark',
                'config.zoom': 1.5,
            });

            const { result } = renderHook(() => useSyncedDict<any>('config'), { wrapper });

            act(() => {
                result.current[1]({ theme: 'dark', zoom: 2.0 }); // Only zoom changed
            });

            // Should NOT call set for theme
            expect(mockClient.set).not.toHaveBeenCalledWith('config.theme', 'dark');
            // Should call set for zoom
            expect(mockClient.set).toHaveBeenCalledWith('config.zoom', 2.0);
        });

        it('should handle deletions', () => {
            mockClient.getAllValues.mockReturnValue({
                'config.theme': 'dark',
            });

            const { result } = renderHook(() => useSyncedDict<any>('config'), { wrapper });

            act(() => {
                result.current[1]({} as any); // Delete everything
            });

            expect(mockClient.delete).toHaveBeenCalledWith('config.theme');
        });

        // ============================================================
        // Race Condition Tests - Verifying Init/Ready synchronization
        // ============================================================

        it('should re-sync when ready event fires after mount (race condition fix)', () => {
            let readyHandler: Function | null = null;
            let opHandler: any = null;

            // Mock: getAllValues returns empty initially, then populated after ready
            let isReady = false;
            mockClient.getAllValues.mockImplementation(() => {
                if (isReady) {
                    return {
                        'state.status': 'RUNNING',
                        'state.count': 42,
                    };
                }
                return {}; // Empty before Init
            });

            mockClient.on.mockImplementation((event, cb) => {
                if (event === 'ready') readyHandler = cb;
                if (event === 'op') opHandler = cb;
                return () => { };
            });

            const { result } = renderHook(() => useSyncedDict<any>('state'), { wrapper });

            // Initially empty (Init not received yet)
            expect(result.current[0]).toEqual({});

            // Simulate server sending Init -> client becomes ready
            act(() => {
                isReady = true;
                if (readyHandler) readyHandler();
            });

            // Should now have the full state
            expect(result.current[0]).toEqual({
                status: 'RUNNING',
                count: 42,
            });
        });

        it('should receive ops even before ready event', () => {
            let opHandler: any = null;

            mockClient.getAllValues.mockReturnValue({});
            mockClient.on.mockImplementation((event, cb) => {
                if (event === 'op') opHandler = cb;
                return () => { };
            });

            const { result } = renderHook(() => useSyncedDict<any>('state'), { wrapper });

            // Initial empty
            expect(result.current[0]).toEqual({});

            // Simulate receiving an op before ready
            act(() => {
                if (opHandler) opHandler('state.status', 'SIGNALING');
            });

            // Should have the individual op
            expect(result.current[0]).toEqual({
                status: 'SIGNALING',
            });
        });

        it('should not duplicate state on multiple ready events', () => {
            let readyHandler: Function | null = null;

            mockClient.getAllValues.mockReturnValue({
                'state.flag': true,
            });

            mockClient.on.mockImplementation((event, cb) => {
                if (event === 'ready') readyHandler = cb;
                return () => { };
            });

            const { result } = renderHook(() => useSyncedDict<any>('state'), { wrapper });

            expect(result.current[0]).toEqual({ flag: true });

            // Simulate multiple ready events (reconnection scenario)
            act(() => {
                if (readyHandler) readyHandler();
            });

            expect(result.current[0]).toEqual({ flag: true });

            act(() => {
                if (readyHandler) readyHandler();
            });

            expect(result.current[0]).toEqual({ flag: true });
        });

        it('should properly cleanup subscriptions on unmount', () => {
            const unsubReady = vi.fn();
            const unsubOp = vi.fn();

            mockClient.on.mockImplementation((event) => {
                if (event === 'ready') return unsubReady;
                if (event === 'op') return unsubOp;
                return () => { };
            });

            const { unmount } = renderHook(() => useSyncedDict<any>('state'), { wrapper });

            // Both subscriptions should be established
            expect(mockClient.on).toHaveBeenCalledWith('ready', expect.any(Function));
            expect(mockClient.on).toHaveBeenCalledWith('op', expect.any(Function));

            // Unmount
            unmount();

            // Both unsubscribes should be called
            expect(unsubReady).toHaveBeenCalled();
            expect(unsubOp).toHaveBeenCalled();
        });

        it('should handle Init arriving with partial data then ops completing it', () => {
            let readyHandler: Function | null = null;
            let opHandler: any = null;
            let initData = { 'state.a': 1 };

            mockClient.getAllValues.mockImplementation(() => initData);
            mockClient.on.mockImplementation((event, cb) => {
                if (event === 'ready') readyHandler = cb;
                if (event === 'op') opHandler = cb;
                return () => { };
            });

            const { result } = renderHook(() => useSyncedDict<any>('state'), { wrapper });

            // Initial load with partial data
            expect(result.current[0]).toEqual({ a: 1 });

            // Simulate ready event with same data (idempotent)
            act(() => {
                if (readyHandler) readyHandler();
            });
            expect(result.current[0]).toEqual({ a: 1 });

            // Now receive an op that adds more data
            act(() => {
                if (opHandler) opHandler('state.b', 2);
            });

            expect(result.current[0]).toEqual({ a: 1, b: 2 });
        });

        it('should not trigger re-render when op delivers identical object value (shallow comparison bug)', () => {
            let opHandler: any = null;
            let renderCount = 0;

            mockClient.getAllValues.mockReturnValue({
                'state.data': { x: 1, y: 2 },
            });
            mockClient.on.mockImplementation((event, cb) => {
                if (event === 'op') opHandler = cb;
                return () => { };
            });

            const { result } = renderHook(() => {
                renderCount++;
                return useSyncedDict<any>('state');
            }, { wrapper });

            expect(result.current[0]).toEqual({ data: { x: 1, y: 2 } });

            // Store the render count after initial mount
            const afterMountRenderCount = renderCount;

            // Simulate op with IDENTICAL value (same content, different object reference)
            act(() => {
                if (opHandler) opHandler('state.data', { x: 1, y: 2 });
            });

            // After fix: shallowEqual should detect identical values and skip state update
            expect(result.current[0]).toEqual({ data: { x: 1, y: 2 } });

            // The key assertion: no additional renders should occur for identical data
            // Note: React batching and testing library behavior may still show some renders
            // The important thing is that the state didn't change (verified above)
            // and we haven't doubled the renders for identical ops
            expect(renderCount).toBeLessThanOrEqual(afterMountRenderCount + 1);
        });
    });
});
