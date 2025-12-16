import { useState, useEffect, useCallback } from 'react';
import { useNmeshedContext } from './context';
import type { NMeshedMessage } from '../types';

/**
 * Options for the useDocument hook.
 */
export interface UseDocumentOptions<T> {
    /**
     * The key to sync.
     */
    key: string;

    /**
     * Initial value before server state is received.
     */
    initialValue?: T;
}

/**
 * Return value of the useDocument hook.
 */
export interface UseDocumentReturn<T> {
    /**
     * Current value of the document.
     */
    value: T | undefined;

    /**
     * Update the value.
     */
    setValue: (newValue: T) => void;

    /**
     * Whether the value has been loaded from the server.
     */
    isLoaded: boolean;
}

/**
 * Hook to sync a single key with nMeshed.
 * 
 * Provides a simple useState-like interface for a single synchronized value.
 * Must be used within an nMeshedProvider.
 * 
 * @param options - Configuration options
 * @returns Object with value, setter, and loading state
 * 
 * @example
 * ```tsx
 * function Counter() {
 *   const { value, setValue, isLoaded } = useDocument<number>({
 *     key: 'counter',
 *     initialValue: 0
 *   });
 *   
 *   if (!isLoaded) return <div>Loading...</div>;
 *   
 *   return (
 *     <div>
 *       <p>Count: {value}</p>
 *       <button onClick={() => setValue((value || 0) + 1)}>
 *         Increment
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 * 
 * @example With Complex Objects
 * ```tsx
 * interface Todo {
 *   id: string;
 *   text: string;
 *   done: boolean;
 * }
 * 
 * function TodoItem({ id }: { id: string }) {
 *   const { value, setValue } = useDocument<Todo>({
 *     key: `todo:${id}`
 *   });
 *   
 *   if (!value) return null;
 *   
 *   return (
 *     <div>
 *       <input
 *         type="checkbox"
 *         checked={value.done}
 *         onChange={() => setValue({ ...value, done: !value.done })}
 *       />
 *       <span>{value.text}</span>
 *     </div>
 *   );
 * }
 * ```
 */
export function useDocument<T = unknown>(
    options: UseDocumentOptions<T>
): UseDocumentReturn<T> {
    const { key, initialValue } = options;
    const client = useNmeshedContext();

    const [value, setLocalValue] = useState<T | undefined>(initialValue);
    const [isLoaded, setIsLoaded] = useState(false);

    useEffect(() => {
        // Check if value already exists in client state
        const existing = client.get<T>(key);
        if (existing !== undefined) {
            setLocalValue(existing);
            setIsLoaded(true);
        }

        // Subscribe to updates
        const unsubscribe = client.onMessage((message: NMeshedMessage) => {
            if (message.type === 'init' && key in message.data) {
                setLocalValue(message.data[key] as T);
                setIsLoaded(true);
            } else if (message.type === 'op' && message.payload.key === key) {
                setLocalValue(message.payload.value as T);
                setIsLoaded(true);
            }
        });

        return unsubscribe;
    }, [client, key]);

    const setValue = useCallback((newValue: T) => {
        client.set(key, newValue);
        setLocalValue(newValue); // Optimistic update
    }, [client, key]);

    return {
        value,
        setValue,
        isLoaded,
    };
}
