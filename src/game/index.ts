/**
 * Game module exports.
 * 
 * Re-exports useful utilities for game-like use cases.
 * Note: GameClient has been deprecated. Use NMeshedClient directly.
 */

// Re-export SyncedCollection for convenience
export { SyncedCollection } from '../sync/SyncedCollection';

// Re-export NMeshedClient as the primary client
export { NMeshedClient } from '../client';
export type { NMeshedConfig } from '../types';
