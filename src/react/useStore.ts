
import { useState, useEffect, useMemo } from 'react';
import { useNmeshedContext } from './context';
import { Schema, SchemaDefinition, SchemaSerializer } from '../schema/SchemaBuilder';
import { NMeshedMessage } from '../types';

/**
 * Hook to strongly type and sync state with a defined schema.
 * 
 * @param schema The schema definition to sync with.
 * @returns A reactive object containing the current state.
 * 
 * @example
 * ```ts
 * const { score, player } = useStore(GameSchema);
 * ```
 */
export function useStore<T extends SchemaDefinition>(schema: Schema<T>): any {
    const client = useNmeshedContext();

    // Helper to read current snapshot from client
    // Note: We only read keys defined in the schema.
    const snapshot = useMemo(() => {
        return () => {
            const result: any = {};
            for (const key of Object.keys(schema.definition)) {
                const fieldDef = schema.definition[key];

                // Get raw bytes (or pre-decoded value if client handles it)
                // Note: client.get() might return Uint8Array if using get(key) without schema,
                // or if we use our new overloaded get(key, schema) it might try to decode the WHOLE schema.
                // WE NEED GRANULAR DECODING here.

                // We access the raw value from client state directly/via get
                const rawVal = client.get(key);

                if (rawVal instanceof Uint8Array) {
                    try {
                        result[key] = SchemaSerializer.decodeValue(fieldDef, rawVal);
                    } catch (e) {
                        // console.warn(`Failed to decode store key ${key}`, e);
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
    const [store, setStore] = useState(snapshot);

    useEffect(() => {
        // Update on mount in case it changed
        setStore(snapshot());

        const handleMessage = (msg: NMeshedMessage) => {
            if (msg.type === 'op') {
                // Optimization: Only update if the key is part of our schema
                if (schema.definition[msg.payload.key]) {
                    setStore(snapshot());
                }
            } else if (msg.type === 'init') {
                setStore(snapshot());
            }
        };

        const unsubscribe = client.onMessage(handleMessage);
        return unsubscribe;
    }, [client, schema, snapshot]);

    return store;
}
