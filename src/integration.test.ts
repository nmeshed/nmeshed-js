import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { NMeshedClient } from './client';
import { setupTestMocks, teardownTestMocks, defaultMockServer, MockWebSocket } from './test-utils/mocks';

// Mock Modules at Top Level
vi.mock('./persistence', () => ({
    loadQueue: vi.fn().mockResolvedValue([]),
    saveQueue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./wasm/nmeshed_core', async () => {
    const mocks = await import('./test-utils/mocks');
    return {
        default: vi.fn().mockResolvedValue(undefined),
        NMeshedClientCore: mocks.MockWasmCore
    };
});

// TestMockWebSocket with auto-connect for integration tests
class TestMockWebSocket extends MockWebSocket {
    constructor(url: string) {
        super(url, defaultMockServer);
        // Auto-connect using microtask
        Promise.resolve().then(() => {
            this.simulateOpen();
        });
    }
}

// Global WebSocket Stubbing
const originalWebSocket = global.WebSocket;

beforeAll(() => {
    // No-op
});

afterAll(() => {
    global.WebSocket = originalWebSocket;
    if (typeof window !== 'undefined') {
        (window as any).WebSocket = originalWebSocket;
    }
});

// --------------------------------------------------------------------------
// TESTS
// --------------------------------------------------------------------------
describe('Integration: Host Rejoin', () => {
    beforeEach(() => {
        setupTestMocks();
        vi.useFakeTimers();

        // Force override WebSocket
        global.WebSocket = TestMockWebSocket as any;
        if (typeof window !== 'undefined') {
            (window as any).WebSocket = TestMockWebSocket;
        }
    });

    afterEach(() => {
        vi.useRealTimers();
        defaultMockServer.reset();
        MockWebSocket.instances = [];
        vi.clearAllMocks();
    });

    it('should persist state via Peer when Host rejoins', async () => {
        const config = { workspaceId: 'ws-1', token: 'tok' };

        // 1. Host Connects
        const host = new NMeshedClient(config);
        const hostConnect = host.connect();

        // Use advanceTimers logic
        await vi.advanceTimersByTimeAsync(100);
        await hostConnect;
        expect(host.getStatus()).toBe('CONNECTED');

        // 2. Host Sets State
        host.set('x', 1);
        await vi.advanceTimersByTimeAsync(100); // Flush
        expect(defaultMockServer.state['x']).toBe(1);

        // 3. Peer Connects
        const peer = new NMeshedClient({ ...config, userId: 'peer-1' });
        const peerConnect = peer.connect();
        await vi.advanceTimersByTimeAsync(100);
        await peerConnect;

        // Peer should have received 'x': 1 from Init
        expect(peer.get('x')).toBe(1);

        // 4. Peer Sets State
        peer.set('y', 2);
        await vi.advanceTimersByTimeAsync(100);
        expect(defaultMockServer.state['y']).toBe(2);
        expect(peer.get('y')).toBe(2);

        // 5. Host should eventually see y=2 (via broadcast)
        // ... Wait for propagation ...
        // Note: In this mock setup, MockRelayServer.onMessage -> broadcasts -> clients receive immediately (sync)
        expect(host.get('y')).toBe(2);

        // 6. HOST LEAVES
        host.disconnect();
        await vi.advanceTimersByTimeAsync(100);
        expect(host.getStatus()).toBe('DISCONNECTED');
        expect(defaultMockServer.clients.size).toBe(1); // Only Peer remaining

        // 7. HOST REJOINS (New Instance)
        const host2 = new NMeshedClient(config); // Same User
        const host2Connect = host2.connect();
        await vi.advanceTimersByTimeAsync(100);
        await host2Connect;
        expect(host2.getStatus()).toBe('CONNECTED');

        // 8. Verify Host2 has Full State
        expect(host2.get('x')).toBe(1);
        expect(host2.get('y')).toBe(2);
    });

    /**
     * Regression test: Server sends JSON init message (not binary).
     * This caused FSM to stuck at HYDRATING because WASM couldn't parse JSON.
     * The fix: Transport emits dedicated 'init' event, Client hydrates state directly.
     */
    it('should handle JSON init message from server (regression)', async () => {
        const client = new NMeshedClient({ workspaceId: 'ws-init-test', token: 'tok' });

        // Track snapshot event
        let snapshotFired = false;
        client.engine.once('snapshot', () => {
            snapshotFired = true;
        });

        // Connect
        const connectPromise = client.connect();
        await vi.advanceTimersByTimeAsync(100);
        await connectPromise;

        // After connect, server sends JSON init with pre-existing state
        // (The MockRelayServer does this automatically via simulateServerMessage)

        // Verify snapshot event fired (indicates init was processed correctly)
        expect(snapshotFired).toBe(true);

        // Verify client can now read/write state normally
        client.set('test-key', 'test-value');
        await vi.advanceTimersByTimeAsync(50);
        expect(defaultMockServer.state['test-key']).toBe('test-value');
    });

    it('Stress: 7 Users Random Churn (Fuzz Test)', async () => {
        // --- Setup ---
        const CLIENT_COUNT = 7;
        const TICKS = 200;
        const clients: NMeshedClient[] = [];
        const config = { workspaceId: 'ws-stress', token: 'tok' };

        // Track expected state (Map<key, value>)
        const expectedState: Record<string, number> = {};

        // Initialize Clients
        for (let i = 0; i < CLIENT_COUNT; i++) {
            clients.push(new NMeshedClient({ ...config, userId: `user-${i}` }));
        }

        // Connect at least ONE client before simulation to ensure k-0 can be sent
        const firstConnection = clients[0].connect();
        await vi.advanceTimersByTimeAsync(100);
        await firstConnection;

        // --- Simulation Loop ---
        console.log(`Starting Fuzz Simulation: ${CLIENT_COUNT} users, ${TICKS} ticks`);

        for (let tick = 0; tick < TICKS; tick++) {
            // 1. Random Churn (Connect/Disconnect)
            const toggleUserIdx = Math.floor(Math.random() * CLIENT_COUNT);
            const toggler = clients[toggleUserIdx];
            if (toggler.getStatus() === 'CONNECTED') {
                toggler.disconnect();
            } else if (toggler.getStatus() === 'DISCONNECTED' || toggler.getStatus() === 'IDLE') {
                // Async connect, let simulation proceed
                toggler.connect().catch(() => { });
            }

            // 2. Random Update
            const targetKey = `k-${tick}`;
            const targetVal = tick;
            expectedState[targetKey] = targetVal;

            const actorIdx = Math.floor(Math.random() * CLIENT_COUNT);
            const actor = clients[actorIdx];

            try {
                actor.set(targetKey, targetVal);
            } catch (e) {
                console.error('Update failed', e);
            }

            // 3. Tick (Forward Time)
            await vi.advanceTimersByTimeAsync(20);
        }

        console.log('--- Simulation Ended. Converging... ---');

        // --- Convergence & Final Assertion ---
        // 1. Connect ALL users
        for (const c of clients) {
            if (c.getStatus() !== 'CONNECTED') {
                c.connect().catch(() => { });
            }
        }

        // 2. Allow extensive propagation
        await vi.advanceTimersByTimeAsync(5000);

        // 3. Verify Server State = Expected State
        // Note: server.state accumulates ALL updates.
        for (const [k, v] of Object.entries(expectedState)) {
            expect(defaultMockServer.state[k]).toBe(v);
        }

        // 4. Verify All Clients match Server
        for (const c of clients) {
            for (const [k, v] of Object.entries(expectedState)) {
                expect(c.get(k)).toBe(v);
            }
        }
    });

});
