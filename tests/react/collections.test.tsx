/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSyncedMap, useSyncedList } from '../../src/react/collections';
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
            'items:1': { id: 1 },
            'items:2': { id: 2 },
            'other:3': { id: 3 },
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
            if (opHandler) opHandler('items:abc', { val: 1 });
        });

        expect(result.current[0]).toEqual({
            'abc': { val: 1 },
        });

        // Simulate ignored op
        act(() => {
            if (opHandler) opHandler('other:xyz', { val: 2 });
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
        expect(mockClient.set).toHaveBeenCalledWith('items:local', { val: 999 });
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
            if (opHandler) opHandler('items:del', { val: 1 });
        });
        expect(result.current[0]).toEqual({ 'del': { val: 1 } });

        // Verify delete op (value null)
        act(() => {
            if (opHandler) opHandler('items:del', null);
        });
        expect(result.current[0]).toEqual({});

        // Verify removeItem
        act(() => {
            result.current[2]('local-del');
        });
        expect(mockClient.delete).toHaveBeenCalledWith('items:local-del');
    });

    it('useSyncedList should manage list operations', () => {
        // Mock get/set for list index
        mockClient.getAllValues.mockReturnValue({
            'list:0': 'a',
            'list:1': 'b',
        });

        const { result } = renderHook(() => useSyncedList<string>('list'), { wrapper });

        // Expect array
        expect(result.current[0]).toEqual(['a', 'b']);

        // Push
        act(() => {
            result.current[1]('c'); // push
        });

        // Expect set to be called with correct key (auto-increment suffix or random)
        expect(mockClient.set).toHaveBeenCalledWith(expect.stringMatching(/^list:/), 'c');
    });
});
