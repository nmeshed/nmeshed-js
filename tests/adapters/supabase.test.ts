/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSupabaseAdapter } from '../../src/adapters/supabase';

describe('useSupabaseAdapter', () => {
    it('should initialize with current session token', async () => {
        const mockSession = { access_token: 'valid-token' };
        const mockClient = {
            auth: {
                getSession: vi.fn().mockResolvedValue({ data: { session: mockSession } }),
                onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
            }
        };

        const { result } = renderHook(() => useSupabaseAdapter(mockClient as any));

        // Initial state undefined
        expect(result.current.token).toBeUndefined();

        // Wait for promise resolution
        await act(async () => {
            await Promise.resolve(); // flush microtasks
        });

        expect(result.current.token).toBe('valid-token');
    });

    it('should update token on auth state change', async () => {
        let authCallback: any;
        const mockUnsubscribe = vi.fn();
        const mockClient = {
            auth: {
                getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
                onAuthStateChange: vi.fn((cb) => {
                    authCallback = cb;
                    return { data: { subscription: { unsubscribe: mockUnsubscribe } } };
                }),
            }
        };

        const { result } = renderHook(() => useSupabaseAdapter(mockClient as any));

        // Simulate login event
        act(() => {
            if (authCallback) {
                authCallback('SIGNED_IN', { access_token: 'new-token' });
            }
        });

        expect(result.current.token).toBe('new-token');
    });
});
