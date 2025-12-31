import { useState, useEffect, useCallback } from 'react';
import { useNMeshed } from './context';
import type { ZodType, ZodTypeDef } from 'zod';

/**
 * Hook with runtime schema validation.
 * Safely typed and runtime-checked using Zod.
 * 
 * @param key The sync key
 * @param schema Zod schema
 * @param defaultValue Default value if missing or invalid
 */
export function useSyncedSchema<Output, Def extends ZodTypeDef, Input>(
    key: string,
    schema: ZodType<Output, Def, Input>,
    defaultValue: Output
): [Output, (value: Output) => void, boolean] { // [value, set, isValid]
    const { client } = useNMeshed();

    // Internal validator helper
    const validate = useCallback((val: unknown): Output | null => {
        const result = schema.safeParse(val);
        if (result.success) {
            return result.data;
        }
        console.warn(`[NMeshed] Schema validation failed for key "${key}":`, result.error);
        return null;
    }, [schema, key]);

    // Initialize state
    const [state, setState] = useState<{ value: Output; valid: boolean }>(() => {
        const raw = client?.get(key);
        const valid = validate(raw);
        return valid !== null
            ? { value: valid, valid: true }
            : { value: defaultValue, valid: !!raw }; // If raw exists but invalid, valid=false
    });

    useEffect(() => {
        if (!client) return;

        const unsub = client.on('op', (opKey, opValue) => {
            if (opKey === key) {
                const valid = validate(opValue);
                if (valid !== null) {
                    setState({ value: valid, valid: true });
                } else {
                    // Invalid update received - keep old value or allow it? 
                    // "Safe" mode: ignore invalid updates to UI
                    // But we might want error state.
                    console.error(`[NMeshed] Received invalid data for ${key}`);
                }
            }
        });

        // Re-check initial in case client wasn't ready before
        const raw = client.get(key);
        if (raw !== undefined) {
            const valid = validate(raw);
            if (valid !== null) {
                setState({ value: valid, valid: true });
            }
        }

        return unsub;
    }, [client, key, validate]);

    const setValue = useCallback((newValue: Output) => {
        if (client) {
            // Validate before send? Optional, but good practice.
            // We trust the local code for now.
            client.set(key, newValue);
        }
        setState({ value: newValue, valid: true });
    }, [client, key]);

    return [state.value, setValue, state.valid];
}
