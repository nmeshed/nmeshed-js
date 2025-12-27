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
    (updates: Partial<InferSchema<Schema<T>>>) => void,
    /** Metadata about the current store state */
    { pending: Set<keyof T & string> }
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
    const [snapshot, setSnapshot] = useState<InferSchema<Schema<T>>>(() => {
        const result = {} as Record<string, unknown>;
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
        return result as InferSchema<Schema<T>>;
    });

    const [pending, setPending] = useState<Set<keyof T & string>>(new Set());

    // Stability: Memoize setStore to prevent downstream re-renders
    const setStore = useCallback((updates: Partial<InferSchema<Schema<T>>>) => {
        if (!updates || typeof updates !== 'object') {
            throw new Error('[useStore] setStore called with invalid updates');
        }

        const applyUpdates = () => {
            for (const key of Object.keys(updates) as Array<keyof T & string>) {
                const fieldDef = schema.definition[key];
                const value = updates[key];

                if (fieldDef === undefined) {
                    console.warn(`[useStore] Unknown field: ${String(key)}`);
                    continue;
                }

                try {
                    const encoded = SchemaSerializer.encodeValue(fieldDef, value);
                    client.set(key, encoded);
                } catch (e) {
                    throw new Error(`[useStore] Failed to encode field "${key}": ${e instanceof Error ? e.message : String(e)}`);
                }
            }
        };

        if ((client as any).transaction) {
            (client as any).transaction(applyUpdates);
        } else {
            applyUpdates();
        }
    }, [client, schema]);

    useEffect(() => {
        const updateSnapshot = () => {
            const nextSnapshot = {} as Record<string, unknown>;
            let changed = false;

            for (const key of Object.keys(schema.definition)) {
                const fieldDef = schema.definition[key];
                const rawVal = client.get(key);
                let val: any;

                if (rawVal instanceof Uint8Array) {
                    try {
                        val = SchemaSerializer.decodeValue(fieldDef, rawVal);
                    } catch (e) {
                        val = undefined;
                    }
                } else {
                    val = rawVal;
                }

                nextSnapshot[key] = val;

                // Better comparison for objects/arrays to prevent jank
                const prevVal = (snapshot as any)[key];
                if (val !== prevVal) {
                    if (typeof val === 'object' && val !== null && typeof prevVal === 'object' && prevVal !== null) {
                        // Simple check for arrays/objects - if they are different structures, definitely changed
                        // For this SDK, we know they are JSON-compatible
                        if (JSON.stringify(val) !== JSON.stringify(prevVal)) {
                            changed = true;
                        }
                    } else {
                        changed = true;
                    }
                }
            }

            if (changed) {
                setSnapshot(nextSnapshot as InferSchema<Schema<T>>);
            }

            // Sync pending status
            const currentPending = new Set<keyof T & string>();
            for (const key of Object.keys(schema.definition) as Array<keyof T & string>) {
                if ((client as any).isPending && (client as any).isPending(key)) {
                    currentPending.add(key);
                }
            }
            setPending(currentPending);
        };

        const handleMessage = (msg: NMeshedMessage) => {
            if (msg.type === 'op' || msg.type === 'init') {
                updateSnapshot();
            }
        };

        const unsubscribe = client.onMessage(handleMessage);

        // Final sync on mount to catch any missed updates
        updateSnapshot();

        return unsubscribe;
    }, [client, schema]);

    return [snapshot, setStore, { pending }];
}
