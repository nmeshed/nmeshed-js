// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { useSignalQueue } from '../../src/ai/signals';
import { NMeshedProvider } from '../../src/react/context';
import { NMeshedClient } from '../../src/client';
import { InMemoryAdapter } from '../../src/adapters/InMemoryAdapter';

// Stub WebSocket globally and permanently for this file
class StubWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    onopen: any;
    onclose: any;
    onmessage: any;
    send() { }
    close() { }
    constructor() {
        // Delay onopen to simulate async connection
        setTimeout(() => this.onopen?.(), 10);
    }
}
vi.stubGlobal('WebSocket', StubWebSocket);

describe('useSignalQueue', () => {
    let client: NMeshedClient;

    beforeEach(async () => {
        client = new NMeshedClient({
            workspaceId: 'test-ws',
            token: 'test-token',
            storage: new InMemoryAdapter(),
            initialSnapshot: new Uint8Array([0])
        });
    });

    const wrapper = ({ children }: { children: React.ReactNode }) => (
        <NMeshedProvider client={client}>{children}</NMeshedProvider>
    );

    // -------------------------------------------------------------------------
    // 1. Happy Path & Basic Ops
    // -------------------------------------------------------------------------
    it('should add a signal to the queue', async () => {
        const { result } = renderHook(() => useSignalQueue('test-queue'), { wrapper });

        let signalId: string;
        await act(async () => {
            signalId = result.current.add('ORDER_PIZZA', { topping: 'cheese' });
        });

        const signals = result.current.signals;
        expect(Object.keys(signals)).toHaveLength(1);
        expect(signals[signalId!].type).toBe('ORDER_PIZZA');
        expect(signals[signalId!].status).toBe('pending');
    });

    it('should process and complete a signal successfully', async () => {
        const { result, rerender } = renderHook(() => useSignalQueue('test-queue'), { wrapper });

        // Add
        await act(async () => {
            result.current.add('Search', { q: 'foo' });
        });

        // Process
        const handler = vi.fn().mockResolvedValue('Results found');
        await act(async () => {
            await result.current.process('Search', handler);
        });

        rerender(); // Update view
        const signals = Object.values(result.current.signals);
        expect(signals[0].status).toBe('completed');
        expect(signals[0].result).toBe('Results found');
        expect(handler).toHaveBeenCalledTimes(1);
    });

    // -------------------------------------------------------------------------
    // 2. Edge Cases: Empty & No Client
    // -------------------------------------------------------------------------
    it('should do nothing if queue is empty', async () => {
        const { result } = renderHook(() => useSignalQueue('empty-queue'), { wrapper });
        const handler = vi.fn();

        await act(async () => {
            await result.current.process('ANY', handler);
        });

        expect(handler).not.toHaveBeenCalled();
    });

    it('should throw if used outside NMeshedProvider', () => {
        // This is intentional architecture: Hooks require context.
        // Rendering without the provider should throw a descriptive error.
        expect(() => {
            renderHook(() => useSignalQueue('orphan-queue'));
        }).toThrowError('[NMeshed] useNMeshed must be used within NMeshedProvider');
    });

    // -------------------------------------------------------------------------
    // 3. Error Handling
    // -------------------------------------------------------------------------
    it('should mark signal as failed if handler throws', async () => {
        const { result, rerender } = renderHook(() => useSignalQueue('fail-queue'), { wrapper });

        await act(async () => {
            result.current.add('RISKY_TASK', {});
        });

        const handler = vi.fn().mockRejectedValue(new Error('Boom!'));

        await act(async () => {
            await result.current.process('RISKY_TASK', handler);
        });

        rerender();
        const signal = Object.values(result.current.signals)[0];
        expect(signal.status).toBe('failed');
        expect(signal.error).toBe('Boom!');
    });

    // -------------------------------------------------------------------------
    // 4. "Dark Path": CAS Contention (Lost Race)
    // -------------------------------------------------------------------------
    it('should NOT execute handler if CAS fails (Lock lost)', async () => {
        const { result } = renderHook(() => useSignalQueue('race-queue'), { wrapper });

        await act(async () => {
            result.current.add('HOT_TOPIC', {});
        });

        // Mock CAS to return false (simulate another client claimed it 1ms ago)
        vi.spyOn(client, 'cas').mockResolvedValue(false);
        const handler = vi.fn();

        await act(async () => {
            await result.current.process('HOT_TOPIC', handler);
        });

        expect(handler).not.toHaveBeenCalled();

        // Verify it remains pending locally (since we assume other client updates will arrive via sync)
        const signal = Object.values(result.current.signals)[0];
        expect(signal.status).toBe('pending');
    });

    // -------------------------------------------------------------------------
    // 5. Concurrency Gating limits active handlers
    // -------------------------------------------------------------------------
    it('should limit concurrent execution', async () => {
        const { result } = renderHook(() => useSignalQueue('burst-queue'), { wrapper });

        // Add 5 tasks
        await act(async () => {
            for (let i = 0; i < 5; i++) result.current.add('BURST', { i });
        });

        // Handler that waits for manual trigger
        let resolveTask: (() => void) | null = null;
        const taskBarrier = new Promise<void>(r => { resolveTask = r; });

        const handler = vi.fn().mockImplementation(async () => {
            await taskBarrier;
            return 'done';
        });

        // Process with concurrency = 2
        const processPromise = act(async () => {
            await result.current.process('BURST', handler, 2);
        });

        // Checking internal state is hard, but we can check calls.
        // Since `process` awaits `Promise.race`, it won't yield until tasks finish or we await.
        // Wait a tick for the loop to start
        await new Promise(r => setTimeout(r, 10));

        // Expect exactly 2 started
        expect(handler).toHaveBeenCalledTimes(2);

        // Open the gates
        resolveTask!();
        await processPromise; // Wait for all to finish

        expect(handler).toHaveBeenCalledTimes(5);
    });

});
