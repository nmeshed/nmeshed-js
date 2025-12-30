import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NMeshedClient } from './client';
import { MockWebSocket, MockRelayServer, defaultMockServer, setupTestMocks, teardownTestMocks } from './test-utils/mocks';
import { packOp, packInit } from './test-utils/wire-utils';

describe('High Fidelity Simulation: Host-Guest Synchronization', () => {
    let host: NMeshedClient;
    let guest: NMeshedClient;

    beforeEach(() => {
        setupTestMocks();
        // Reset server state
        defaultMockServer.reset();
    });

    afterEach(() => {
        if (host) host.disconnect();
        if (guest) guest.disconnect();
        teardownTestMocks();
    });

    it('Scenario: Guest joins existing Host session (Ghost World Prevention)', async () => {
        // 1. Host Connects
        const validWsId = '00000000-0000-0000-0000-000000000000';
        host = new NMeshedClient({ workspaceId: validWsId, peerId: 'host-1' } as any);
        const hostConnectPromise = host.connect();

        await vi.waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));

        // Host handshake
        const hostSocket = MockWebSocket.instances[0];
        expect(hostSocket).toBeDefined();
        hostSocket.onopen({} as any);
        // Server sends Init (empty for Host)
        hostSocket.onmessage({ data: packInit({}) } as any);
        await hostConnectPromise;
        expect(host.getStatus()).toBe('READY');

        // 2. Host creates State (Entities)
        // Simulate GameEngine creating entities
        host.set('entity_1', { type: 'miner', x: 10, y: 20 });
        host.set('i_spawned_1', { type: 'item', count: 5 }); // Verify 'i_' prefix works

        // Verify Host State
        expect(host.get('entity_1')).toEqual({ type: 'miner', x: 10, y: 20 });
        const hostSnapshot = host.getAllValues();
        expect(Object.keys(hostSnapshot).length).toBeGreaterThan(0);
        const binarySnapshot = host.getBinarySnapshot();
        expect(binarySnapshot).toBeDefined();
        expect(binarySnapshot!.length).toBeGreaterThan(0);

        // 3. Guest Connects (Joiner)
        guest = new NMeshedClient({ workspaceId: validWsId, peerId: 'guest-1' } as any);
        const guestConnectPromise = guest.connect();

        await vi.waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(1));

        const guestSocket = MockWebSocket.instances[1];
        expect(guestSocket).toBeDefined();

        // 4. Server Simulation: Send Host's snapshot to Guest as Init packet
        // This simulates the critical "Shadow Snapshot" mechanism of the real server
        guestSocket.onopen({} as any);

        // CRITICAL: Send binary Init packet derived from Host's state
        // This exercises the `apply_vessel` path in SyncEngine we just fixed.
        // We use packInit from wire-utils which uses FlatBuffers (Parity)
        const initPacket = packInit(binarySnapshot!);
        guestSocket.onmessage({ data: initPacket } as any);

        await guestConnectPromise;
        expect(guest.getStatus()).toBe('READY');

        // 5. Verification: Guest should have Host's state
        // This fails if "Ghost World" regression exists (0 entities)
        expect(guest.get('entity_1')).toEqual({ type: 'miner', x: 10, y: 20 });
        expect(guest.get('i_spawned_1')).toEqual({ type: 'item', count: 5 });

        // 6. Real-time Sync (Host -> Guest)
        // Host moves entity
        host.set('entity_1', { type: 'miner', x: 11, y: 20 });

        // In this Mock setup, we must manually relay the Op if we want full fidelity,
        // or rely on the MockServer if it was smart enough (it's not fully smart yet).
        // Let's manually relay for "high fidelity" control.
        // hostSocket.send was called. We capture it.
        // But MockWebSocket.send doesn't expose data easily unless we spy.
        // For this test, verifying Hydration (Step 5) is the primary "Ghost World" fix goal.

        // If we want to verify Real-Time:
        // We can spy on hostSocket.send, capture binary, feed to guestSocket.onmessage.
    });

    it('Scenario: Real-Time Op Relay', async () => {
        const validWsId = '00000000-0000-0000-0000-000000000000';
        host = new NMeshedClient({ workspaceId: validWsId, peerId: 'host-2' } as any);
        guest = new NMeshedClient({ workspaceId: validWsId, peerId: 'guest-2' } as any);

        // Host Init
        host.connect();
        await vi.waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
        const s1 = MockWebSocket.instances[MockWebSocket.instances.length - 1];
        if (s1) {
            s1.onopen({} as any);
            s1.onmessage({ data: packInit({}) } as any);
        }

        // Guest Init (Start empty)
        guest.connect();
        await vi.waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(1));
        const s2 = MockWebSocket.instances[MockWebSocket.instances.length - 1];
        if (s2) {
            s2.onopen({} as any);
            s2.onmessage({ data: packInit({}) } as any);
        }

        // Spy on Host send to capture Op
        if (s1) {
            const sendSpy = vi.spyOn(s1, 'send');

            // Host performs action
            host.set('rt_key', { val: 123 });

            expect(sendSpy).toHaveBeenCalled();
            const sentData = sendSpy.mock.calls[0][0]; // Arg 0 is data

            // Server Relay: Send to Guest
            if (s2) s2.onmessage({ data: sentData } as any);

            // Verify Guest received it
            expect(guest.get('rt_key')).toEqual({ val: 123 });
        }
    });
});
