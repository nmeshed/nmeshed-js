import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { NMeshedClient } from './client';
import {
    MockWebSocket,
    defaultMockServer,
    setupTestMocks,
} from './test-utils/mocks';
import { packInit } from './test-utils/wire-utils';

// 1. Define Mock State using vi.hoisted to bypass hoisting issues
const shared = vi.hoisted(() => ({
    mockDbQueue: [] as any[]
}));

// 2. Mock persistence using the shared state
vi.mock('./persistence', () => ({
    loadQueue: vi.fn().mockImplementation(async (key) => {
        // Return deep copy
        const q = shared.mockDbQueue;
        if (q instanceof Uint8Array) {
            return new Uint8Array(q);
        }
        return Array.isArray(q) ? [...q] : q;
    }),
    saveQueue: vi.fn().mockImplementation(async (key, queue) => {
        // Correct signature: (key, queue)
        // queue is the second argument!
        if (queue instanceof Uint8Array) {
            shared.mockDbQueue = new Uint8Array(queue) as any;
        } else if (Array.isArray(queue)) {
            shared.mockDbQueue = [...queue];
        } else {
            shared.mockDbQueue = queue;
        }
        return Promise.resolve();
    }),
}));

import { loadQueue, saveQueue } from './persistence';

describe('NMeshedClient Broadcast Regression', () => {
    const originalWebSocket = (globalThis as any).WebSocket;

    class TestMockWebSocket extends MockWebSocket {
        constructor(url: string) {
            super(url, defaultMockServer);
        }
    }

    beforeAll(() => {
        // No-op
    });

    afterAll(() => {
        vi.stubGlobal('WebSocket', originalWebSocket);
        (globalThis as any).WebSocket = originalWebSocket;
    });

    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', TestMockWebSocket);
        (globalThis as any).WebSocket = TestMockWebSocket;

        setupTestMocks();

        vi.spyOn(MockWebSocket.prototype, 'send');
        vi.clearAllMocks();

        // RESET DB STATE
        shared.mockDbQueue = [];
        (loadQueue as any).mockClear();
        (saveQueue as any).mockClear();
    });

    afterEach(() => {
        defaultMockServer.reset();
        MockWebSocket.instances = [];
    });

    const defaultConfig = {
        workspaceId: '123e4567-e89b-12d3-a456-426614174000',
        userId: 'test-user',
        token: 'test-token',
        url: 'ws://localhost:8080',
        autoReconnect: false,
    };

    it('should only broadcast the new operation on set(), not the whole queue', async () => {
        const client = new NMeshedClient(defaultConfig);

        // --- 1. Connect First Client ---
        const connectPromise = client.connect();
        await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
        const ws = MockWebSocket.instances[0];
        ws.simulateOpen();
        ws.simulateBinaryMessage(packInit({})); // Complete hydration handshake
        await connectPromise;

        // Reset spy to clear handshake/auth messages
        (ws.send as any).mockClear();

        // --- 2. Perform Operations ---

        // 2a. First Operation
        client.set('key1', 'value1');

        // Assert: Sent exactly once
        expect(ws.send).toHaveBeenCalledTimes(1);
        const call1 = (ws.send as any).mock.calls[0][0];
        expect(call1).toBeInstanceOf(Uint8Array);

        // 2b. Second Operation (REGRESSION CHECK)
        (ws.send as any).mockClear();
        client.set('key2', 'value2');

        // Assert: Sent exactly once (Previously would send ALL ops)
        expect(ws.send).toHaveBeenCalledTimes(1);

        // Verify Queue Size (internal state)
        // We expect >= 2 because boot() registers system schemas which create ops
        expect(client.getQueueSize()).toBeGreaterThanOrEqual(2);

        // --- 3. Persistence & Disconnect ---

        // Advance timers to trigger debounced persistence save
        await vi.advanceTimersByTimeAsync(2000);

        // Verify successful save to our mock DB
        expect(saveQueue).toHaveBeenCalled();
        // Just verify we saved something substantial
        if (shared.mockDbQueue instanceof Uint8Array) {
            expect(shared.mockDbQueue.byteLength).toBeGreaterThan(0);
        } else {
            expect(shared.mockDbQueue.length).toBeGreaterThanOrEqual(2);
        }

        // Disconnect
        client.disconnect();

        // --- 4. Reconnect & Flush ---

        (ws.send as any).mockClear(); // Clear old spy

        const reconnectPromise = client.connect();
        await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(2)); // New socket
        const ws2 = MockWebSocket.instances[1];
        vi.spyOn(ws2, 'send');
        ws2.simulateOpen();
        ws2.simulateBinaryMessage(packInit({})); // Complete hydration handshake
        await reconnectPromise;

        // Ensure loadQueue was called on reconnect
        expect(loadQueue).toHaveBeenCalled();

        // On connect -> flushQueue -> sends pending ops
        expect(ws2.send).toHaveBeenCalled();
        const calls = (ws2.send as any).mock.calls;

        // Filter for binary messages (Ops)
        // Note: With system ops, we expect valid broadcast
        const binaryCalls = calls.filter((c: any) => c[0] instanceof Uint8Array);

        expect(binaryCalls.length).toBeGreaterThanOrEqual(1);
    });
});
