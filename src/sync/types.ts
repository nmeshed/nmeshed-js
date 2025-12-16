/**
 * Sync 2.0 Protocol Definition
 * 
 * "The Network is a Delay Line."
 * This file defines the atomic units of change (Deltas) for the Headless Sync Layer.
 * 
 * Goals:
 * 1. Zero Data Loss (CRDT-based)
 * 2. Deterministic Merging (Conflict-Free)
 * 3. Bandwidth Efficiency (Discriminated Unions)
 */

/**
 * Unique identifier for a client/actor in the mesh.
 */
export type ActorId = string;

/**
 * Hybrid Logical Clock (HLC) Timestamp.
 * Format: `timestamp-counter-actorId`
 * Ensures strict casual ordering across distributed systems.
 * Example: "1678888888000-0001-user_abc"
 */
export type HLCTimestamp = string;

/**
 * A generic specific point in the JSON document tree.
 * Uses JSON Pointer syntax (RFC 6901) or array of path segments.
 */
export type Path = (string | number)[];

// --- Operation Primitives ---

/**
 * Base operation interface.
 */
interface BaseOp {
    v: 1;                 // Protocol Version (Safety check)
    opId: HLCTimestamp;   // Unique ID of this operation
    actor: ActorId;       // Who performed it
    path: Path;           // Where it happened
}

/**
 * 1. LWW-Map Set
 * Sets a value in a map. Last-Write-Wins based on HLC.
 */
export interface OpMapSet extends BaseOp {
    type: 'map.set';
    key: string;      // Redundant with path? No, path points to the MAP, key is the property.
    value: unknown;   // The new value (primitive or nested object)
}

/**
 * 2. LWW-Map Delete
 * Removes a value from a map. Treated as a "Tombstone".
 */
export interface OpMapDelete extends BaseOp {
    type: 'map.delete';
    key: string;
}

/**
 * 3. RGA List Insert (Replicated Growable Array)
 * Inserts an item relative to another item (Conceptually Linked List).
 */
export interface OpListInsert extends BaseOp {
    type: 'list.insert';
    value: unknown;

    /**
     * The `opId` of the item we are inserting *after*.
     * - `null` means insert at start of list.
     * - This guarantees stable sorting even with concurrent inserts.
     */
    after: HLCTimestamp | null;
}

/**
 * 4. RGA List Delete
 * Tombstones a specific list item by its creation OpId.
 * Note: We do NOT delete by index, because indices shift.
 */
export interface OpListDelete extends BaseOp {
    type: 'list.delete';

    /**
     * The `opId` of the `list.insert` operation that created the item we are deleting.
     */
    targetOpId: HLCTimestamp;
}

/**
 * 5. Text Edit (Optimization of List)
 * Supports collaborative text editing.
 */
export interface OpTextEdit extends BaseOp {
    type: 'text.edit';
    index: number; // Hint only, real resolution uses RGA refs if we go full complex
    insert?: string;
    delete?: number;
    // For "Stripe-like" simplicity, we might stick to simple OT concepts or strict RGA here.
    // Let's stick to RGA for consistency.
    after: HLCTimestamp | null;
}

/**
 * The Discriminated Union of all possible mutations.
 */
export type SyncOp =
    | OpMapSet
    | OpMapDelete
    | OpListInsert
    | OpListDelete
    | OpTextEdit;

// --- State Types ---

/**
 * Represents the current status of the sync engine.
 */
export type SyncStatus = 'disconnected' | 'syncing' | 'consistent' | 'error';

/**
 * A Batch of operations to be sent or received.
 */
export interface SyncBatch {
    ops: SyncOp[];
    fromVersion?: string; // Vector Clock summary
    toVersion: string;    // New Vector Clock summary
}
