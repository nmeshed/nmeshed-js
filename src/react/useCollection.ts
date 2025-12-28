import { useState, useEffect, useMemo } from 'react';
import { useNmeshedContext } from './context';
import { Schema } from '../schema/SchemaBuilder';

/**
 * useCollection: Managed Entity Sets.
 * 
 * Clinical reactive access to a group of entities.
 * Automatically handles schema registration and reactive updates.
 */
export function useCollection<T extends any>(prefix: string, schema?: Schema<any>) {
    const client = useNmeshedContext();
    const collection = useMemo(() => client.getCollection<T>(prefix, schema), [client, prefix, schema]);
    const [items, setItems] = useState<Map<string, T>>(() => collection.getAll());

    useEffect(() => {
        return collection.on('change', (next) => {
            setItems(next);
        });
    }, [collection]);

    return {
        items,
        asArray: () => Array.from(items.values()),
        set: (id: string, value: T) => collection.set(id, value),
        delete: (id: string) => collection.delete(id),
        get: (id: string) => items.get(prefix.endsWith(':') ? prefix + id : prefix + ':' + id),
        clear: () => collection.clear()
    };
}
