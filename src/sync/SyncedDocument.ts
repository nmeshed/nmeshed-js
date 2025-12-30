import { EventEmitter } from '../utils/EventEmitter';
import { SyncEngine } from '../core/SyncEngine';
import { Schema, InferSchema, SchemaDefinition } from '../schema/SchemaBuilder';

export interface DocumentEvents<T> {
    change: [T];
    [key: string]: any[];
}

/**
 * SyncedDocument: Managed Single Entity.
 * 
 * Provides a unified, reactive view of a single document/entity.
 * Automatically handles schema-aware decoding, optimistic updates,
 * and maintains a stable reference for React's useSyncExternalStore.
 */
export class SyncedDocument<T extends SchemaDefinition> extends EventEmitter<DocumentEvents<InferSchema<Schema<T>>>> {
    private engine: SyncEngine;
    private _key: string;
    private schema: Schema<T>;
    private _data: InferSchema<Schema<T>>;
    private _version = 0;
    private _unsub: (() => void) | null = null;

    constructor(engine: SyncEngine, key: string, schema: Schema<T>) {
        super();
        this.engine = engine;
        this._key = key;
        this.schema = schema;

        // Initialize state
        this._data = this.buildState();

        this.subscribe();
    }

    private subscribe() {
        this._unsub = this.engine.on('op', (opKey, _val, _isOptimistic) => {
            // Check if operation affects this document
            // For a single document, we care if the key matches exactly,
            // OR if the schema has fields that might be stored separately (though nMeshed currently flat-packs mostly).
            // But useStore/SyncedDocument usually maps 1:1 to a key unless using sub-paths.
            // The current useStore implementation scans ALL keys in schema definition.

            // Wait, useStore previously did: 
            // for (const key of Object.keys(schema.definition)) { ... client.get(key) ... }
            // This implies the schema describes a composite object spread across multiple KV pairs?
            // "nMeshed" standard seems to be 1 Document = 1 Key (FlatBuffers table).
            // BUT, the `useStore` implementation suggests it aggregates multiple keys?

            // Let's re-read useStore.ts line 27:
            // for (const key of Object.keys(schema.definition)) { const val = client.get(key); ... }

            // This implies `useStore` is for a "Global Store" or "Settings" object where each field is a separate KV pair.
            // Example: Schema = { "theme": "string", "notifications": "boolean" }
            // Keys in DB: "theme", "notifications".

            // VS `SyncedCollection` which is `prefix:id`.

            // So `SyncedDocument` here is actually a "SyncedStore" or "SyncedComposite".
            // Let's support the aggregate behavior to match `useStore`.

            if (this.schema.definition[opKey]) {
                this.updateField(opKey);
            }
        });
    }

    private buildState(): InferSchema<Schema<T>> {
        const result = {} as any;
        for (const key of Object.keys(this.schema.definition)) {
            const val = this.engine.get(key);
            result[key] = val !== undefined ? val : this.schema.defaultValue(key as any);
        }
        return result;
    }

    private updateField(field: string) {
        const val = this.engine.get(field);
        const nextVal = val !== undefined ? val : this.schema.defaultValue(field as any);

        if ((this._data as any)[field] !== nextVal) {
            // Lazy-copy on write
            this._data = {
                ...this._data,
                [field]: nextVal
            };
            this._version++;
            this.emit('change', this._data);
        }
    }

    public get data(): InferSchema<Schema<T>> {
        return this._data;
    }

    public set(updates: Partial<InferSchema<Schema<T>>>) {
        for (const [key, value] of Object.entries(updates)) {
            if (!this.schema.definition[key]) {
                console.warn(`[SyncedDocument] Unknown field "${key}" ignored.`);
                continue;
            }
            this.engine.set(key, value, this.schema as any);
        }
    }

    public get version(): number {
        return this._version;
    }

    public dispose() {
        if (this._unsub) {
            this._unsub();
            this._unsub = null;
        }
        this.removeAllListeners();
    }
}
