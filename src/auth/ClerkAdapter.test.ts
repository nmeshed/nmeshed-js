import { describe, it, expect, vi } from 'vitest';
import { clerkAuth, ClerkAdapter } from './ClerkAdapter';

describe('ClerkAdapter', () => {
    describe('clerkAuth factory', () => {
        it('returns an AuthProvider', () => {
            const mockGetToken = vi.fn().mockResolvedValue('test-token');
            const provider = clerkAuth({ getToken: mockGetToken });

            expect(provider).toBeDefined();
            expect(typeof provider.getToken).toBe('function');
        });

        it('calls getToken and returns the token', async () => {
            const mockGetToken = vi.fn().mockResolvedValue('clerk-jwt-token');
            const provider = clerkAuth({ getToken: mockGetToken });

            const token = await provider.getToken();

            expect(mockGetToken).toHaveBeenCalledOnce();
            expect(token).toBe('clerk-jwt-token');
        });

        it('returns null when getToken returns null', async () => {
            const mockGetToken = vi.fn().mockResolvedValue(null);
            const provider = clerkAuth({ getToken: mockGetToken });

            const token = await provider.getToken();

            expect(token).toBeNull();
        });
    });

    describe('ClerkAdapter class', () => {
        it('implements AuthProvider interface', async () => {
            const mockGetToken = vi.fn().mockResolvedValue('class-token');
            const adapter = new ClerkAdapter({ getToken: mockGetToken });

            const token = await adapter.getToken();

            expect(token).toBe('class-token');
            expect(mockGetToken).toHaveBeenCalledOnce();
        });

        it('handles async getToken correctly', async () => {
            let resolveToken: (value: string) => void;
            const tokenPromise = new Promise<string>((resolve) => {
                resolveToken = resolve;
            });
            const mockGetToken = vi.fn().mockReturnValue(tokenPromise);
            const adapter = new ClerkAdapter({ getToken: mockGetToken });

            const tokenResultPromise = adapter.getToken();

            // Token should not be resolved yet
            resolveToken!('delayed-token');
            const token = await tokenResultPromise;

            expect(token).toBe('delayed-token');
        });
    });
});
