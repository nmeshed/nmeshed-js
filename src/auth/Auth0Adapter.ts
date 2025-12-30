/**
 * Auth0 Auth Adapter
 * 
 * Provides seamless integration with Auth0 authentication.
 * 
 * @example
 * ```tsx
 * import { useAuth0 } from '@auth0/auth0-react';
 * import { auth0Auth } from 'nmeshed/auth';
 * 
 * function App() {
 *   const { getAccessTokenSilently } = useAuth0();
 *   return (
 *     <NMeshedProvider auth={auth0Auth({ getAccessToken: getAccessTokenSilently })} workspaceId="...">
 *       <MyApp />
 *     </NMeshedProvider>
 *   );
 * }
 * ```
 */

import { AuthProvider, CallbackAuthProvider } from './AuthProvider';

export interface Auth0Config {
    /** Auth0's getAccessTokenSilently function */
    getAccessToken: () => Promise<string>;
}

/**
 * Create an AuthProvider from Auth0's useAuth0 hook.
 * 
 * @param config - Auth0 configuration
 * @returns AuthProvider compatible with NMeshedClient
 */
export function auth0Auth(config: Auth0Config): AuthProvider {
    return new CallbackAuthProvider(async () => {
        try {
            return await config.getAccessToken();
        } catch {
            return null;
        }
    });
}

/**
 * Auth0Adapter class for advanced use cases
 */
export class Auth0Adapter implements AuthProvider {
    constructor(private config: Auth0Config) { }

    async getToken(): Promise<string | null> {
        try {
            return await this.config.getAccessToken();
        } catch {
            return null;
        }
    }
}
