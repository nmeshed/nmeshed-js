import { EventEmitter } from '../utils/EventEmitter';
import { SyncEngine } from '../core/SyncEngine';
import { Schema } from '../schema/SchemaBuilder';

export interface CollectionEvents<T> {
    add: [string, T];
    remove: [string];
    update: [string, T];
    change: [Map<string, T>];
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
        const all = this.engine.getAllValues();
        for (const [key, value] of Object.entries(all)) {
            if (key.startsWith(this.prefix)) {
                this.items.set(key, value as T);
            }
        }
        this.emit('change', new Map(this.items));
    }

    private handleOp(key: string, value: unknown) {
        if (value === null || value === undefined) {
            if (this.items.has(key)) {
                this.items.delete(key);
                this.emit('remove', key);
                this.emit('change', new Map(this.items));
            }
        } else {
            const isNew = !this.items.has(key);
            this.items.set(key, value as T);
            if (isNew) {
                this.emit('add', key, value as T);
            } else {
                this.emit('update', key, value as T);
            }
            this.emit('change', new Map(this.items));
        }
    }

    /**
     * Add or update an item in the collection.
     */
    public set(id: string, value: T) {
        const key = this.prefix + id;
        this.engine.set(key, value, this.schema as any);
    }

    /**
     * Remove an item from the collection.
     */
    public delete(id: string) {
        const key = this.prefix + id;
        this.engine.set(key, null);
    }

    public get(id: string): T | undefined {
        return this.items.get(this.prefix + id);
    }

    public getAll(): Map<string, T> {
        return new Map(this.items);
    }

    public asArray(): T[] {
        return Array.from(this.items.values());
    }

    public clear() {
        for (const key of this.items.keys()) {
            const id = key.replace(this.prefix, '');
            this.delete(id);
        }
    }
}
