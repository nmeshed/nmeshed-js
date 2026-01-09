import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNMeshed } from './context';
import type { ZodType, ZodTypeDef, SafeParseSuccess, SafeParseError } from 'zod';
import { useSyncedDict } from './collections';

/**
 * Hook with runtime schema validation (Primitives).
 * Safely typed and runtime-checked using Zod.
 * Uses client.get/set (Key-Value Store).
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
        // console.warn(`[NMeshed] Schema validation failed for key "${key}":`, result.error);
        return null;
    }, [schema, key]);

    // Initialize state
    const [state, setState] = useState<{ value: Output; valid: boolean }>(() => {
        const raw = client?.get(key);
        const validated = validate(raw);
        return validated !== null
            ? { value: validated, valid: true }
            : { value: defaultValue, valid: false };
    });

    useEffect(() => {
        if (!client) return;

        const unsub = client.on('op', (opKey, opValue) => {
            if (opKey === key) {
                const valid = validate(opValue);
                if (valid !== null) {
                    setState({ value: valid, valid: true });
                } else {
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
            client.set(key, newValue);
        }
        setState({ value: newValue, valid: true });
    }, [client, key]);

    return [state.value, setValue, state.valid];
}

/**
 * useSyncedStore
 * 
 * High-level hook that synchronizes a dictionary/object and validates it against a Zod schema.
 * Replaces the pattern of manual schema validation in components.
 * Uses useSyncedDict (Document Store).
 * 
 * @param key The nMeshed collection key
 * @param schema Zod schema for the entire object
 * @param defaultValue Optional default value to use if validation fails or data is missing
 */
export function useSyncedStore<T>(
    key: string,
    schema: ZodType<T>,
    defaultValue?: T
) {
    const [raw, setRaw] = useSyncedDict<any>(key);

    const result = useMemo(() => {
        // If raw is undefined/null, we might return default or wait.
        if (raw === undefined || raw === null) {
            return { success: true, data: defaultValue } as SafeParseSuccess<T>;
        }
        return schema.safeParse(raw);
    }, [raw, schema, defaultValue]);

    const setValue = useCallback((newValue: T | ((prev: T) => T)) => {
        setRaw((prev: any) => {
            if (typeof newValue === 'function') {
                // We trust the previous value is valid T (as Proxy)
                return (newValue as (p: T) => T)(prev);
            }
            return newValue;
        });
    }, [setRaw]);

    return {
        data: (result.success ? result.data : defaultValue) as T | undefined,
        error: result.success ? null : (result as SafeParseError<T>).error,
        isLoading: raw === undefined,
        isValid: result.success,
        setValue
    };
}
