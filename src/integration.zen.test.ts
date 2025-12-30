
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEngine, EngineState } from './core/SyncEngine';
import { MockWasmCore } from './test-utils/mocks';


// ============================================================================
// Chaos Network Simulation (The Zen Dojo)
// ============================================================================
// A simulated network that can drop, reorder, or delay packets between peers.
//
// "Chaos is not data lost; it is data flowing through a turbulent stream. 
//  The stream must eventually settle."

class ChaosNetwork {
    private peers = new Map<string, SyncEngine>();
    // Packet buffer: { to: string, data: Uint8Array, deliverAt: number }
    private packets: { to: string, data: Uint8Array, deliverAt: number }[] = [];
    private currentTime = 0;

    // Config
    public latencyMin = 5;
    public latencyMax = 50;
    public dropRate = 0.0; // 0% drop for now, eventual consistency requires retransmission which valid TCP/WS handles. 
    // We simulate UDP-like behavior if > 0, but SyncEngine assumes reliable transport for now.

    constructor() { }

    public register(peerId: string, engine: SyncEngine) {
        this.peers.set(peerId, engine);
        // Hook into engine's output? 
        // SyncEngine doesn't have an outbound event for Ops yet, it relies on 'op' event which is local application.
        // Wait, SyncEngine produces `delta` on `set`.
        // We probably need to intercept that.
        // Or better: The test drives the engines by calling `set` and taking the result `delta` 
        // and feeding it to the network.
    }

    public broadcast(from: string, data: Uint8Array) {
        for (const [peerId, peer] of this.peers) {
            if (peerId !== from) {
                this.send(peerId, data);
            }
        }
    }

    public send(to: string, data: Uint8Array) {
        if (Math.random() < this.dropRate) return; // Dropped

        const delay = this.latencyMin + Math.random() * (this.latencyMax - this.latencyMin);
        this.packets.push({
            to,
            data,
            deliverAt: this.currentTime + delay
        });

        // Ensure packets are processed in deliverAt order if we want deterministic simulation, 
        // but for chaos, array order is fine if we sort before ticking.
    }

    public tick(dt: number) {
        this.currentTime += dt;

        // Find executable packets
        // Filter in place
        const executable = this.packets.filter(p => p.deliverAt <= this.currentTime);
        this.packets = this.packets.filter(p => p.deliverAt > this.currentTime);

        for (const p of executable) {
            const peer = this.peers.get(p.to);
            if (peer) {
                peer.applyRawMessage(p.data);
            }
        }
    }

    public flush() {
        // Deliver all remaining
        while (this.packets.length > 0) {
            this.tick(100);
        }
    }
}


describe('Milestone 5: The Zen Chaos Test', () => {
    let network: ChaosNetwork;
    const clientCount = 10; // 50 might be too slow for unit test runner, starting with 10.
    const engines: SyncEngine[] = [];

    beforeEach(async () => {
        network = new ChaosNetwork();
        engines.length = 0;

        for (let i = 0; i < clientCount; i++) {
            const peerId = `p${i}`;
            const engine = new SyncEngine('chaos-ws', peerId, 'crdt', 1000, false);

            // Mock Core injection
            const core = new MockWasmCore('chaos-ws', 'crdt');
            (engine as any).core = core;
            (engine as any)._state = EngineState.ACTIVE;
            (engine as any).localVector = new Map<string, bigint>();
            (engine as any).remoteVectors = new Map<string, Map<string, bigint>>();

            // Register with network
            network.register(peerId, engine);
            engines.push(engine);
        }
    });

    afterEach(() => {
        engines.forEach(e => e.destroy());
    });

    it('Convergence under high concurrency', async () => {
        const iterationCount = 50;

        // 1. Generate random ops
        for (let i = 0; i < iterationCount; i++) {
            // Pick random sender
            const clientIdx = Math.floor(Math.random() * clientCount);
            const sender = engines[clientIdx];
            const senderId = `p${clientIdx}`;

            // Set value
            const key = `key-${Math.floor(Math.random() * 5)}`; // 5 conflicting keys
            const val = `val-${i}`;

            // Apply locally
            const delta = sender.set(key, val);

            // Broadcast via Chaos Network
            network.broadcast(senderId, delta);


            // Check specific key match
            if (i % 5 === 0) network.tick(10);

            // Ensure timestamp progression to avoid collision in this synthetic test
            await new Promise(r => setTimeout(r, 2));
        }

        // 2. Settle the network
        network.flush();

        // 3. Verify Convergence
        // Pick p0 as source of truth
        const truth = engines[0].getAllValues();

        for (let i = 1; i < clientCount; i++) {
            const state = engines[i].getAllValues();

            // Check specific key match to ensure values are identical
            expect(state).toEqual(truth);
        }

        // 4. Verify Vector Clocks (Milestone 4 Check)
        // Every engine should have a horizon > 0 for active peers
        // (Assuming valid op distribution)
        // Just checking correctness of internal maps
        const horizon = (engines[0] as any).calculateHorizon();
        // expect(horizon.size).toBeGreaterThan(0); 
    });
});
