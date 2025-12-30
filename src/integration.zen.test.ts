import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SyncEngine } from './core/SyncEngine';

// ============================================================================
// Chaos Network Simulation (The Zen Dojo)
// ============================================================================
// Tests eventual consistency with network latency and peer churn.

/**
 * ChaosNetwork: A simulated network layer for testing eventual consistency.
 * 
 * Provides configurable latency simulation and peer churn capabilities.
 * Packets are delivered after a random delay within [latencyMin, latencyMax].
 * 
 * @remarks
 * This is a test-only utility. It does NOT simulate packet loss by default.
 * For reliability testing, use `tick()` with varying intervals or `flush()`
 * to settle all in-flight packets.
 */
class ChaosNetwork {
    private peers = new Map<string, SyncEngine>();
    private packets: { to: string, data: Uint8Array, deliverAt: number }[] = [];
    private currentTime = 0;

    /** Minimum one-way latency in milliseconds */
    public latencyMin = 5;
    /** Maximum one-way latency in milliseconds */
    public latencyMax = 50;

    public register(peerId: string, engine: SyncEngine) {
        this.peers.set(peerId, engine);
    }

    public unregister(peerId: string) {
        this.peers.delete(peerId);
    }

    public broadcast(from: string, data: Uint8Array) {
        for (const [peerId] of this.peers) {
            if (peerId !== from) {
                this.send(peerId, data);
            }
        }
    }

    public send(to: string, data: Uint8Array) {
        const delay = this.latencyMin + Math.random() * (this.latencyMax - this.latencyMin);
        this.packets.push({ to, data, deliverAt: this.currentTime + delay });
    }

    public tick(dt: number) {
        this.currentTime += dt;
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
        while (this.packets.length > 0) {
            this.tick(100);
        }
    }
}

describe('Zen Chaos Test Suite: Eventual Consistency', () => {
    let network: ChaosNetwork;
    const engines: SyncEngine[] = [];

    beforeEach(() => {
        network = new ChaosNetwork();
        engines.length = 0;
    });

    afterEach(() => {
        engines.forEach(e => e.destroy());
    });

    // ========================================================================
    // Test 1: Multi-Client Sync (Spirit of integration.multi-client.test.ts)
    // ========================================================================
    it('syncs values between multiple peers via network', async () => {
        const clientCount = 3;

        for (let i = 0; i < clientCount; i++) {
            const peerId = `00000000-0000-0000-0000-0000000001${i.toString().padStart(2, '0')}`;
            const engine = new SyncEngine('00000000-0000-0000-0000-000000000001', peerId, 1000, false);
            await engine.boot();
            network.register(peerId, engine);
            engines.push(engine);
        }

        // Peer 0 sets a value
        const delta = engines[0].set('greeting', 'hello from peer 0');
        network.broadcast(`00000000-0000-0000-0000-000000000100`, delta);
        network.flush();
        await new Promise(r => setTimeout(r, 50));

        // All peers should see the value
        for (let i = 1; i < clientCount; i++) {
            expect(engines[i].get('greeting')).toBe('hello from peer 0');
        }

        // Peer 1 updates the value
        const delta2 = engines[1].set('greeting', 'updated by peer 1');
        network.broadcast(`00000000-0000-0000-0000-000000000101`, delta2);
        network.flush();
        await new Promise(r => setTimeout(r, 50));

        // All peers should see the update
        for (let i = 0; i < clientCount; i++) {
            expect(engines[i].get('greeting')).toBe('updated by peer 1');
        }
    }, 30000);

    // ========================================================================
    // Test 2: Host Rejoin Persistence (Spirit of integration.test.ts Host Rejoin)
    // ========================================================================
    it('maintains state when a peer rejoins the network', async () => {
        const workspaceId = '00000000-0000-0000-0000-000000000002';

        const hostPeerId = '00000000-0000-0000-0000-000000000200';
        const peerPeerId = '00000000-0000-0000-0000-000000000201';

        const host = new SyncEngine(workspaceId, hostPeerId, 1000, false);
        const peer = new SyncEngine(workspaceId, peerPeerId, 1000, false);
        await host.boot();
        await peer.boot();
        engines.push(host, peer);
        network.register(hostPeerId, host);
        network.register(peerPeerId, peer);

        // Host sets x=1
        const delta1 = host.set('x', 1);
        network.broadcast(hostPeerId, delta1);
        network.flush();
        await new Promise(r => setTimeout(r, 50));
        expect(peer.get('x')).toBe(1);

        // Host "disconnects"
        network.unregister(hostPeerId);

        // Peer sets y=2 while host is "gone"
        const delta2 = peer.set('y', 2);
        network.broadcast(peerPeerId, delta2);
        network.flush();
        await new Promise(r => setTimeout(r, 50));

        // Host "rejoins" and manually receives the missed delta
        network.register(hostPeerId, host);
        host.applyRawMessage(delta2);
        await new Promise(r => setTimeout(r, 50));

        // Host should now have both values
        expect(host.get('x')).toBe(1);
        expect(host.get('y')).toBe(2);
    }, 30000);

    // ========================================================================
    // Test 3: Concurrent Writes Converge (Simplified Fuzz Test)
    // ========================================================================
    it('converges under concurrent writes from multiple peers', async () => {
        const clientCount = 3;

        // Create engines - all stay connected
        for (let i = 0; i < clientCount; i++) {
            const peerId = `00000000-0000-0000-0000-0000000003${i.toString().padStart(2, '0')}`;
            const engine = new SyncEngine('00000000-0000-0000-0000-000000000003', peerId, 1000, false);
            await engine.boot();
            network.register(peerId, engine);
            engines.push(engine);
        }

        // Each peer writes to different keys concurrently
        const deltas: Uint8Array[] = [];
        deltas.push(engines[0].set('key_a', 'from_peer_0'));
        deltas.push(engines[1].set('key_b', 'from_peer_1'));
        deltas.push(engines[2].set('key_c', 'from_peer_2'));

        // Broadcast all deltas
        for (let i = 0; i < clientCount; i++) {
            const peerId = `00000000-0000-0000-0000-0000000003${i.toString().padStart(2, '0')}`;
            network.broadcast(peerId, deltas[i]);
        }

        // Settle
        network.flush();
        await new Promise(r => setTimeout(r, 100));

        // All peers should have all keys
        for (const engine of engines) {
            expect(engine.get('key_a')).toBe('from_peer_0');
            expect(engine.get('key_b')).toBe('from_peer_1');
            expect(engine.get('key_c')).toBe('from_peer_2');
        }
    }, 30000);
});
