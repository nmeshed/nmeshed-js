
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NMeshedClient } from './client';
import { WebSocketTransport } from './transport/WebSocketTransport';

// Mock Transport to control network latency
vi.mock('./transport/WebSocketTransport', () => {
    return {
        WebSocketTransport: class {
            constructor() { }
            on = vi.fn();
            connect = vi.fn().mockResolvedValue(undefined);
            sendEphemeral = vi.fn();
            broadcast = vi.fn();
            disconnect = vi.fn();
            getStatus = () => 'CONNECTED';
            getLatency = () => 100; // Fake latency
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
        // Use valid UUID to pass core validation
        const workspaceId = '123e4567-e89b-12d3-a456-426614174000';
        client = NMeshedClient.dev(workspaceId, { autoReconnect: false });
        await client.connect();
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

        // 5. Verify it WAS sent to transport (but we didn't wait for it)
        // Access the mocked instance
        const transportMock = (client as any).transport;
        expect(transportMock.broadcast).toHaveBeenCalled();
    });
});
