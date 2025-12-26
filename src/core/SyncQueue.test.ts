import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncEngine } from './SyncEngine';
import { NMeshedClient } from '../client';
import { Transport, TransportStatus } from '../transport/Transport';

// Mock WASM
vi.mock('../wasm/nmeshed_core', () => {
    class MockCore {
        apply_local_op = vi.fn().mockReturnValue(new Uint8Array([1, 2, 3]));
        merge_remote_delta = vi.fn();
        get_state = vi.fn().mockReturnValue({});
        get_value = vi.fn();
    }
    return {
        default: vi.fn(),
        NMeshedClientCore: MockCore
    };
});

class MockTransport implements Transport {
    status: TransportStatus = 'IDLE';
    send = vi.fn();
    sendEphemeral = vi.fn();
    broadcast = vi.fn();
    getStatus = () => this.status;
    connect = async () => { };
    disconnect = () => { };
    getPeers = () => [];
    simulateLatency = vi.fn();
    simulatePacketLoss = vi.fn();
    ping = vi.fn().mockResolvedValue(10);
    on = vi.fn();
    once = vi.fn();
    emit = vi.fn();
    off = vi.fn();
    removeListener = vi.fn();
    removeAllListeners = vi.fn();
    listeners = vi.fn().mockReturnValue([]);
}

// Mock persistence to avoid IndexedDB errors
vi.mock('../persistence', () => ({
    loadQueue: vi.fn().mockResolvedValue([]),
    saveQueue: vi.fn().mockResolvedValue(undefined),
}));

describe('SyncEngine Queue Logic', () => {
    let engine: SyncEngine;

    beforeEach(() => {
        engine = new SyncEngine('test-workspace');
    });

    it('should allow shifting items from the queue', () => {
        (engine as any).operationQueue = [
            new Uint8Array([1]),
            new Uint8Array([2]),
            new Uint8Array([3])
        ];

        engine.shiftQueue(2);

        const pending = engine.getPendingOps();
        expect(pending.length).toBe(1);
        expect(pending[0]).toEqual(new Uint8Array([3]));
    });

    it('should handle shifting more items than available', () => {
        (engine as any).operationQueue = [new Uint8Array([1])];
        engine.shiftQueue(10);
        expect(engine.getPendingOps().length).toBe(0);
    });
});

describe('NMeshedClient Flush Logic', () => {
    it('should handle partial flush on transport error', async () => {
        const transport = new MockTransport();
        const client = new NMeshedClient({
            workspaceId: 'test',
            token: 'test-token',
            transport: 'server' // Doesn't matter, we'll inject mock
        });
        (client as any).transport = transport;
        (client as any)._status = 'CONNECTED';

        // Add 3 ops to queue
        const engine = (client as any).engine;
        engine.addToQueue(new Uint8Array([1]));
        engine.addToQueue(new Uint8Array([2]));
        engine.addToQueue(new Uint8Array([3]));

        // Fail on the 2nd op
        let callCount = 0;
        vi.spyOn(transport, 'send').mockImplementation((_data) => {
            callCount++;
            if (callCount === 2) throw new Error('Network fail');
        });

        // Trigger flush
        (client as any).flushQueue();

        // Should have sent the 1st successfully
        // Should have failed on the 2nd and stopped
        // The 1st should be removed from queue, 2nd and 3rd remain.
        const pending = client.operationQueue;
        expect(pending.length).toBe(2);
        expect(pending[0]).toEqual(new Uint8Array([2]));
        expect(pending[1]).toEqual(new Uint8Array([3]));
    });
});
