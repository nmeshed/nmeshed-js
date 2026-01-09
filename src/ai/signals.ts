/**
 * @module AI_Signals
 * @description
 * Distributed control flow for AI Agents.
 * 
 * ## The "Signal" Pattern
 * Multi-agent systems need a way for one agent (or user) to request work, and for another to claim it.
 * This module implements a **Distributed Job Queue** using CRDTs and Atomic CAS.
 * 
 * ## Distributed Locking
 * We use `client.cas` (Compare-And-Swap) to ensure that even if 5 agents try to claim a task simultaneously,
 * **exactly one** will succeed.
 */

import { useCallback } from 'react';
import { useSyncedMap } from '../react/collections';
import { useNMeshed } from '../react/context';

export type SignalStatus = 'pending' | 'claimed' | 'completed' | 'failed';

export interface Signal<T = any> {
    id: string;
    type: string;
    payload: T;
    status: SignalStatus;
    createdAt: number;
    claimedBy?: string; // peerId
    claimedAt?: number;
    result?: any;
    error?: string;
}

export interface SignalQueueHook<T> {
    signals: Record<string, Signal<T>>;
    /**
     * Adds a new task to the queue.
     * @returns The generated Signal ID.
     */
    add: (type: string, payload: T) => string;
    /**
     * Starts a worker loop to process tasks of a specific type.
     * @param type - The task type to listen for.
     * @param handler - Async function to execute the task.
     * @param concurrency - Max concurrent tasks (Blast Radius Control).
     */
    process: (type: string, handler: (payload: T) => Promise<any>, concurrency?: number) => Promise<void>;
}

/**
 * A distributed task queue for coordinating AI tool calls.
 * Implements atomic leasing via CAS (Compare-And-Swap) to prevent double-execution.
 * 
 * @param queueId The semantic queue identifier (e.g. "agent-tools").
 * 
 * @example
 * ```tsx
 * const { add, process } = useSignalQueue('image-generation');
 * 
 * // Client Side: Request work
 * <button onClick={() => add('generate', { prompt: 'A cat' })}>Generate</button>
 * 
 * // Agent Side: Process work
 * useEffect(() => {
 *   process('generate', async ({ prompt }) => {
 *     return await callStableDiffusion(prompt);
 *   });
 * }, []);
 * ```
 */
export function useSignalQueue<T = any>(queueId: string): SignalQueueHook<T> {
    // We utilize the synced map for reactivity, but we bypass it for strict locking.
    const [signals, setSignal] = useSyncedMap<Signal<T>>(`signals.${queueId}`);
    const { client } = useNMeshed();
    const peerId = client?.getPeerId() || 'unknown';

    // 1. Add a new signal
    const add = useCallback((type: string, payload: T) => {
        const id = crypto.randomUUID();
        const signal: Signal<T> = {
            id,
            type,
            payload,
            status: 'pending',
            createdAt: Date.now()
        };
        setSignal(id, signal);
        return id;
    }, [setSignal]);

    // 2. Process Queue
    const process = useCallback(async (
        type: string,
        handler: (payload: T) => Promise<any>,
        concurrency = 5 // "Blast Radius" Control: Default to 5 concurrent tasks
    ) => {
        if (!client) return;

        const pending = Object.values(signals).filter(s =>
            s.type === type && s.status === 'pending'
        );

        if (pending.length === 0) return;

        // Simple concurrency semaphore
        const results: Promise<void>[] = [];
        const executing = new Set<Promise<void>>();

        for (const signal of pending) {
            const task = processSingleSignal(client, queueId, peerId, signal, handler, setSignal);

            results.push(task);
            executing.add(task);

            // Clean up when done
            task.finally(() => executing.delete(task));

            // Backpressure: Wait if hitting limit
            if (executing.size >= concurrency) {
                await Promise.race(executing);
            }
        }

        await Promise.all(results);

    }, [signals, client, peerId, queueId, setSignal]);

    return { signals, add, process };
}

/**
 * Isolated Processor Logic
 * - Pure(ish) function handles the lifecycle of a single signal.
 * - Enforces "Zero-Trust I/O": We assume we might lose the lock.
 */
async function processSingleSignal<T>(
    client: any,
    queueId: string,
    peerId: string,
    signal: Signal<T>,
    handler: (payload: T) => Promise<any>,
    setSignal: (id: string, val: Signal<T>) => void
) {
    // 1. Prepare Lease
    const claimedSignal: Signal<T> = {
        ...signal,
        status: 'claimed',
        claimedBy: peerId,
        claimedAt: Date.now()
    };

    // 2. Atomic Acquisition (CAS)
    // We never optimistically update local state here. We trust the engine.
    // If CAS fails, we silently bail.
    const fullKey = `signals.${queueId}.${signal.id}`;
    const success = await client.cas(fullKey, signal, claimedSignal);

    if (!success) return; // Lost the race.

    // 3. Execution
    try {
        const result = await handler(signal.payload);

        // 4. Completion
        // We own the lock. We finalize the state.
        // Optimization: Use `setSignal` (which uses `client.set` internally) to handle prefixing.
        // Ideally we'd use `client.cas` again to ensure we don't overwrite if status changed,
        // but for now, we assume we are the owner.
        setSignal(signal.id, {
            ...claimedSignal,
            status: 'completed',
            result
        });
    } catch (err: any) {
        // 5. Failure Management
        setSignal(signal.id, {
            ...claimedSignal,
            status: 'failed',
            error: err.message || String(err)
        });
    }
}
