import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSyncSession } from './useSyncSession';
import { NMeshedClient } from '../client';

// Mock NMeshedClient
vi.mock('../client', async () => {
    const { MockNMeshedClient } = await import('../test-utils/mocks');
    return {
        NMeshedClient: MockNMeshedClient
    };
});

describe('useSyncSession', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should initialize with correct default state', () => {
        const { result } = renderHook(() => useSyncSession({
            workspaceId: 'ws-1',
            apiKey: 'key-1',
            userId: 'user-1'
        }));

        expect(result.current.status).toBe('IDLE');
        expect(result.current.isReady).toBe(false);
        expect(result.current.peers).toEqual([]);
        expect(result.current.client).toBeDefined();
    });

    it('should track peers when presence events occur', async () => {
        const { result } = renderHook(() => useSyncSession({
            workspaceId: 'ws-1',
            apiKey: 'key-1',
            userId: 'user-1'
        }));

        const client = result.current.client as any;

        // Setup initial presence mock return
        client.setPresence([{ userId: 'p1', status: 'online' }]);

        await act(async () => {
            // Trigger presence event which causes hook to call getPresence()
            client.emit('presence');
        });

        await waitFor(() => {
            expect(result.current.peers).toHaveLength(1);
            expect(result.current.peers[0].userId).toBe('p1');
        });
    });
});
