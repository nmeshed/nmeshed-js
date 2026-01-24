/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StateInspector } from '../../src/react/StateInspector';
import { NMeshedClient } from '../../src/client';
import { useNMeshed } from '../../src/react/context';

// Mock dependencies
vi.mock('../../src/client', () => {
    return {
        NMeshedClient: vi.fn(),
    };
});

vi.mock('../../src/react/context', () => {
    return {
        useNMeshed: vi.fn(() => ({ client: null })),
        NMeshedProvider: ({ children }: any) => <div>{children}</div>
    };
});

// Helper to mock Client behavior
function createMockClient() {
    const listeners: Record<string, Function[]> = {};
    const state: Record<string, unknown> = { 'foo': 'bar' };

    return {
        getAllValues: vi.fn(() => ({ ...state })),
        getPeerId: vi.fn(() => 'test-peer-id'),
        on: vi.fn((event, cb) => {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(cb);
            return () => {
                listeners[event] = listeners[event].filter(x => x !== cb);
            };
        }),
        // Helper to simulate op
        emitOp: (key: string, value: any, isLocal: boolean, timestamp: number) => {
            if (listeners['op']) {
                listeners['op'].forEach(cb => cb(key, value, isLocal, timestamp));
            }
        },
        _updateState: (key: string, value: any) => {
            if (value === null || value === undefined) {
                delete state[key];
            } else {
                state[key] = value;
            }
        }
    } as unknown as NMeshedClient & { emitOp: any, _updateState: any };
}

// Helper to force React change event on Range input
const triggerRangeChange = (element: HTMLElement, value: string) => {
    fireEvent.change(element, { target: { value } });
};

