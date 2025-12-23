/**
 * Game module exports.
 * 
 * Provides high-level client for game-like use cases with WASM integration.
 */

export { GameClient } from './GameClient';
export type { GameClientConfig } from './GameClient';

// Re-export SyncedMap for convenience
export { createSyncedMap, SyncedMap } from '../sync/SyncedMap';
export type { SyncedMapConfig } from '../sync/SyncedMap';
