/**
 * AuthProvider Interface
 * 
 * Defines the contract for retrieving authentication tokens.
 * This abstraction allows for:
 * 1. Static tokens (backward compatibility)
 * 2. Dynamic tokens (e.g., fetching from Clerk/Auth0)
 * 3. Token rotation (auth provider can refresh token)
 */
export interface AuthProvider {
    /**
     * Retrieve the current valid token.
     * Should return null if not authenticated.
     */
    getToken(): Promise<string | null>;
}

/**
 * StaticAuthProvider
 * 
 * Simple wrapper for a fixed token string.
 */
export class StaticAuthProvider implements AuthProvider {
    constructor(private token: string) { }

    async getToken(): Promise<string | null> {
        return this.token;
    }
}

/**
 * CallbackAuthProvider
 * 
 * Adapter for a function that returns a token (or Promise<string>).
 * Useful for integrating with third-party auth SDKs.
 */
export class CallbackAuthProvider implements AuthProvider {
    constructor(private callback: () => string | Promise<string | null>) { }

    async getToken(): Promise<string | null> {
        return this.callback();
    }
}
