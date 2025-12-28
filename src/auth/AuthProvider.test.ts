import { describe, it, expect, vi } from 'vitest';
import { StaticAuthProvider, CallbackAuthProvider } from './AuthProvider';

describe('AuthProvider', () => {
    describe('StaticAuthProvider', () => {
        it('should return the static token', async () => {
            const provider = new StaticAuthProvider('test-token');
            expect(await provider.getToken()).toBe('test-token');
        });

        it('should return empty string if initialized with empty', async () => {
            const provider = new StaticAuthProvider('');
            expect(await provider.getToken()).toBe('');
        });
    });

    describe('CallbackAuthProvider', () => {
        it('should call the callback to get token', async () => {
            const callback = vi.fn().mockReturnValue('dynamic-token');
            const provider = new CallbackAuthProvider(callback);
            expect(await provider.getToken()).toBe('dynamic-token');
            expect(callback).toHaveBeenCalledTimes(1);
        });

        it('should handle async callbacks', async () => {
            const callback = vi.fn().mockResolvedValue('async-token');
            const provider = new CallbackAuthProvider(callback);
            expect(await provider.getToken()).toBe('async-token');
        });

        it('should return null if callback returns null', async () => {
            const callback = vi.fn().mockReturnValue(null);
            const provider = new CallbackAuthProvider(callback);
            expect(await provider.getToken()).toBeNull();
        });
    });
});
