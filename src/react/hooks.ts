import { useState, useEffect, useMemo } from 'react';
import { useNMeshed } from './context';

/**
 * Schema-Driven Store Hook
 * Returns a reactive Proxy that auto-syncs changes.
 */
export function useStore<T extends object>(key: string): T {
    const { client } = useNMeshed();

    if (!client) {
        throw new Error('useStore must be used within NMeshedProvider');
    }

    // Force render to keep proxy fresh
    const [version, setVersion] = useState(0);

    // Subscribe to changes for this key
    useEffect(() => {
        const unsub = client.on('op', (opKey) => {
            if (opKey === key) {
                setVersion(v => v + 1);
            }
        });
        return unsub;
    }, [client, key]);

    // Re-create proxy when version changes to ensure it wraps the latest engine data
    // We use useMemo to ensure stable reference if no changes occur (though version change implies change)
    const store = useMemo(() => {
        return client.store<T>(key);
    }, [client, key, version]);

    return store;
}
