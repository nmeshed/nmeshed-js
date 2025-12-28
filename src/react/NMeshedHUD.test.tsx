import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { NMeshedHUD } from './NMeshedHUD';
import { NMeshedProvider } from './context';
import { MockNMeshedClient } from '../test-utils/mocks';

// Mock NMeshedClient globally for React tests
vi.mock('../client', async () => {
    const { MockNMeshedClient } = await vi.importActual<any>('../test-utils/mocks');
    return {
        NMeshedClient: vi.fn().mockImplementation(function (config) {
            return new MockNMeshedClient(config);
        })
    };
});

// Mock presence hook to return some peers
vi.mock('./usePresence', () => ({
    usePresence: () => [
        { userId: 'Alice', color: 'red', latency: 20, status: 'online' },
        { userId: 'Bob', color: 'blue', status: 'idle' }
    ]
}));

describe('NMeshedHUD', () => {
    const config = { workspaceId: 'ws', userId: 'test-user', token: 'tk' };
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
        React.createElement(NMeshedProvider, { config, children });

    it('is hidden by default', () => {
        render(<NMeshedHUD />, { wrapper });
        expect(screen.queryByText(/nMeshed Diagnostics/i)).toBeNull();
    });

    it('toggles visibility on Ctrl+Shift+D', () => {
        render(<NMeshedHUD />, { wrapper });
        fireEvent.keyDown(window, { ctrlKey: true, shiftKey: true, key: 'D' });
        expect(screen.getByText(/nMeshed Diagnostics/i)).toBeDefined();

        fireEvent.keyDown(window, { ctrlKey: true, shiftKey: true, key: 'D' });
        expect(screen.queryByText(/nMeshed Diagnostics/i)).toBeNull();
    });

    it('displays peer information and handles close button', () => {
        render(<NMeshedHUD />, { wrapper });
        fireEvent.keyDown(window, { ctrlKey: true, shiftKey: true, key: 'D' });

        expect(screen.getByText(/Alice/i)).toBeDefined();
        expect(screen.getByText(/20ms/i)).toBeDefined();
        expect(screen.getByText(/Bob/i)).toBeDefined();

        fireEvent.click(screen.getByText('×'));
        expect(screen.queryByText(/nMeshed Diagnostics/i)).toBeNull();
    });
});
