/**
 * NMeshed v2 - Public Exports
 * 
 * One import. Zero confusion.
 */

// Main client
export { NMeshedClient } from './client';

// Types (for TypeScript users)
export type {
    NMeshedConfig,
    ConnectionStatus,
    ClientEvents,
    INMeshedClient,
} from './types';

// Engine (for advanced usage)
export { SyncEngine } from './engine';

// Transport (for custom implementations)
export { WebSocketTransport } from './transport';

// React hooks
export * from './react/index';

// RSC utilities
export * from './rsc';
