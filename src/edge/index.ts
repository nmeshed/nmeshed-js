/**
 * Edge Runtime Utilities
 * 
 * Exports for Cloudflare Workers, Deno Deploy, and other edge runtimes.
 */

export { EdgeSyncEngine } from './EdgeSyncEngine';
export type {
    EdgeSyncConfig,
    DurableObjectState,
    DurableObjectStorage,
    DurableObjectId
} from './EdgeSyncEngine';
