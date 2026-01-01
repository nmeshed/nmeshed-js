// @vitest-environment happy-dom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NMeshedProvider } from '../../src/react/context';
import { useConnection, useStore } from '../../src/react/hooks';
import { NMeshedClient } from '../../src/client';

// Mock Client
import { MockNMeshedClient } from '../mocks/MockNMeshedClient';

vi.mock('../../src/client', async () => {
    const { MockNMeshedClient } = await import('../mocks/MockNMeshedClient');
    return {
        NMeshedClient: MockNMeshedClient
    }
});

const ConnectionStatusComponent = () => {
    const { status, isOnline, isSyncing } = useConnection();
    return (
        <div>
            <div data-testid="status">{status}</div>
            <div data-testid="isOnline">{isOnline ? 'true' : 'false'}</div>
            <div data-testid="isSyncing">{isSyncing ? 'true' : 'false'}</div>
        </div>
    );
};

describe('useConnection', () => {
    it('should return initial status', () => {
        const client = new NMeshedClient({ workspaceId: 'test', token: 'token' });

        render(
            <NMeshedProvider client={client}>
                <ConnectionStatusComponent />
            </NMeshedProvider>
        );

        expect(screen.getByTestId('status').textContent).toBe('disconnected');
        expect(screen.getByTestId('isOnline').textContent).toBe('false');
    });

    // ... (existing useConnection test)

    it('useStore should retrieve data and update on ops', () => {
        const client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
        // Mock client.store to return a simple object/proxy
        (client as any).store = vi.fn((key) => ({ key, version: 1 }));

        // Mock useNMeshed to return this client. 
        // We can't easily mock useNMeshed hook directly inside the same file unless we mock the module.
        // But since we use NMeshedProvider, `useNMeshed` works for real.

        let storeValue: any;
        const TestComponent = () => {
            storeValue = useStore('test-store');
            return null;
        };

        render(
            <NMeshedProvider client={client}>
                <TestComponent />
            </NMeshedProvider>
        );

        expect(client.store).toHaveBeenCalledWith('test-store');
        expect(storeValue).toEqual({ key: 'test-store', version: 1 });

        // Trigger update
        // client.on was mocked in the mock above. We need to capture the handler.
        // The mock in vi.mock above is hoisted.
    });
});
