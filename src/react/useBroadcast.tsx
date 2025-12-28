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
                let data = payload;
                if (payload instanceof Uint8Array || payload instanceof ArrayBuffer) {
                    try {
                        const str = new TextDecoder().decode(payload);
                        data = JSON.parse(str);
                    } catch (e) {
                        // ignore
                    }
                }
                handlerRef.current(data);
            }
        });

        return () => {
            unsubscribe();
        };
    }, [client]);

    const broadcast = useCallback((payload: unknown) => {
        let data: Uint8Array;
        if (payload instanceof Uint8Array) {
            data = payload;
        } else {
            data = new TextEncoder().encode(JSON.stringify(payload));
        }
        client.sendMessage(data);
    }, [client]);

    return broadcast;
}
