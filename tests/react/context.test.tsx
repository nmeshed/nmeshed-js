/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { NMeshedProvider, useConnectionStatus, useNMeshed, useSyncedValue, useOnChange } from '../../src/react/context';
import { MockNMeshedClient } from '../mocks/MockNMeshedClient';
import React from 'react';

// Initialize mock client
const mockClient = new MockNMeshedClient();

const wrapper = ({ children }: { children: React.ReactNode }) => (
    <NMeshedProvider
        workspaceId="test-ws"
        token="test-token"
        debug={false}
        client={mockClient as any}
    >
        {children}
    </NMeshedProvider>
);

describe('NMeshed Context', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockClient.on.mockImplementation(() => () => { });
    });

    it('useNMeshed should return client instance', () => {
        const { result } = renderHook(() => useNMeshed(), { wrapper });
        expect(result.current.client).toBe(mockClient);
    });

    it('useConnectionStatus should return current status', () => {
        mockClient.getStatus.mockReturnValue('syncing');

        const { result } = renderHook(() => useConnectionStatus(), { wrapper });

        // Initial state matches getStatus
        expect(result.current).toBe('syncing');
    });

    it('useConnectionStatus should update on status events', () => {
        let statusHandler: any;
        mockClient.on.mockImplementation((event, cb) => {
            if (event === 'status') statusHandler = cb;
            return () => { };
        });

        const { result } = renderHook(() => useConnectionStatus(), { wrapper });

        act(() => {
            if (statusHandler) statusHandler('ready');
        });

        expect(result.current).toBe('ready');
    });

    it('useSyncedValue should sync single value', () => {
        // Initial value
        mockClient.get.mockReturnValue('initial');

        const { result } = renderHook(() => useSyncedValue<string>('test-key', 'default'), { wrapper });

        expect(result.current[0]).toBe('initial');

        // Set value
        act(() => {
            result.current[1]('updated');
        });

        expect(mockClient.set).toHaveBeenCalledWith('test-key', 'updated');
        expect(result.current[0]).toBe('updated');
    });

    it('useSyncedValue should update on op events', () => {
        let opHandler: any;
        mockClient.on.mockImplementation((event, cb) => {
            if (event === 'op') opHandler = cb;
            return () => { };
        });

        const { result } = renderHook(() => useSyncedValue<string>('test-key', 'default'), { wrapper });

        // Simulate op
        act(() => {
            if (opHandler) opHandler('test-key', 'remote-update');
        });

        expect(result.current[0]).toBe('remote-update');

        // Ignore other keys
        act(() => {
            if (opHandler) opHandler('other-key', 'ignore-me');
        });

        expect(result.current[0]).toBe('remote-update');
    });

    it('useOnChange should trigger callback on ops', () => {
        const callback = vi.fn();
        let opHandler: any;
        mockClient.on.mockImplementation((event, cb) => {
            if (event === 'op') opHandler = cb;
            return () => { };
        });

        renderHook(() => useOnChange(callback), { wrapper });

        act(() => {
            if (opHandler) opHandler('any-key', 'val');
        });

        expect(callback).toHaveBeenCalledWith('any-key', 'val');
    });
});
