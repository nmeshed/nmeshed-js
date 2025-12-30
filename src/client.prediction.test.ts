import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NMeshedClient } from './client';

// Simple mock transport that doesn't require EventEmitter complexity
// Since this test is about prediction behavior (immediate local updates),
// not about connection/hydration, we use a simplified approach
vi.mock('./transport/WebSocketTransport', () => {
    // Minimal mock that stores handlers and calls them
    return {
        WebSocketTransport: class {
            private handlers: Record<string, Function[]> = {};

            on(event: string, handler: Function) {
                if (!this.handlers[event]) this.handlers[event] = [];
                this.handlers[event].push(handler);
                return () => {
                    const idx = this.handlers[event]?.indexOf(handler);
                    if (idx >= 0) this.handlers[event].splice(idx, 1);
                };
            }

            emit(event: string, ...args: any[]) {
                this.handlers[event]?.forEach(h => h(...args));
            }

            async connect() {
                this.emit('status', 'CONNECTED');
                return Promise.resolve();
            }

            sendEphemeral = vi.fn();
            broadcast = vi.fn();
            disconnect = vi.fn();
            getStatus = () => 'CONNECTED';
            getLatency = () => 100;
            simulateLatency = vi.fn();
            simulatePacketLoss = vi.fn();
            ping = vi.fn();
        }
    };
});

describe('Client-Side Prediction (Zero Latency)', () => {
    let client: NMeshedClient;

    beforeEach(async () => {
        // Use real client logic, mocked transport
        const workspaceId = '123e4567-e89b-12d3-a456-426614174000';
        client = NMeshedClient.dev(workspaceId, {
            autoReconnect: false,
            connectionTimeout: 1, // Very short timeout 
        });

        // Start connect (don't wait for full completion)
        const connectPromise = client.connect();

        // Manually trigger the 'ready' event from the engine to complete hydration
        // Since transport is mocked, we need to do this manually
        setTimeout(() => {
            (client as any).engine.emit('ready', {});
        }, 0);

        // Wait for connection with short timeout
        await connectPromise.catch(() => {
            // Ignore timeout - the engine is ready nonetheless
        });
    });

    afterEach(() => {
        client.destroy();
    });

    it('should reflect local updates IMMEDIATELY before network ack', async () => {
        const key = 'user:1:name';
        const expectedValue = 'Alice';

        let updateReceived = false;
        let pResult: any = null;
        let isOpt = false;

        // 1. Subscribe to changes
        client.onKeyChange('user:1:*', (k, v, context) => {
            if (k === key) {
                updateReceived = true;
                pResult = v;
                isOpt = context.isOptimistic;
            }
        });

        // 2. Perform action
        client.set(key, expectedValue);

        // 3. Verify IMMEDIATE reflection (Synchronous)
        expect(updateReceived).toBe(true);
        expect(pResult).toBe(expectedValue);
        expect(isOpt).toBe(true);

        // 4. Verify value is retrievable immediately via get()
        const currentVal = client.get(key);
        expect(currentVal).toBe(expectedValue);

        // 5. Verify it WAS sent to transport
        const transportMock = (client as any).transport;
        expect(transportMock.broadcast).toHaveBeenCalled();
    });
});
