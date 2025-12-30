/**
 * Supabase Auth Adapter
 * 
 * Provides seamless integration with Supabase authentication.
 * 
 * @example
 * ```tsx
 * import { useSession } from '@supabase/auth-helpers-react';
 * import { supabaseAuth } from 'nmeshed/auth';
 * 
 * function App() {
 *   const session = useSession();
 *   return (
 *     <NMeshedProvider auth={supabaseAuth({ session })} workspaceId="...">
 *       <MyApp />
 *     </NMeshedProvider>
 *   );
 * }
 * ```
 */

import { AuthProvider } from './AuthProvider';

export interface SupabaseSession {
    access_token: string;
}

export interface SupabaseAuthConfig {
    /** Supabase session object or getter */
    session: SupabaseSession | null | (() => SupabaseSession | null);
}

/**
 * Create an AuthProvider from Supabase session.
 * 
 * @param config - Supabase auth configuration
 * @returns AuthProvider compatible with NMeshedClient
 */
export function supabaseAuth(config: SupabaseAuthConfig): AuthProvider {
    return new SupabaseAdapter(config);
}

/**
 * SupabaseAdapter class
 */
export class SupabaseAdapter implements AuthProvider {
    constructor(private config: SupabaseAuthConfig) { }

    async getToken(): Promise<string | null> {
        const session = typeof this.config.session === 'function'
            ? this.config.session()
            : this.config.session;
        return session?.access_token ?? null;
    }
}
