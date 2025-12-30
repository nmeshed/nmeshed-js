/**
 * Clerk Auth Adapter
 * 
 * Provides seamless integration with Clerk authentication.
 * Transforms Clerk's getToken into nMeshed's AuthProvider interface.
 * 
 * @example
 * ```tsx
 * import { useAuth } from '@clerk/clerk-react';
 * import { clerkAuth } from 'nmeshed/auth';
 * 
 * function App() {
 *   const { getToken } = useAuth();
 *   return (
 *     <NMeshedProvider auth={clerkAuth({ getToken })} workspaceId="...">
 *       <MyApp />
 *     </NMeshedProvider>
 *   );
 * }
 * ```
 */

import { AuthProvider, CallbackAuthProvider } from './AuthProvider';

export interface ClerkAuthConfig {
    /** Clerk's getToken function from useAuth() hook */
    getToken: () => Promise<string | null>;
}

/**
 * Create an AuthProvider from Clerk's useAuth hook.
 * 
 * @param config - Clerk auth configuration
 * @returns AuthProvider compatible with NMeshedClient
 */
export function clerkAuth(config: ClerkAuthConfig): AuthProvider {
    return new CallbackAuthProvider(config.getToken);
}

/**
 * ClerkAdapter class for advanced use cases
 */
export class ClerkAdapter implements AuthProvider {
    constructor(private config: ClerkAuthConfig) { }

    async getToken(): Promise<string | null> {
        return this.config.getToken();
    }
}
