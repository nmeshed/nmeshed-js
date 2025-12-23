
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNmeshedContext } from './context';
import { Schema, SchemaDefinition, SchemaSerializer } from '../schema/SchemaBuilder';
import { NMeshedMessage } from '../types';

/**
 * Return type for useStore hook.
 * @template T The schema definition type
 */
export type UseStoreReturn<T> = [
    /** Current state derived from schema */
    Record<string, any>,
    /** Setter function for updating state */
    (updates: Partial<Record<keyof T, any>>) => void
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
    const snapshot = useMemo(() => {
        return () => {
            const result: any = {};
            for (const key of Object.keys(schema.definition)) {
                const fieldDef = schema.definition[key];
                const rawVal = client.get(key);

                if (rawVal instanceof Uint8Array) {
                    try {
                        result[key] = SchemaSerializer.decodeValue(fieldDef, rawVal);
                    } catch (e) {
                        result[key] = undefined;
                    }
                } else {
                    result[key] = rawVal;
                }
            }
            return result;
        };
    }, [client, schema]);

    // Initialize state
    const [store, setStoreState] = useState(snapshot);

    // Setter function that handles encoding and sends operations
    const setStore = useCallback((updates: Partial<Record<keyof T, any>>) => {
        for (const key of Object.keys(updates) as Array<keyof T>) {
            const fieldDef = schema.definition[key as string];
            const value = updates[key];

            if (fieldDef === undefined) {
                console.warn(`[useStore] Unknown field: ${String(key)}`);
                continue;
            }

            // Encode the value using schema
            const encoded = SchemaSerializer.encodeValue(fieldDef, value);

            // Send the operation
            client.sendOperation(String(key), encoded);
        }
    }, [client, schema]);

    useEffect(() => {
        // Update on mount in case it changed
        setStoreState(snapshot());

        const handleMessage = (msg: NMeshedMessage) => {
            if (msg.type === 'op') {
                // Optimization: Only update if the key is part of our schema
                if (schema.definition[msg.payload.key]) {
                    setStoreState(snapshot());
                }
            } else if (msg.type === 'init') {
                setStoreState(snapshot());
            }
        };

        const unsubscribe = client.onMessage(handleMessage);
        return unsubscribe;
    }, [client, schema, snapshot]);

    return [store, setStore];
}
