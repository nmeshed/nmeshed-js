import { EventEmitter } from '../utils/EventEmitter';
import { SyncEngine } from '../core/SyncEngine';
import { Schema } from '../schema/SchemaBuilder';

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
export class SyncedCollection<T extends any> extends EventEmitter<CollectionEvents<T>> {
    private items = new Map<string, T>();
    private _cachedArray: (T & { id: string })[] | null = null;
    private _version = 0;
    private engine: SyncEngine;
    private prefix: string;
    private schema?: Schema<any>;

    constructor(engine: SyncEngine, prefix: string, schema?: Schema<any>) {
        super();
        this.engine = engine;
        this.prefix = prefix.endsWith(':') ? prefix : `${prefix}:`;
        this.schema = schema;

        // Register prefix schema if provided
        if (schema) {
            this.engine.registerSchema(this.prefix, schema);
        }

        this.subscribe();
        this.fullSync();
    }

    private subscribe() {
        this.engine.on('op', (key, value) => {
            if (key.startsWith(this.prefix)) {
                this.handleOp(key, value);
            }
        });
    }

    private fullSync() {
        let changed = false;
        // Zen Optimization: Iterate directly without allocating intermediate object
        this.engine.forEach((value, key) => {
            if (key.startsWith(this.prefix)) {
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




