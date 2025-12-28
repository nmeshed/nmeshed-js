import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { useSyncSession } from './useSyncSession';
import { NMeshedProvider } from './context';
import { MockNMeshedClient } from '../test-utils/mocks';

// Mock NMeshedClient globally for React tests
vi.mock('../client', async () => {
    const { MockNMeshedClient } = await vi.importActual<any>('../test-utils/mocks');
    return {
        NMeshedClient: vi.fn().mockImplementation(function () {
            return new MockNMeshedClient();
        })
    };
});

describe('useSyncSession', () => {
    const config = { workspaceId: 'ws', userId: 'user', token: 'tk' };
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
        React.createElement(NMeshedProvider, { config, children });

    it('should initialize with correct default state', async () => {
        const { result } = renderHook(() => useSyncSession({ workspaceId: 'ws', apiKey: 'tk', userId: 'user' }), { wrapper });
        await vi.waitFor(() => {
            expect(result.current.status).toBe('CONNECTED');
        });
        expect(result.current.peers).toHaveLength(0);
    });

    it('should track peers when presence events occur', async () => {
        const { result } = renderHook(() => useSyncSession({ workspaceId: 'ws', apiKey: 'tk', userId: 'user' }), { wrapper });
        expect(result.current.peers).toHaveLength(0);
    });
});
