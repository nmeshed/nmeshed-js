import { useEffect, useRef, useCallback } from 'react';
import { useNmeshedContext } from './context';

export type BroadcastHandler = (payload: unknown) => void;

/**
 * Hook to consume and send ephemeral broadcast messages.
 * 
 * @param handler - Optional callback for received messages.
 * @returns Function to broadcast messages.
 */
export function useBroadcast(handler?: BroadcastHandler) {
    const client = useNmeshedContext();
    const handlerRef = useRef(handler);

    // Keep handler ref fresh without re-running effect
    useEffect(() => {
        handlerRef.current = handler;
    }, [handler]);

    useEffect(() => {
        if (!handlerRef.current) return;

        const unsubscribe = client.onEphemeral((payload) => {
            if (handlerRef.current) {
                handlerRef.current(payload);
            }
        });

        return () => {
            unsubscribe();
        };
    }, [client]);

    const broadcast = useCallback((payload: unknown) => {
        client.broadcast(payload);
    }, [client]);

    return broadcast;
}
