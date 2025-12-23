/**
 * Sync module exports.
 * 
 * Provides reactive state containers for automatic P2P synchronization.
 */

export { SyncedMap, createSyncedMap } from './SyncedMap';
export type { SyncedMapConfig } from './SyncedMap';

// Binary protocol utilities
export { marshalOp, unmarshalOp, packCursor, unpackCursor, isBinaryCursor } from './binary';
