/**
 * nmeshed - Official JavaScript/TypeScript SDK for nMeshed
 * 
 * Real-time sync infrastructure in 5 minutes.
 * 
 * @example
 * ```typescript
 * import { NMeshedClient } from 'nmeshed';
 * 
 * const client = new NMeshedClient({
 *   workspaceId: 'my-workspace',
 *   token: 'your-jwt-token'
 * });
 * 
 * await client.connect();
 * client.set('greeting', 'Hello, world!');
 * ```
 * 
 * @packageDocumentation
 */

export * from './react/useNmeshed';
export * from './react/context';
export * from './react/useStore';
export * from './react/usePresence';
export * from './react/useSyncSession';
export { useNMeshedClient, useOptionalNMeshedClient } from './react/useNMeshedClient';


export { NMeshedClient } from './client';

// Types
export type {
    NMeshedConfig,
    ConnectionStatus,
    MessageHandler,
    StatusHandler,
    Operation,
    InitMessage,
    OperationMessage,
    NMeshedMessage,
} from './types';

// Errors
export {
    NMeshedError,
    ConfigurationError,
    ConnectionError,
    AuthenticationError,
    MessageError,
    QueueOverflowError,
} from './errors';

// Binary Codec (for performance-critical applications)
export { encodeValue, decodeValue, isBinary } from './codec';

// Schema and Serialization
export type { Schema, SchemaDefinition, SchemaField, InferSchema } from './schema/SchemaBuilder';
export { defineSchema, SchemaSerializer, findSchema, registerGlobalSchema } from './schema/SchemaBuilder';
export { SystemSchemas, TickSyncSchema, PresenceSchema } from './schema/SystemSchema';
export { SyncedCollection, Filters } from './sync/SyncedCollection';

// Debug Utilities (development only)
export { debugPacket, hexDump, tryParseAsJson, formatBytes, startTimer } from './debug';

// Auth Adapters (for third-party auth integrations)
export type { AuthProvider } from './auth/AuthProvider';
export { StaticAuthProvider, CallbackAuthProvider } from './auth/AuthProvider';
export { clerkAuth, ClerkAdapter } from './auth/ClerkAdapter';
export { auth0Auth, Auth0Adapter } from './auth/Auth0Adapter';
export { supabaseAuth, SupabaseAdapter } from './auth/SupabaseAdapter';

