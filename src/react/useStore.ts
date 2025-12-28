import { useState, useEffect, useCallback } from 'react';
import { useNmeshedContext } from './context';
import { Schema, SchemaDefinition, InferSchema } from '../schema/SchemaBuilder';
import { NMeshedMessage } from '../types';

/**
 * Return type for useStore hook.
 */
export type UseStoreReturn<T extends SchemaDefinition> = [
    InferSchema<Schema<T>>,
    (updates: Partial<InferSchema<Schema<T>>>) => void,
    { pending: boolean }
];

/**
 * useStore: Strongly-typed Reactive State.
 * 
 * Embodies the Zen of "Action through Inaction." The developer simply 
 * interacts with plain objects; the SDK handles the binary sync, 
 * reconciliation, and authority in the background.
 */
export function useStore<T extends SchemaDefinition>(schema: Schema<T>): UseStoreReturn<T> {
    const client = useNmeshedContext();
    const [state, setState] = useState<InferSchema<Schema<T>>>(() => {
        const result = {} as any;
        for (const key of Object.keys(schema.definition)) {
            result[key] = client.get(key);
        }
        return result;
    });

    const setStore = useCallback((updates: Partial<InferSchema<Schema<T>>>) => {
        for (const [key, value] of Object.entries(updates)) {
            if (!schema.definition[key]) {
                console.warn(`[useStore] Unknown field "${key}" ignored.`);
                continue;
            }
            client.set(key, value, schema as any);
        }
    }, [client, schema]);

    useEffect(() => {
        const sync = () => {
            const next = {} as any;
            for (const key of Object.keys(schema.definition)) {
                const val = client.get(key);
                next[key] = val;
            }

            setState(current => {
                let hasRealChange = false;
                for (const key of Object.keys(schema.definition)) {
                    if (next[key] !== (current as any)[key]) {
                        hasRealChange = true;
                        break;
                    }
                }
                return hasRealChange ? next : current;
            });
        };

        const unsub = client.subscribe((msg: NMeshedMessage) => {
            if (msg.type === 'op' && schema.definition[msg.payload.key]) {
                sync();
            }
        });

        sync();
        return unsub;
    }, [client, schema]);

    return [state, setStore, { pending: false }]; // Pending logic moved to internal reconciler
}
