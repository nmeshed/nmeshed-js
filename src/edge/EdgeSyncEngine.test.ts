import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EdgeSyncEngine, DurableObjectState, DurableObjectStorage } from './EdgeSyncEngine';

// Mock WebSocket for edge environment
class MockWebSocket {
    readyState = 1; // OPEN
    send = vi.fn();
    close = vi.fn();
}

// Mock DurableObjectStorage
function createMockStorage(): DurableObjectStorage {
    const data = new Map<string, unknown>();
    return {
        get: vi.fn(async (key: string) => data.get(key)) as any,
        put: vi.fn(async (key: string, value: unknown) => { data.set(key, value); }),
        delete: vi.fn(async (key: string) => data.delete(key)),
        getAlarm: vi.fn(async () => null),
        setAlarm: vi.fn(async () => { })
    };

}

// Mock DurableObjectState
function createMockState(options: { roomId?: string } = {}): DurableObjectState {
    const sockets: WebSocket[] = [];
    return {
        id: {
            toString: () => options.roomId ?? 'test-room-123',
            name: options.roomId
        },
        storage: createMockStorage(),
        acceptWebSocket: vi.fn((ws: WebSocket) => { sockets.push(ws); }),
        getWebSockets: vi.fn(() => sockets)
    };
}

describe('EdgeSyncEngine', () => {
    let mockState: DurableObjectState;
    let engine: EdgeSyncEngine;

    beforeEach(() => {
        mockState = createMockState();
        engine = new EdgeSyncEngine(mockState);
    });

    describe('construction', () => {
        it('creates engine with default config', () => {
            expect(engine).toBeDefined();
        });

        it('accepts custom config', () => {
            const customEngine = new EdgeSyncEngine(mockState, {
                mode: 'crdt',
                persistInterval: 5,
                debug: true
            });
            expect(customEngine).toBeDefined();
        });
    });

    describe('handleRequest', () => {
        it('returns 426 for non-WebSocket requests', async () => {
            const request = new Request('http://localhost/room/test', {
                headers: {}
            });

            const response = await engine.handleRequest(request);

            expect(response.status).toBe(426);
            expect(await response.text()).toBe('Expected WebSocket');
        });

        // Note: Tests for WebSocket upgrade require Cloudflare Workers runtime
        // Status 101 is not supported in Node.js Response
        it.skip('returns 101 for WebSocket upgrade requests (requires edge runtime)', async () => {
            // This test can only run in Cloudflare Workers environment
        });
    });

    describe('createInitPacket', () => {
        it('creates a valid Init packet with msgType=1', () => {
            const packet = engine.createInitPacket();

            expect(packet).toBeInstanceOf(Uint8Array);
            expect(packet.length).toBeGreaterThan(0);
            expect(packet[0]).toBe(1); // INIT_MSG_TYPE
        });

        it('includes operation count in Init packet header', () => {
            expect(engine.getOperationCount()).toBe(0);

            const packet = engine.createInitPacket();
            expect(packet).toBeInstanceOf(Uint8Array);
            // Header is 5 bytes: 1 byte msgType + 4 bytes count
            expect(packet.length).toBe(5);

            // Count should be 0 (little-endian)
            expect(packet[1]).toBe(0);
            expect(packet[2]).toBe(0);
            expect(packet[3]).toBe(0);
            expect(packet[4]).toBe(0);
        });

        it('includes operations in Init packet after handling messages', async () => {
            const mockWs = new MockWebSocket() as unknown as WebSocket;
            (mockState.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([mockWs]);

            // Add some operations
            const op1 = new Uint8Array([1, 2, 3, 4]);
            const op2 = new Uint8Array([5, 6, 7, 8, 9]);
            await engine.handleMessage(mockWs, op1.buffer);
            await engine.handleMessage(mockWs, op2.buffer);

            const packet = engine.createInitPacket();

            // Header (5) + op1 length (4) + op1 data (4) + op2 length (4) + op2 data (5)
            expect(packet.length).toBe(5 + 4 + 4 + 4 + 5);

            // Count should be 2
            expect(packet[1]).toBe(2);
        });
    });

    describe('handleMessage', () => {
        it('rejects string messages', async () => {
            const mockWs = new MockWebSocket() as unknown as WebSocket;

            await engine.handleMessage(mockWs, 'hello');

            expect(mockWs.send).toHaveBeenCalledWith(
                expect.stringContaining('Binary protocol required')
            );
        });

        it('broadcasts binary messages to all sockets', async () => {
            const mockWs1 = new MockWebSocket() as unknown as WebSocket;
            const mockWs2 = new MockWebSocket() as unknown as WebSocket;

            // Simulate two connected clients
            const sockets = [mockWs1, mockWs2];
            (mockState.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue(sockets);

            // Send a binary message
            const message = new ArrayBuffer(8);
            await engine.handleMessage(mockWs1, message);

            expect(mockWs1.send).toHaveBeenCalledWith(message);
            expect(mockWs2.send).toHaveBeenCalledWith(message);
        });

        it('stores operations for replay', async () => {
            const mockWs = new MockWebSocket() as unknown as WebSocket;
            (mockState.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([mockWs]);

            expect(engine.getOperationCount()).toBe(0);

            await engine.handleMessage(mockWs, new ArrayBuffer(8));
            expect(engine.getOperationCount()).toBe(1);

            await engine.handleMessage(mockWs, new ArrayBuffer(4));
            expect(engine.getOperationCount()).toBe(2);
        });
    });

    describe('handleClose', () => {
        it('handles close without error', () => {
            const mockWs = new MockWebSocket() as unknown as WebSocket;

            // Should not throw
            engine.handleClose(mockWs, 1000, 'Normal closure');
        });

        it('handles close with abnormal code', () => {
            const mockWs = new MockWebSocket() as unknown as WebSocket;

            // Should not throw
            engine.handleClose(mockWs, 1006, 'Abnormal closure');
        });
    });

    describe('handleError', () => {
        it('logs error without throwing', () => {
            const mockWs = new MockWebSocket() as unknown as WebSocket;
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

            engine.handleError(mockWs, new Error('Test error'));

            expect(consoleSpy).toHaveBeenCalledWith('[EdgeSync] WebSocket error:', expect.any(Error));
            consoleSpy.mockRestore();
        });
    });

    describe('persistence', () => {
        it('does not persist before interval reached', async () => {
            const customEngine = new EdgeSyncEngine(mockState, {
                persistInterval: 3
            });

            const mockWs = new MockWebSocket() as unknown as WebSocket;
            (mockState.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([mockWs]);

            await customEngine.handleMessage(mockWs, new ArrayBuffer(8));
            await customEngine.handleMessage(mockWs, new ArrayBuffer(8));

            expect(mockState.storage.put).not.toHaveBeenCalled();
        });

        it('persists state after configured interval', async () => {
            const customEngine = new EdgeSyncEngine(mockState, {
                persistInterval: 2
            });

            const mockWs = new MockWebSocket() as unknown as WebSocket;
            (mockState.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([mockWs]);

            await customEngine.handleMessage(mockWs, new ArrayBuffer(8));
            expect(mockState.storage.put).not.toHaveBeenCalled();

            await customEngine.handleMessage(mockWs, new ArrayBuffer(8));
            expect(mockState.storage.put).toHaveBeenCalledWith('snapshot', expect.any(Array));

        });

        it('resets counter after persist', async () => {
            const customEngine = new EdgeSyncEngine(mockState, {
                persistInterval: 2
            });

            const mockWs = new MockWebSocket() as unknown as WebSocket;
            (mockState.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([mockWs]);

            // First batch
            await customEngine.handleMessage(mockWs, new ArrayBuffer(8));
            await customEngine.handleMessage(mockWs, new ArrayBuffer(8));
            expect(mockState.storage.put).toHaveBeenCalledTimes(1);

            // Counter should reset, so next persist at 4 ops total
            await customEngine.handleMessage(mockWs, new ArrayBuffer(8));
            expect(mockState.storage.put).toHaveBeenCalledTimes(1);

            await customEngine.handleMessage(mockWs, new ArrayBuffer(8));
            expect(mockState.storage.put).toHaveBeenCalledTimes(2);
        });
    });

    describe('hydration', () => {
        it('hydrates operations from storage', async () => {
            // Pre-populate storage with operations
            const mockStorage = mockState.storage as ReturnType<typeof createMockStorage>;
            (mockStorage.get as ReturnType<typeof vi.fn>).mockResolvedValue({
                operations: [[1, 2, 3], [4, 5, 6]]
            });

            // Manually trigger hydration via a non-WS request (which calls hydrate)
            // We'll test this by checking getOperationCount after hydration
            const freshEngine = new EdgeSyncEngine(mockState);

            // Trigger hydration by calling handleRequest with non-upgrade
            // This still calls hydrate() internally before checking upgrade header
            const request = new Request('http://localhost/room/test', {
                headers: { 'Upgrade': 'websocket' }
            });

            // The response will fail in Node (status 101), but hydration should happen
            try {
                await freshEngine.handleRequest(request);
            } catch {
                // Expected in Node environment
            }

            expect(mockStorage.get).toHaveBeenCalledWith('snapshot');
            expect(freshEngine.getOperationCount()).toBe(2);
        });

        it('handles empty storage gracefully', async () => {
            const mockStorage = mockState.storage as ReturnType<typeof createMockStorage>;
            (mockStorage.get as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

            const freshEngine = new EdgeSyncEngine(mockState);

            const request = new Request('http://localhost/room/test', {
                headers: { 'Upgrade': 'websocket' }
            });

            try {
                await freshEngine.handleRequest(request);
            } catch {
                // Expected in Node environment
            }

            expect(freshEngine.getOperationCount()).toBe(0);
        });
    });
});
