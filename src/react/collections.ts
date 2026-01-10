import { useState, useEffect, useCallback } from 'react';
import { useNMeshed } from './context';

/**
 * Shallow equality check for CRDT values.
 * Handles primitives, null, undefined, and objects with same-depth comparison.
 * This prevents unnecessary re-renders when remote ops contain identical values.
 */
function shallowEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== 'object' || typeof b !== 'object') return a === b;

    // Both are objects - do shallow key/value comparison
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
        if (!(key in (b as Record<string, unknown>))) return false;
        if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
    }
    return true;
}

/**
 * Hook for a collection of values sharing a common prefix.
 * Example: useSyncedMap('cursors') -> manages keys like 'cursors.abc', 'cursors.123'
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
        const prefixWithSep = `${prefix}.`;

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
            client.set(`${prefix}.${subKey}`, value);
        }
    }, [client, prefix]);

    const removeItem = useCallback((subKey: string) => {
        if (client) {
            client.delete(`${prefix}.${subKey}`);
        }
    }, [client, prefix]);

    return [map, setItem, removeItem];
}

/**
 * Hook for a list of values.
 * Under the hood, this uses random UUIDs as keys: `prefix.uuid`
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

/**
 * Hook for a dictionary where each top-level key is synced separately.
 * Ideal for "global state" objects like a Game State or Dashboard Config.
 */
export function useSyncedDict<T extends Record<string, any>>(prefix: string): [
    T,
    (value: T | ((prev: T) => T)) => void
] {
    const { client } = useNMeshed();
    const [data, setData] = useState<T>({} as T);

    useEffect(() => {
        if (!client) {
            console.error('[useSyncedDict] Client not ready - hook called outside NMeshedProvider?');
            return;
        }

        const prefixWithSep = prefix ? `${prefix}.` : '';

        // Function to load current state from engine
        const syncFromEngine = () => {
            const all = client.getAllValues();
            const newData: Record<string, any> = {};
            Object.entries(all).forEach(([k, v]) => {
                if (prefix) {
                    if (k.startsWith(prefixWithSep)) {
                        const subKey = k.slice(prefixWithSep.length);
                        newData[subKey] = v;
                    }
                } else {
                    newData[k] = v;
                }
            });
            setData(newData as T);
        };

        // Initial sync (may be empty if Init not yet received)
        syncFromEngine();

        // Re-sync when client becomes ready (Init snapshot loaded)
        const unsubReady = client.on('ready', () => {
            syncFromEngine();
        });

        // Subscribe to ops for real-time updates
        const unsubOp = client.on('op', (key, value) => {
            if (prefix) {
                if (key.startsWith(prefixWithSep)) {
                    const subKey = key.slice(prefixWithSep.length);
                    setData(prev => {
                        if (shallowEqual(prev[subKey], value)) return prev;
                        return { ...prev, [subKey]: value };
                    });
                }
            } else {
                setData(prev => {
                    if (shallowEqual(prev[key], value)) return prev;
                    return { ...prev, [key]: value };
                });
            }
        });

        return () => {
            unsubReady();
            unsubOp();
        };
    }, [client, prefix]);

    const setDict = useCallback((newValueOrFn: T | ((prev: T) => T)) => {
        if (!client) return;

        setData(prev => {
            const next = typeof newValueOrFn === 'function'
                ? (newValueOrFn as (p: T) => T)(prev)
                : newValueOrFn;

            // Delta sync: Only set keys that changed
            Object.entries(next).forEach(([k, v]) => {
                const fullKey = prefix ? `${prefix}.${k}` : k;
                if (prev[k] !== v) {
                    client.set(fullKey, v);
                }
            });

            // Handle deletions (keys in prev but not in next)
            Object.keys(prev).forEach(k => {
                if (!(k in next)) {
                    const fullKey = prefix ? `${prefix}.${k}` : k;
                    client.delete(fullKey);
                }
            });

            return next;
        });
    }, [client, prefix]);

    return [data, setDict];
}
