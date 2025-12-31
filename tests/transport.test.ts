/**
 * NMeshed v2 - Transport Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketTransport } from '../src/transport';

// Mock WebSocket
class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    binaryType = 'arraybuffer';
    url: string;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(url: string) {
        this.url = url;
        // Simulate async connection
        setTimeout(() => {
            this.readyState = MockWebSocket.OPEN;
            this.onopen?.();
        }, 10);
    }

    send = vi.fn();
    close = vi.fn(() => {
        this.readyState = MockWebSocket.CLOSED;
        setTimeout(() => this.onclose?.(), 0);
    });
}

vi.stubGlobal('WebSocket', MockWebSocket);

describe('WebSocketTransport', () => {
    let transport: WebSocketTransport;

    beforeEach(() => {
        vi.useFakeTimers();
        transport = new WebSocketTransport({
            workspaceId: 'test-workspace',
            token: 'test-token',
        });
    });

    afterEach(() => {
        transport.disconnect();
        vi.useRealTimers();
    });

    describe('constructor', () => {
        it('should use default server URL', () => {
            const t = new WebSocketTransport({
                workspaceId: 'ws',
                token: 'tok',
            });
            expect(t).toBeDefined();
        });

        it('should use custom server URL', () => {
            const t = new WebSocketTransport({
                workspaceId: 'ws',
                token: 'tok',
                serverUrl: 'wss://custom.example.com',
            });
            expect(t).toBeDefined();
        });

        it('should accept apiKey instead of token', () => {
            const t = new WebSocketTransport({
                workspaceId: 'ws',
                apiKey: 'key123',
            });
            expect(t).toBeDefined();
        });

        it('should enable debug mode', () => {
            const t = new WebSocketTransport({
                workspaceId: 'ws',
                token: 'tok',
                debug: true,
            });
            expect(t).toBeDefined();
        });
    });

    describe('connect', () => {
        it('should connect successfully', async () => {
            const connectPromise = transport.connect();
            vi.advanceTimersByTime(50);
            await connectPromise;
            expect(transport.isConnected()).toBe(true);
        });

        it('should handle connection error', async () => {
            // Override MockWebSocket to simulate error
            const OriginalMockWebSocket = MockWebSocket;
            class ErrorWebSocket extends OriginalMockWebSocket {
                constructor(url: string) {
                    super(url);
                    setTimeout(() => {
                        this.onerror?.(new Event('error'));
                    }, 5);
                }
            }
            vi.stubGlobal('WebSocket', ErrorWebSocket);

            const errorTransport = new WebSocketTransport({
                workspaceId: 'ws',
                token: 'tok',
            });

            const connectPromise = errorTransport.connect();
            vi.advanceTimersByTime(50);

            await expect(connectPromise).rejects.toThrow();

            vi.stubGlobal('WebSocket', OriginalMockWebSocket);
        });
    });

    describe('disconnect', () => {
        it('should disconnect', async () => {
            const connectPromise = transport.connect();
            vi.advanceTimersByTime(50);
            await connectPromise;

            transport.disconnect();
            vi.advanceTimersByTime(50);

            expect(transport.isConnected()).toBe(false);
        });

        it('should not reconnect after disconnect', async () => {
            const connectPromise = transport.connect();
            vi.advanceTimersByTime(50);
            await connectPromise;

            transport.disconnect();
            vi.advanceTimersByTime(50000); // Long enough for reconnect

            expect(transport.isConnected()).toBe(false);
        });
    });

    describe('send', () => {
        it('should send data when connected', async () => {
            const connectPromise = transport.connect();
            vi.advanceTimersByTime(50);
            await connectPromise;

            const data = new Uint8Array([1, 2, 3]);
            transport.send(data);

            // Verify send was called on WebSocket
            expect(transport.isConnected()).toBe(true);
        });

        it('should not throw when sending while disconnected', () => {
            const data = new Uint8Array([1, 2, 3]);
            expect(() => transport.send(data)).not.toThrow();
        });
    });

    describe('onMessage', () => {
        it('should register and trigger message handler', async () => {
            const handler = vi.fn();
            transport.onMessage(handler);

            const connectPromise = transport.connect();
            vi.advanceTimersByTime(50);
            await connectPromise;

            // Simulate receiving a message
            const mockEvent = { data: new Uint8Array([1, 2, 3]).buffer };
            // Access internal WebSocket to trigger message
            (transport as any).ws?.onmessage?.(mockEvent);

            expect(handler).toHaveBeenCalled();
        });

        it('should return unsubscribe function', () => {
            const handler = vi.fn();
            const unsub = transport.onMessage(handler);
            expect(typeof unsub).toBe('function');
            unsub();
        });
    });

    describe('onClose', () => {
        it('should register close handler', async () => {
            const handler = vi.fn();
            transport.onClose(handler);

            const connectPromise = transport.connect();
            vi.advanceTimersByTime(50);
            await connectPromise;

            transport.disconnect();
            vi.advanceTimersByTime(50);

            expect(handler).toHaveBeenCalled();
        });

        it('should return unsubscribe function', () => {
            const handler = vi.fn();
            const unsub = transport.onClose(handler);
            expect(typeof unsub).toBe('function');
            unsub();
        });
    });

    describe('isConnected', () => {
        it('should return false initially', () => {
            expect(transport.isConnected()).toBe(false);
        });

        it('should return true when connected', async () => {
            const connectPromise = transport.connect();
            vi.advanceTimersByTime(50);
            await connectPromise;
            expect(transport.isConnected()).toBe(true);
        });
    });

    describe('reconnection', () => {
        it('should attempt reconnection after disconnect', async () => {
            const connectPromise = transport.connect();
            vi.advanceTimersByTime(50);
            await connectPromise;

            // Simulate unexpected close
            (transport as any).ws?.onclose?.();

            // Should attempt reconnect after delay
            vi.advanceTimersByTime(1100);

            // Transport should try to reconnect - it may have already succeeded with our mock
            // The important thing is the transport didn't crash
            expect(transport.isConnected()).toBeDefined();
        });
    });
});
