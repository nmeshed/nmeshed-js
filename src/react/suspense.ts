/**
 * useSuspenseStore — Suspense-enabled store hook for React 18+
 * 
 * Throws a Promise when data isn't ready, integrating cleanly with 
 * React.Suspense boundaries. No more manual loading state checks.
 * 
 * @example
 * // In your component:
 * const board = useSuspenseStore<BoardState>('board');
 * // board is guaranteed to be loaded - no null checks needed!
 * 
 * // In your parent:
 * <Suspense fallback={<Loading />}>
 *     <KanbanBoard />
 * </Suspense>
 */
import { useStore } from './hooks';
import { useNMeshed } from './context';

// Track pending promises to avoid creating duplicates
const pendingPromises = new Map<string, Promise<void>>();

export function useSuspenseStore<T extends object>(key: string): T {
    const { client } = useNMeshed();
    const store = useStore<T>(key);
    const status = client?.getStatus();

    // If store is empty AND we're not ready yet, suspend
    const isEmpty = !store || Object.keys(store).length === 0;
    const isLoading = status !== 'ready' && status !== 'connected';

    if (isEmpty && isLoading) {
        // Create or reuse a pending promise for this key
        if (!pendingPromises.has(key)) {
            const promise = new Promise<void>((resolve) => {
                // Listen for ready event
                const unsub = client?.on('ready', () => {
                    pendingPromises.delete(key);
                    unsub?.();
                    resolve();
                });

                // Listen for status change to connected
                const unsubStatus = client?.on('status', (newStatus) => {
                    if (newStatus === 'ready' || newStatus === 'connected') {
                        pendingPromises.delete(key);
                        unsubStatus?.();
                        resolve();
                    }
                });

                // Timeout fallback to prevent infinite suspend
                setTimeout(() => {
                    pendingPromises.delete(key);
                    unsub?.();
                    unsubStatus?.();
                    resolve();
                }, 5000);
            });

            pendingPromises.set(key, promise);
        }

        throw pendingPromises.get(key);
    }

    return store;
}
