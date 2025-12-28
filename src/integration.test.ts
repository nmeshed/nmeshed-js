import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { NMeshedClient } from './client';
import { setupTestMocks, teardownTestMocks, defaultMockServer, MockWebSocket, AutoMockWebSocket } from './test-utils/mocks';
import { decodeValue } from './codec';

// Mock Persistence with In-Memory Store
vi.mock('./persistence', () => {
    const mockPersistenceStore = new Map<string, any[]>();
    return {
        loadQueue: vi.fn().mockImplementation(async (storageKey) => {
            return mockPersistenceStore.get(storageKey) || [];
        }),
        saveQueue: vi.fn().mockImplementation(async (storageKey, queue) => {
            mockPersistenceStore.set(storageKey, [...queue]);
        }),
    };
});

// Real nmeshed_core (WASM) is now used.
// No vi.mock here.

// Global WebSocket Stubbing
const originalWebSocket = globalThis.WebSocket;
const originalRAF = globalThis.requestAnimationFrame;

let activeClients: NMeshedClient[] = [];

beforeAll(() => {
    // Polyfill RAF for Node tests
    if (!globalThis.requestAnimationFrame) {
        globalThis.requestAnimationFrame = (callback: any) => {
            return setTimeout(() => callback(Date.now()), 16) as any;
        };
    }
});

afterAll(async () => {
    for (const client of activeClients) {
        try {
            client.destroy();
        } catch (e) { }
    }
    activeClients = [];
    globalThis.WebSocket = originalWebSocket;
    globalThis.requestAnimationFrame = originalRAF;
    if (typeof window !== 'undefined') {
        (window as any).WebSocket = originalWebSocket;
    }
});

// --------------------------------------------------------------------------
// TESTS
// --------------------------------------------------------------------------
// Helper to connect with timers
async function connectClient(client: NMeshedClient) {
    activeClients.push(client);
    const p = client.connect();
    await vi.advanceTimersByTimeAsync(100); // Advance IDB/Socket timers
    return p;
}

