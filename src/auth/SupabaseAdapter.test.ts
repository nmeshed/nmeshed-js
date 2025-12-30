import { describe, it, expect, vi } from 'vitest';
import { supabaseAuth, SupabaseAdapter } from './SupabaseAdapter';

describe('SupabaseAdapter', () => {
    describe('supabaseAuth factory', () => {
        it('returns an AuthProvider with static session', async () => {
            const session = { access_token: 'supabase-token' };
            const provider = supabaseAuth({ session });

            expect(provider).toBeDefined();
            const token = await provider.getToken();
            expect(token).toBe('supabase-token');
        });

        it('returns null when session is null', async () => {
            const provider = supabaseAuth({ session: null });

            const token = await provider.getToken();

            expect(token).toBeNull();
        });

        it('supports getter function for session', async () => {
            const sessionGetter = vi.fn().mockReturnValue({ access_token: 'dynamic-token' });
            const provider = supabaseAuth({ session: sessionGetter });

            const token = await provider.getToken();

            expect(sessionGetter).toHaveBeenCalledOnce();
            expect(token).toBe('dynamic-token');
        });

        it('handles getter returning null', async () => {
            const sessionGetter = vi.fn().mockReturnValue(null);
            const provider = supabaseAuth({ session: sessionGetter });

            const token = await provider.getToken();

            expect(token).toBeNull();
        });
    });

    describe('SupabaseAdapter class', () => {
        it('implements AuthProvider interface with static session', async () => {
            const adapter = new SupabaseAdapter({ session: { access_token: 'static-token' } });

            const token = await adapter.getToken();

            expect(token).toBe('static-token');
        });

        it('implements AuthProvider interface with getter', async () => {
            let currentToken = 'initial-token';
            const sessionGetter = () => ({ access_token: currentToken });
            const adapter = new SupabaseAdapter({ session: sessionGetter });

            expect(await adapter.getToken()).toBe('initial-token');

            currentToken = 'refreshed-token';
            expect(await adapter.getToken()).toBe('refreshed-token');
        });

        it('returns null when session has no access_token', async () => {
            const adapter = new SupabaseAdapter({ session: {} as any });

            const token = await adapter.getToken();

            expect(token).toBeNull();
        });
    });
});
