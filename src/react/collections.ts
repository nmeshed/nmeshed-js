import { useState, useEffect, useCallback } from 'react';
import { useNMeshed } from './context';

/**
 * Hook for a collection of values sharing a common prefix.
 * Example: useSyncedMap('cursors') -> manages keys like 'cursors:abc', 'cursors:123'
 * 
 * @param prefix The key prefix (e.g. 'cursors')
 * @returns [map, setItem, removeItem]
 */
export function useSyncedMap<T>(prefix: string): [
    Record<string, T>,
    (key: string, value: T) => void,
    (key: string) => void
] {
    const { client } = useNMeshed();
    const [map, setMap] = useState<Record<string, T>>({});

    useEffect(() => {
        if (!client) return;

        // Initial load: scan all keys matching prefix
        const initial: Record<string, T> = {};
        const all = client.getAllValues();
        const prefixWithSep = `${prefix}:`;

        Object.entries(all).forEach(([k, v]) => {
            if (k.startsWith(prefixWithSep)) {
                const subKey = k.slice(prefixWithSep.length);
                initial[subKey] = v as T;
            }
        });
        setMap(initial);

        // Subscription
        // Note: This still receives all ops, but only triggers React state update if relevant.
        // In the future, we can add prefix-based filters at the Engine level.
        const unsub = client.on('op', (key, value) => {
            if (key.startsWith(prefixWithSep)) {
                const subKey = key.slice(prefixWithSep.length);
                setMap(prev => {
                    if (value === null || value === undefined) {
                        // Delete
                        const next = { ...prev };
                        delete next[subKey];
                        return next;
                    } else {
                        // Update
                        return { ...prev, [subKey]: value as T };
                    }
                });
            }
        });

        return unsub;
    }, [client, prefix]);

    const setItem = useCallback((subKey: string, value: T) => {
        if (client) {
            client.set(`${prefix}:${subKey}`, value);
        }
    }, [client, prefix]);

    const removeItem = useCallback((subKey: string) => {
        if (client) {
            client.delete(`${prefix}:${subKey}`);
        }
    }, [client, prefix]);

    return [map, setItem, removeItem];
}

/**
 * Hook for a list of values.
 * Under the hood, this uses random UUIDs as keys: `prefix:uuid`
 */
export function useSyncedList<T>(prefix: string): [
    T[],
    (item: T) => string, // push returns id
    (id: string) => void // remove by id
] {
    const [map, setItem, removeItem] = useSyncedMap<T>(prefix);

    // Convert map to list (unstable order unless sorted by content)
    // For V2, we return values array.
    const list = Object.values(map);

    const push = useCallback((item: T) => {
        const id = Math.random().toString(36).substring(2, 9);
        setItem(id, item);
        return id;
    }, [setItem]);

    return [list, push, removeItem];
}
