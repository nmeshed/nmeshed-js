import { useMemo, useSyncExternalStore } from 'react';


import { useNmeshedContext } from './context';
import { Schema } from '../schema/SchemaBuilder';
import { NMeshedError } from '../errors';


/**
 * useCollection: Managed Entity Sets.
 * 
 * Clinical reactive access to a group of entities.
 * Automatically handles schema registration and reactive updates.
 */
export type UseCollectionReturn<T> = readonly [
    (T & { id: string })[], // Items (Stillness)
    {
        readonly map: Map<string, T>;
        readonly set: (id: string, value: T) => void;
        readonly add: (id: string, value: T) => void;
        readonly delete: (id: string) => void;
        readonly get: (id: string) => T | undefined;
        readonly clear: () => void;
        readonly size: number;
    } // Actions (Movement)
];

/**
 * useCollection: Managed Entity Sets.
 * 
 * Returns a tuple [items, actions].
 * items: Reactive array for mapping in UI.
 * actions: Methods like .add(), .set(), .delete().
 * 
 * @example
 * ```tsx
 * const [tasks, { add }] = useCollection<Task>('task:');
 * return tasks.map(t => <div key={t.id}>{t.title}</div>);
 * ```
 */
export function useCollection<T extends any>(prefix: string, schema?: Schema<any>): UseCollectionReturn<T> {
    const client = useNmeshedContext();

    // Defensive Programming: Context Guard
    if (!client) {
        throw new NMeshedError(
            'useCollection must be used within an NMeshedProvider. ' +
            'Check your component tree hierarchy.',
            'MISSING_CONTEXT'
        );
    }

    const collection = useMemo(() => client.collection<T>(prefix, schema), [client, prefix, schema]);

    // React 18 Zen: useSyncExternalStore for atomic rendering
    const items = useSyncExternalStore(
        (onStoreChange) => {
            collection.on('change', onStoreChange);
            return () => collection.off('change', onStoreChange);
        },
        () => collection.data,
        () => []
    );

    // Actions (Movement): Grouped reactive and stable pointers
    const actions = useMemo(() => ({
        map: collection.getAll(),
        set: (id: string, value: T) => collection.set(id, value),
        add: (id: string, value: T) => collection.add(id, value),
        delete: (id: string) => collection.delete(id),
        get: (id: string) => collection.get(id),
        clear: () => collection.clear(),
        size: collection.size,
    }), [collection, items]); // Re-compute metadata when items (store version) changes

    return [items, actions] as const;
}







