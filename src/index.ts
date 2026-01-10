/**
 * NMeshed v2 - Public Exports
 * 
 * One import. Zero confusion.
 */

// Main client
export { NMeshedClient } from './client';

// Types (for TypeScript users)
export {
    NMeshedConfig,
    ConnectionStatus,
    ClientEvents,
    INMeshedClient,
    Operation,
    EventHandler,
    CRDTCore,
} from './types';

// Engine (for advanced usage)
export { SyncEngine } from './engine';

// Transport (for custom implementations)
export * from "./client";
export * from "./react/collections";
export * from "./ai/react";
export * from "./ai/signals";
export * from "./debug/Inspector";
export * from "./encryption";

// RSC utilities
export * from './rsc';

// Testing utilities (for consumer unit tests)
export { MockNMeshedClient, createMockClient } from './testing';
