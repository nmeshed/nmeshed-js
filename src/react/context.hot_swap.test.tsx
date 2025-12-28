
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { NMeshedProvider, useNmeshedContext } from './context';
import { NMeshedClient } from '../client';
import React, { useState } from 'react';

// Mock NMeshedClient
vi.mock('../client', () => {
    return {
        // Use a regular function so 'new NMeshedClient()' works
        NMeshedClient: vi.fn().mockImplementation(function (config) {
            return {
                config,
                getStatus: () => 'IDLE',
                connect: vi.fn().mockResolvedValue(undefined),
                disconnect: vi.fn(),
                onStatusChange: vi.fn(() => () => { }),
                on: vi.fn(() => () => { }),
            };
        })
    };
});

// Helper component to Expose Config
const ConfigExposer = () => {
    const client = useNmeshedContext();
    // Access internal config to verify correct instance usage
    return <div data-testid="ws-id">{(client as any).config.workspaceId}</div>;
};

// Harness
const Harness = () => {
    const [cfg, setCfg] = useState({ workspaceId: 'ws-A', token: 't1' });
    return (
        <div>
            <button onClick={() => setCfg({ workspaceId: 'ws-B', token: 't2' })}>Switch</button>
            <NMeshedProvider config={cfg}>
                <ConfigExposer />
            </NMeshedProvider>
        </div>
    );
};

describe('NMeshedProvider Hot-Swap', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should switch client when config changes', async () => {
        render(<Harness />);

        // Initial State
        expect(screen.getByTestId('ws-id').textContent).toBe('ws-A');
        expect(NMeshedClient).toHaveBeenCalledTimes(1);

        // Switch
        const btn = screen.getByText('Switch');
        await act(async () => {
            btn.click();
        });

        // Assert New State
        expect(screen.getByTestId('ws-id').textContent).toBe('ws-B');

        // Assert Reconstruction
        expect(NMeshedClient).toHaveBeenCalledTimes(2);

        // Assert Disconnect on old client logic would be complex to capture here 
        // without keeping a reference, but the existence of a new client 
        // implies the effect ran.
    });
});
