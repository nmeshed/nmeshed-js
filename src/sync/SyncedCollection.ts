import { EventEmitter } from '../utils/EventEmitter';
import { SyncEngine } from '../core/SyncEngine';
import { Schema } from '../schema/SchemaBuilder';

// ============================================================================
// Prebuilt Filters: Zen Sugar for Common Patterns
// ============================================================================

/**
 * Excludes system keys (prefixed with `__`).
 * Use: `{ filter: Filters.excludeSystem }`
 */
export const excludeSystem = (key: string) => !key.includes('__');

/**
 * Excludes ephemeral/transient keys (prefixed with `_`).
 * Use: `{ filter: Filters.excludeEphemeral }`
 */
export const excludeEphemeral = (key: string) => !key.startsWith('_');

/**
 * Excludes all internal keys (system and ephemeral).
 * Use: `{ filter: Filters.excludeInternal }`
 */
export const excludeInternal = (key: string) => !key.startsWith('_') && !key.includes('__');

/**
 * Only includes entity-like keys (common prefixes).
 * Use: `{ filter: Filters.onlyEntities }`
 */
export const onlyEntities = (key: string) =>
    /^(entity_|item_|miner_|belt_|i_|\d+$)/.test(key);

/**
 * Namespace object for prebuilt filters.
 * 
 * @example
 * ```typescript
 * import { Filters } from 'nmeshed';
 * const entities = client.collection('', EntitySchema, { filter: Filters.excludeSystem });
 * ```
 */
export const Filters = {
    excludeSystem,
    excludeEphemeral,
    excludeInternal,
    onlyEntities
} as const;

// ============================================================================

export interface CollectionEvents<T> {

    add: [string, T];
    remove: [string];
    update: [string, T];
    change: [Map<string, T>?]; // Optional for Zen performance
    [key: string]: any[];
}


/**
 * SyncedCollection: High-Level Entity Orchestration.
 * 
 * Embodies the Zen of "Absolute Clarity." Instead of manually managing 
 * scattered keys, the Collection provides a unified view of a set of 
 * similar objects (e.g., 'building:*').
 * 
 * It automatically handles schema-aware encoding, optimistic updates, 
 * and reactive events for the whole set.
 */
export interface SyncedCollectionOptions<T> {
    /** Optional filter function to exclude certain keys/values */
    filter?: (key: string, value: T) => boolean;
    /** Optional schema to register for this collection (Zen Overload) */
    schema?: Schema<any>;
}

export class SyncedCollection<T extends any> extends EventEmitter<CollectionEvents<T>> {
    private items = new Map<string, T>();
    private _cachedArray: (T & { id: string })[] | null = null;
    private _version = 0;
    private engine: SyncEngine;
    private prefix: string;
    private schema?: Schema<any>;
    private filter?: (key: string, value: T) => boolean;

    constructor(engine: SyncEngine, prefix: string, schema?: Schema<any>, options?: SyncedCollectionOptions<T>) {
        super();
        this.engine = engine;
        this.prefix = prefix.endsWith(':') ? prefix : (prefix === '' ? '' : `${prefix}:`);

        // Resolve Schema: Explicit Arg -> Options -> Registry
        this.schema = schema || options?.schema;
        this.filter = options?.filter;

        // Register prefix schema if provided
        if (this.schema) {
            this.engine.registerSchema(this.prefix, this.schema);
        } else {
            // Check if schema was already registered globally
            this.schema = this.engine.getSchema(this.prefix);
        }

        this.subscribe();
        this.fullSync();
    }

    private subscribe() {
        this.engine.on('op', (key, value) => {
            if (this.prefix === '' || key.startsWith(this.prefix)) {
                // Apply filter if provided
                if (this.filter && value !== null && value !== undefined) {
                    if (!this.filter(key, value as T)) return;
                }
                this.handleOp(key, value);
            }
        });
    }

    private fullSync() {
        let changed = false;
        // Zen Optimization: Iterate directly without allocating intermediate object
        this.engine.forEach((value, key) => {
            if (this.prefix === '' || key.startsWith(this.prefix)) {
                // Apply filter if provided
                if (this.filter && !this.filter(key, value as T)) return;
                const id = this.idFromKey(key);
                this.items.set(id, value as T);
                changed = true;
            }
        });

        if (changed) {
            this.invalidate();
            this.emit('change');
        }
    }

    private invalidate() {
        this._cachedArray = null;
        this._version++;
    }

    private idFromKey(key: string): string {
        return key.substring(this.prefix.length);
    }

    private idToKey(id: string): string {
        return this.prefix + id;
    }

    private handleOp(key: string, value: unknown) {
        const id = this.idFromKey(key);
        this.invalidate(); // Bone-Deep Zen: Invalidate the pointer immediately

        if (value === null || value === undefined) {
            if (this.items.has(id)) {
                this.items.delete(id);
                this.emit('remove', id);
                this.emit('change');
            }
        } else {
            const isNew = !this.items.has(id);
            this.items.set(id, value as T);
            if (isNew) {
                this.emit('add', id, value as T);
            } else {
                this.emit('update', id, value as T);
            }
            this.emit('change');
        }
    }

    /**
     * Action through Inaction: Rebuild the array ONLY when the UI requests it.
     */
    public get data(): (T & { id: string })[] {
        if (!this._cachedArray) {
            this._cachedArray = Array.from(this.items.entries()).map(([id, value]) => ({
                ...(value as any),
                id
            }));
        }
        return this._cachedArray;
    }

    /**
     * Add or update an item in the collection.
     */
    /**
     * Internal implementation of the 'set' operation with defensive guard.
     */
    public set(id: string, value: T) {
        try {
            const key = this.idToKey(id);
            this.engine.set(key, value, this.schema as any);
        } catch (e) {
            this.emit('error' as any, e);
            throw e;
        }
    }

    /**
     * Alias for set().
     */
    public add(id: string, value: T) {
        this.set(id, value);
    }

    /**
     * Removals with defensive guard.
     */
    public delete(id: string) {
        try {
            const key = this.idToKey(id);
            this.engine.set(key, null);
        } catch (e) {
            this.emit('error' as any, e);
            throw e;
        }
    }


    public get(id: string): T | undefined {
        return this.items.get(id);
    }

    public getAll(): Map<string, T> {
        return new Map(this.items);
    }

    public asArray(): (T & { id: string })[] {
        return this.data;
    }

    public clear() {
        for (const id of this.items.keys()) {
            this.delete(id);
        }
    }

    public get size(): number {
        return this.items.size;
    }

    public get version(): number {
        return this._version;
    }
}




