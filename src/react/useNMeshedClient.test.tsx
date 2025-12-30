import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useNMeshedClient, useOptionalNMeshedClient } from './useNMeshedClient';
import { NMeshedProvider } from './context';

const TEST_WORKSPACE_ID = '550e8400-e29b-41d4-a716-446655440000';

// Minimal component to test hooks
function ClientAccessor({ testId = 'client-status' }: { testId?: string }) {
    const client = useNMeshedClient();
    return <div data-testid={testId}>{client.getStatus()}</div>;
}

function OptionalClientAccessor({ testId = 'optional-status' }: { testId?: string }) {
    const client = useOptionalNMeshedClient();
    return <div data-testid={testId}>{client ? client.getStatus() : 'no-client'}</div>;
}

describe('useNMeshedClient', () => {
    it('returns client within NMeshedProvider', () => {
        render(
            <NMeshedProvider workspaceId={TEST_WORKSPACE_ID} autoConnect={false}>
                <ClientAccessor />
            </NMeshedProvider>
        );

        // Client should be accessible and have a status
        const element = screen.getByTestId('client-status');
        expect(element.textContent).toBeDefined();
    });

    it('throws error when used outside NMeshedProvider', () => {
        // Suppress React error boundary noise
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

        expect(() => {
            render(<ClientAccessor />);
        }).toThrow('useNMeshedClient must be used within an NMeshedProvider');

        consoleSpy.mockRestore();
    });

    it('provides access to client methods', () => {
        let capturedClient: any;

        function ClientCapture() {
            capturedClient = useNMeshedClient();
            return null;
        }

        render(
            <NMeshedProvider workspaceId={TEST_WORKSPACE_ID} autoConnect={false}>
                <ClientCapture />
            </NMeshedProvider>
        );

        expect(capturedClient).toBeDefined();
        expect(typeof capturedClient.set).toBe('function');
        expect(typeof capturedClient.get).toBe('function');
        expect(typeof capturedClient.getStatus).toBe('function');
    });
});

describe('useOptionalNMeshedClient', () => {
    it('returns client within NMeshedProvider', () => {
        render(
            <NMeshedProvider workspaceId={TEST_WORKSPACE_ID} autoConnect={false}>
                <OptionalClientAccessor />
            </NMeshedProvider>
        );

        const element = screen.getByTestId('optional-status');
        expect(element.textContent).not.toBe('no-client');
    });

    it('returns null when used outside NMeshedProvider', () => {
        render(<OptionalClientAccessor />);

        const element = screen.getByTestId('optional-status');
        expect(element.textContent).toBe('no-client');
    });
});
