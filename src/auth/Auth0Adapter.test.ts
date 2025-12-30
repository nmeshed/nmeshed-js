import { describe, it, expect, vi } from 'vitest';
import { auth0Auth, Auth0Adapter } from './Auth0Adapter';

describe('Auth0Adapter', () => {
    describe('auth0Auth factory', () => {
        it('returns an AuthProvider', () => {
            const mockGetAccessToken = vi.fn().mockResolvedValue('test-token');
            const provider = auth0Auth({ getAccessToken: mockGetAccessToken });

            expect(provider).toBeDefined();
            expect(typeof provider.getToken).toBe('function');
        });

        it('calls getAccessToken and returns the token', async () => {
            const mockGetAccessToken = vi.fn().mockResolvedValue('auth0-jwt-token');
            const provider = auth0Auth({ getAccessToken: mockGetAccessToken });

            const token = await provider.getToken();

            expect(mockGetAccessToken).toHaveBeenCalledOnce();
            expect(token).toBe('auth0-jwt-token');
        });

        it('returns null when getAccessToken throws', async () => {
            const mockGetAccessToken = vi.fn().mockRejectedValue(new Error('Not authenticated'));
            const provider = auth0Auth({ getAccessToken: mockGetAccessToken });

            const token = await provider.getToken();

            expect(token).toBeNull();
        });
    });

    describe('Auth0Adapter class', () => {
        it('implements AuthProvider interface', async () => {
            const mockGetAccessToken = vi.fn().mockResolvedValue('class-token');
            const adapter = new Auth0Adapter({ getAccessToken: mockGetAccessToken });

            const token = await adapter.getToken();

            expect(token).toBe('class-token');
            expect(mockGetAccessToken).toHaveBeenCalledOnce();
        });

        it('handles errors gracefully and returns null', async () => {
            const mockGetAccessToken = vi.fn().mockRejectedValue(new Error('Token expired'));
            const adapter = new Auth0Adapter({ getAccessToken: mockGetAccessToken });

            const token = await adapter.getToken();

            expect(token).toBeNull();
        });

        it('handles async getAccessToken correctly', async () => {
            let resolveToken: (value: string) => void;
            const tokenPromise = new Promise<string>((resolve) => {
                resolveToken = resolve;
            });
            const mockGetAccessToken = vi.fn().mockReturnValue(tokenPromise);
            const adapter = new Auth0Adapter({ getAccessToken: mockGetAccessToken });

            const tokenResultPromise = adapter.getToken();
            resolveToken!('delayed-auth0-token');
            const token = await tokenResultPromise;

            expect(token).toBe('delayed-auth0-token');
        });
    });
});
