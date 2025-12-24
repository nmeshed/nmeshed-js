import { useState, useEffect, useCallback } from 'react';
import { useNmeshedContext } from './context';
import { Schema, SchemaDefinition, SchemaSerializer, InferSchema } from '../schema/SchemaBuilder';
import { NMeshedMessage } from '../types';

/**
 * Return type for useStore hook.
 * @template T The schema definition type
 */
export type UseStoreReturn<T extends SchemaDefinition> = [
    /** Current state derived from schema */
    InferSchema<Schema<T>>,
    /** Setter function for updating state */
    (updates: Partial<InferSchema<Schema<T>>>) => void
];

/**
 * Hook to strongly type and sync state with a defined schema.
 * Returns a tuple similar to useState: [state, setStore].
 * 
 * @param schema The schema definition to sync with.
 * @returns A tuple of [state, setStore] where setStore handles encoding automatically.
 * 
 * @example
 * ```tsx
 * const [board, setBoard] = useStore(KanbanSchema);
 * 
 * // Update a single field
 * setBoard({ title: 'New Title' });
 * 
 * // Update multiple fields
 * setBoard({ tasks: [...tasks], columns: [...columns] });
 * ```
 */
export function useStore<T extends SchemaDefinition>(schema: Schema<T>): UseStoreReturn<T> {
    const client = useNmeshedContext();

    // Helper to read current snapshot from client
    const getSnapshot = useCallback((): InferSchema<Schema<T>> => {
        const result = {} as Record<string, unknown>;
        for (const key of Object.keys(schema.definition)) {
            const fieldDef = schema.definition[key];
            const rawVal = client.get(key);

            if (rawVal instanceof Uint8Array) {
                try {
                    result[key] = SchemaSerializer.decodeValue(fieldDef, rawVal);
                } catch (e) {
                    // Test expects undefined on decode failure
                    result[key] = undefined;
                }
            } else {
                result[key] = rawVal;
            }
        }
        return result as InferSchema<Schema<T>>;
    }, [client, schema]);

    // Initialize state
    const [store, setStoreState] = useState<InferSchema<Schema<T>>>(getSnapshot);

    // Setter function that handles encoding and sends operations
    const setStore = useCallback((updates: Partial<InferSchema<Schema<T>>>) => {
        if (!updates || typeof updates !== 'object') {
            throw new Error('[useStore] setStore called with invalid updates');
        }

        for (const key of Object.keys(updates) as Array<keyof T & string>) {
            const fieldDef = schema.definition[key];
            const value = updates[key];

            if (fieldDef === undefined) {
                // Test expects warning and skip, not loud failure for unknown fields
                console.warn(`[useStore] Unknown field: ${String(key)}`);
                continue;
            }

            try {
                // Encode the value using schema
                const encoded = SchemaSerializer.encodeValue(fieldDef, value);

                // Send the operation
                client.sendOperation(key, encoded);
            } catch (e) {
                // Fail loudly as per philosophy
                throw new Error(`[useStore] Failed to encode field "${key}": ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }, [client, schema]);


    useEffect(() => {
        // Sync on mount
        setStoreState(getSnapshot());

        const handleMessage = (msg: NMeshedMessage) => {
            if (msg.type === 'op') {
                // Optimization: Only update if the key is part of our schema
                if (schema.definition[msg.payload.key]) {
                    setStoreState(getSnapshot());
                }
            } else if (msg.type === 'init') {
                setStoreState(getSnapshot());
            }
        };

        return client.onMessage(handleMessage);
    }, [client, schema, getSnapshot]);

    return [store, setStore];
}
