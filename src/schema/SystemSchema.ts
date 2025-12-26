import { defineSchema } from './SchemaBuilder';

/**
 * System keys are prefixed with "__" and are reserved for platform features.
 * This schema handles binary serialization for these keys to ensure efficiency.
 */

// 1. __global_tick
// Used for server-authoritative tick synchronization
export const TickSyncSchema = defineSchema({
    tick: 'uint64',
    timestamp: 'float64', // Wall-clock time (matches performance.now())
    peerId: 'string'      // For P2P echo cancellation
});


// 3. __presence
// Used for peer presence data (status, position, etc)
export const PresenceSchema = defineSchema({
    userId: 'string',
    status: 'string', // 'online', 'away', etc.
    lastSeen: 'int64',
    data: {
        type: 'map',
        schema: {
            // Arbitrary KV map for user data (e.g. cursor pos)
            // For now, we serialize values as strings to be safe
            // Ideally this would be 'any' but our schema builder is strict.
            // We'll use string for now.
            val: 'string'
        }
    }
});

/**
 * Union schema for all system messages.
 * We select the correct sub-schema based on the key name.
 * Since registerSchema takes a key prefix, we don't have a single "SystemSchema" object,
 * but rather a collection of exports.
 * 
 * However, SyncEngine expects a single Schema object for a prefix.
 * So we need a "Multiplexing Schema" that looks at the data structure?
 * 
 * No, SyncEngine registry matches `key.startsWith(prefix)`.
 * We can register specific full keys!
 * 
 * OR we can make a "SystemSchema" that has a flexible definition.
 * But our binary schema is strict.
 * 
 * Strategy:
 * Register specific system keys: `__global_tick`, `__global_stats`.
 * Broad `__` registration is risky if schemas differ.
 */

export const SystemSchemas = {
    '__global_tick': TickSyncSchema,
    '__presence': PresenceSchema,
} as const;