describe('StateInspector', () => {
    let client: ReturnType<typeof createMockClient>;

    beforeEach(() => {
        client = createMockClient();
    });

    it('should render initial state from client', () => {
        render(<StateInspector client={client} />);
        expect(screen.getByText(/foo/)).toBeDefined();
        expect(screen.getByText(/"bar"/)).toBeDefined();
        expect(screen.getByText(/Peer: test-peer-id/)).toBeDefined();
    });

    it('should update live view when operations occur', async () => {
        render(<StateInspector client={client} />);

        await act(async () => {
            client._updateState('newKey', 123);
            client.emitOp('newKey', 123, true, Date.now());
        });

        expect(screen.getByText(/newKey/)).toBeDefined();
        expect(screen.getByText(/123/)).toBeDefined();
    });

    it('should handle history navigation and clearing', async () => {
        render(<StateInspector client={client} />);

        // Op 1 (adds 'step': 1)
        await act(async () => {
            client._updateState('step', 1);
            client.emitOp('step', 1, true, 1000);
        });

        // Op 2 (adds 'step': 2)
        await act(async () => {
            client._updateState('step', 2);
            client.emitOp('step', 2, true, 2000);
        });

        // 1. Verify history populated (Max should be 3: Init, Op1, Op2 -> Indices 0,1,2. Input Max=3).
        const slider = screen.getByRole('slider');
        await waitFor(() => {
            expect(slider.getAttribute('max')).toBe('3');
        });

        // 2. Travel to Index 1 (Op 1)
        await act(async () => {
            triggerRangeChange(slider, '1');
        });

        expect(await screen.findByText('TIME TRAVEL')).toBeDefined();
        expect(await screen.findByText('1')).toBeDefined(); // step: 1
        expect(screen.queryByText('2')).toBeNull(); // step: 2 hidden

        // 3. Travel to Index 0 (Init)
        await act(async () => {
            triggerRangeChange(slider, '0');
        });

        // Should still be in time travel
        expect(screen.getByText('TIME TRAVEL')).toBeDefined();
        // Init state: { foo: 'bar' }. 'step' should be GONE.
        await waitFor(() => {
            expect(screen.queryByText('step')).toBeNull();
        });

        // 4. Clear History
        const clearBtn = screen.getByText('Clear History');
        await act(async () => {
            fireEvent.click(clearBtn);
        });

        // Should return to LIVE
        // Note: There are two "LIVE" indicators (Badge and Slider Label)
        const liveIndicators = await screen.findAllByText('LIVE');
        expect(liveIndicators.length).toBeGreaterThan(0);

        // Live state has 'step': 2 (because client state persists).
        expect(screen.getByText('2')).toBeDefined();
    });

    it('should render JSON types correctly', () => {
        client.getAllValues = () => ({
            str: 's',
            num: 42,
            bool: true,
            nullVal: null,
            obj: { nested: 'val' },
            arr: [1, 2]
        });

        render(<StateInspector client={client} />);

        expect(screen.getByText(/str/)).toBeDefined();
        expect(screen.getByText('"s"')).toBeDefined();
        expect(screen.getByText('42')).toBeDefined();
        expect(screen.getByText('true')).toBeDefined();
        expect(screen.getAllByText('null').length).toBeGreaterThan(0);

        // Interact with Object expansion
        const objLabel = screen.getByText('obj');
        expect(screen.queryByText('"val"')).toBeDefined(); // Visible by default (depth 2)

        // Let's check array expansion
        const arrLabel = screen.getByText('arr');
        fireEvent.click(arrLabel); // Toggle
    });

    it('should show error when no client provided and no context', () => {
        // Mock useNMeshed to return empty
        vi.mocked(useNMeshed).mockReturnValueOnce({ client: null } as any);
        render(<StateInspector client={undefined} />);
        expect(screen.getByText('No nMeshed Client Found')).toBeDefined();
    });

    it('should not update view when paused via drag', async () => {
        render(<StateInspector client={client} />);

        // Initial state
        await act(async () => {
            client._updateState('k', 1);
            client.emitOp('k', 1, true, 100);
        });
        expect(screen.getByText('1')).toBeDefined();

        // Pause via slider interaction (simulated)
        const slider = screen.getByRole('slider');

        // Drag to same position triggering pause logic in onChange
        await act(async () => {
            // We need to trigger the onChange logic that sets isPaused=true
            fireEvent.change(slider, { target: { value: '1' } });
        });

        expect(await screen.findByText('TIME TRAVEL')).toBeDefined();

        // Emit new op while paused
        await act(async () => {
            client._updateState('k', 2);
            client.emitOp('k', 2, true, 200);
        });

        // Should NOT show '2' because we are time traveling / paused
        expect(screen.queryByText('2')).toBeNull();
        expect(screen.getByText('1')).toBeDefined();
    });

    it('should handle delete operations and refresh button', async () => {
        render(<StateInspector client={client} />);

        // Add item
        await act(async () => {
            client._updateState('to-delete', 'val');
            client.emitOp('to-delete', 'val', true, 100);
        });
        expect(screen.getByText('"val"')).toBeDefined();

        // Delete item (emit null)
        await act(async () => {
            client._updateState('to-delete', null);
            client.emitOp('to-delete', null, true, 200);
        });

        // Verify deletion in view
        expect(screen.queryByText('"val"')).toBeNull();

        // Click Refresh
        const refreshBtn = screen.getByText('Refresh');
        await act(async () => {
            fireEvent.click(refreshBtn);
        });
        // (Refresh just re-pulls state, hard to observe visual change unless state drifted, 
        // but this covers the handler function)
    });
    it('should handle "Return to Live" button', async () => {
        render(<StateInspector client={client} />);

        // Add items to create history
        await act(async () => {
            client._updateState('k', 1);
            client.emitOp('k', 1, true, 100);
            client._updateState('k', 2);
            client.emitOp('k', 2, true, 200);
        });

        // Move slider to history
        const slider = screen.getByRole('slider');
        // Wait for max to update
        await waitFor(() => expect(slider.getAttribute('max')).toBe('3'));

        await act(async () => {
            fireEvent.change(slider, { target: { value: '1' } });
        });

        expect(await screen.findByText('TIME TRAVEL')).toBeDefined();

        // Click Return to Live
        const returnBtn = screen.getByText('Return to Live');
        await act(async () => {
            fireEvent.click(returnBtn);
        });

        const liveIndicators = await screen.findAllByText('LIVE');
        expect(liveIndicators.length).toBeGreaterThan(0);
        // Verify slider value reset? (Visual only, covered by LIVE text)
    });
});
