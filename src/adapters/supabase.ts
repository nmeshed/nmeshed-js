import type { NMeshedConfig } from '../types';

// We define a structural type for the Supabase client to avoid a hard dependency
type SupabaseClient = {
    auth: {
        getSession: () => Promise<{ data: { session: { access_token: string } | null } }>;
        onAuthStateChange: (
            callback: (event: string, session: { access_token: string } | null) => void
        ) => { data: { subscription: { unsubscribe: () => void } } };
    };
};



/**
 * A React Hook adapter is likely the "Magic" way for V2 without breaking changes.
 * 
 * Usage:
 * const auth = useSupabaseAdapter(supabase);
 * return <NMeshedProvider token={auth.token} ... />
 */
import { useState, useEffect } from 'react';

export function useSupabaseAdapter(supabase: SupabaseClient) {
    const [token, setToken] = useState<string | undefined>(undefined);

    useEffect(() => {
        // Initial session
        supabase.auth.getSession().then(({ data }) => {
            if (data.session?.access_token) {
                setToken(data.session.access_token);
            }
        });

        // Subscription
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setToken(session?.access_token);
        });

        return () => subscription.unsubscribe();
    }, [supabase]);

    return { token };
}
