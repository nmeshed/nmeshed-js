import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSyncSession } from './useSyncSession';
import { MockNMeshedClient } from '../test-utils/mocks';

// Mock NMeshedClient globally
vi.mock('../client', async () => {
    const { MockNMeshedClient } = await vi.importActual<any>('../test-utils/mocks');
    return {
        NMeshedClient: vi.fn().mockImplementation(function (config: any) {
            return new MockNMeshedClient(config);
        })
    };
});

describe('useSyncSession (Standalone)', () => {
    // Crucial Test: Ensure it runs WITHOUT a Provider wrapper
    it('should initialize successfully without an NMeshedProvider', async () => {
        const { result } = renderHook(() => useSyncSession({
            workspaceId: 'standalone-ws',
            apiKey: 'standalone-key'
        }));

        // Should not throw "must be used within Provider"
        expect(result.current.client).toBeDefined();

        // Should eventually connect
        await vi.waitFor(() => {
            expect(result.current.status).toBe('CONNECTED');
        });

        expect(result.current.client.workspaceId).toBe('standalone-ws');
    });
});