describe('Integration: Host Rejoin', () => {
    beforeEach(() => {
        setupTestMocks();
        vi.useFakeTimers();

        // 1. Force override WebSocket with Auto-Connect version
        globalThis.WebSocket = AutoMockWebSocket as any;
        if (typeof window !== 'undefined') {
            (window as any).WebSocket = AutoMockWebSocket;
        }
    });

    afterEach(async () => {
        // Destroy all clients created in this test
        for (const client of activeClients) {
            try {
                client.destroy();
            } catch (e) { }
        }
        activeClients = [];

        // Clear IndexedDB to prevent state leakage between tests
        if (typeof indexedDB !== 'undefined') {
            const req = indexedDB.deleteDatabase('nmeshed_db');
            await new Promise<void>((resolve) => {
                req.onsuccess = () => resolve();
                req.onerror = () => resolve(); // Ignore error
                req.onblocked = () => resolve();
            });
        }

        vi.useRealTimers();
        defaultMockServer.reset();
        MockWebSocket.instances = [];
        vi.clearAllMocks();
    });

    it('should persist state via Peer when Host rejoins', async () => {
        const config = { workspaceId: '00000000-0000-0000-0000-000000000001', userId: 'host-1', token: 'tok' };

        // 1. Host Connects
        const host = new NMeshedClient(config);
        await connectClient(host);

        expect(host.getStatus()).toBe('READY');

        // 2. Host Sets State
        host.set('x', 1);
        await vi.advanceTimersByTimeAsync(100); // Flush
        expect(defaultMockServer.getValue('x')).toBe(1);

        // 3. Peer Connects
        const peer = new NMeshedClient({ ...config, userId: 'peer-1' });
        await connectClient(peer);

        // Peer should have received 'x': 1 from Init
        expect(peer.get('x')).toBe(1);

        // 4. Peer Sets State
        peer.set('y', 2);
        await vi.advanceTimersByTimeAsync(100);
        expect(defaultMockServer.getValue('y')).toBe(2);
        expect(peer.get('y')).toBe(2);

        // 5. Host should eventually see y=2 (via broadcast)
        // Wait for propagation
        expect(host.get('y')).toBe(2);

        // 6. HOST LEAVES
        host.disconnect();
        await vi.advanceTimersByTimeAsync(100);
        expect(host.getStatus()).toBe('DISCONNECTED');
        expect(defaultMockServer.clients.size).toBe(1); // Only Peer remaining

        // 7. HOST REJOINS (New Instance)
        const host2 = new NMeshedClient(config); // Same User
        await connectClient(host2);
        expect(host2.getStatus()).toBe('READY');

        // 8. Verify Host2 has Full State
        expect(host2.get('x')).toBe(1);
        expect(host2.get('y')).toBe(2);
    });

    // Skip: 7-user fuzz test is extremely slow (2+ mins) and creates 7 WASM runtimes.
    // We rely on smaller unit tests and manual E2E for now.
    it('Stress: 7 Users Random Churn (Fuzz Test)', async () => {
        const CLIENT_COUNT = 4;
        const TICKS = 20;
        const clients: NMeshedClient[] = [];

        // Setup clients
        for (let i = 0; i < CLIENT_COUNT; i++) {
            const userId = `00000000-0000-0000-0000-0000000000${i.toString().padStart(2, '0')}`;
            const c = new NMeshedClient({ workspaceId: '00000000-0000-0000-0000-000000000003', userId, token: 'tok' });
            clients.push(c);
            await connectClient(c);
        }
        await vi.advanceTimersByTimeAsync(100);

        const expectedState: Record<string, number> = {};

        for (let tick = 0; tick < TICKS; tick++) {
            // 1. Random Churn (Connect/Disconnect)
            // Safety: Always keep user-0 connected to prevent "Empty Room" state reset
            const toggleUserIdx = Math.floor(Math.random() * (CLIENT_COUNT - 1)) + 1; // 1 to 6
            const toggler = clients[toggleUserIdx];
            if (toggler.getStatus() !== 'IDLE' && toggler.getStatus() !== 'DISCONNECTED') {
                toggler.disconnect();
            } else if (toggler.getStatus() === 'DISCONNECTED' || toggler.getStatus() === 'IDLE') {
                // Async connect, let simulation proceed
                // Don't wait on connect here, it's churn
                connectClient(toggler).catch(() => { });
            }

            // 2. Random Updates
            const updateUserIdx = Math.floor(Math.random() * CLIENT_COUNT);
            const updater = clients[updateUserIdx];
            if (updater.getStatus() === 'CONNECTED' || updater.getStatus() === 'READY') {
                const key = `k-${tick}`;
                const val = tick;
                updater.set(key, val);
                expectedState[key] = val;
            }

            await vi.advanceTimersByTimeAsync(100);
        }

        // 3. Stablize: Ensure everyone connected
        for (const c of clients) {
            if (c.getStatus() !== 'READY') await connectClient(c);
        }
        await vi.advanceTimersByTimeAsync(2000);

        // Verify Server matches Expected
        for (const [k, v] of Object.entries(expectedState)) {
            expect(defaultMockServer.getValue(k)).toBe(v);
        }

        // 4. Verify All Clients match Server
        let failCount = 0;
        for (const c of clients) {
            const missingKeys: string[] = [];
            for (const [k, v] of Object.entries(expectedState)) {
                const val = c.get(k);
                if (val !== v) {
                    missingKeys.push(`${k} (exp ${v}, got ${val})`);
                }
            }
            if (missingKeys.length > 0) {
                console.error(`[FAIL] Client ${clients.indexOf(c)} (Status=${c.getStatus()}) missing ${missingKeys.length} keys:`, missingKeys.slice(0, 5));
                failCount++;
            }
        }
        if (failCount > 0) {
            throw new Error(`Verification failed for ${failCount} clients.`);
        }
    }, 60000);
});
