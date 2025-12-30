import { useMemo, useSyncExternalStore } from 'react';
import { useNmeshedContext } from './context';
import { Schema, SchemaDefinition, InferSchema } from '../schema/SchemaBuilder';
import { TransportStatus } from '../transport/Transport';
import { SyncedDocument } from '../sync/SyncedDocument';

/**
 * Return type for useStore hook.
 */
export type UseStoreReturn<T extends SchemaDefinition> = [
    InferSchema<Schema<T>>,
    (updates: Partial<InferSchema<Schema<T>>>) => void,
    { pending: boolean; isConnected: boolean; status: TransportStatus }
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

    // Memoize the SyncedDocument instance
    // This creates a stable subscription manager for this schema
    const doc = useMemo(() => {
        // We pass client.engine because SyncedDocument expects SyncEngine events ('op')
        // and direct access to data.
        return new SyncedDocument(client.engine, 'store', schema);
    }, [client, schema]);

    // React 18 Zen: useSyncExternalStore for atomic rendering
    const state = useSyncExternalStore(
        (onStoreChange) => {
            doc.on('change', onStoreChange);
            return () => doc.dispose();
        },
        () => doc.data,
        () => doc.data // Server snapshot (same as client for now)
    );

    const setStore = (updates: Partial<InferSchema<Schema<T>>>) => {
        doc.set(updates);
    };

    // Connection status (could be moved to a separate hook if needed, but keeping for API compat)
    const status = useSyncExternalStore(
        (cb) => client.onStatusChange(cb),
        () => client.getStatus(),
        () => 'DISCONNECTED' as TransportStatus
    );
    const isConnected = status === 'READY' || status === 'CONNECTED';

    return [state, setStore, { pending: false, isConnected, status }];
}
