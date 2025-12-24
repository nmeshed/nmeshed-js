/**
 * Game module exports.
 * 
 * Re-exports useful utilities for game-like use cases.
 * Note: GameClient has been deprecated. Use NMeshedClient directly.
 */

// Re-export SyncedMap for convenience
export { createSyncedMap, SyncedMap } from '../sync/SyncedMap';
export type { SyncedMapConfig } from '../sync/SyncedMap';

// Re-export NMeshedClient as the primary client
export { NMeshedClient } from '../client';
export type { NMeshedConfig } from '../types';
