/**
 * P2P vs Server (Star) Architecture Benchmark
 * 
 * Compares the cost characteristics of:
 * 1. Star Topology (all messages through central server)
 * 2. P2P Mesh Topology (direct peer-to-peer communication)
 * 
 * Metrics:
 * - Server bandwidth: Total bytes the server must process
 * - Server message count: Total messages the server must handle
 * - Database writes: Number of persistence operations
 * - Client-to-client latency: Time from send to receive
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';

// Simulation Parameters
const CLIENT_COUNT = 7;
const TICKS = 200;
const AVG_MESSAGE_SIZE_BYTES = 144; // From observed WirePacket sizes

interface TopologyMetrics {
    serverMessagesSent: number;
    serverMessagesReceived: number;
    serverBytesProcessed: number;
    databaseWrites: number;
    clientToClientMessages: number;
    avgLatencyMs: number;
}

describe('Architecture Cost Comparison', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('Benchmark: Star Topology (Server-Mediated)', () => {
        /**
         * STAR TOPOLOGY:
         * - Every client update goes TO server
         * - Server broadcasts TO all other clients
         * - Server writes every update to DB (for persistence)
         * 
         * For N clients and M updates:
         * - Server receives: M messages (one per update)
         * - Server sends: M × (N-1) messages (broadcast to all peers)
         * - Server DB writes: M (each update is persisted)
         * - Server bytes: M × (1 + (N-1)) × message_size
         */
        const metrics: TopologyMetrics = {
            serverMessagesSent: 0,
            serverMessagesReceived: 0,
            serverBytesProcessed: 0,
            databaseWrites: 0,
            clientToClientMessages: 0,
            avgLatencyMs: 0,
        };

        // Simulate 200 updates across 7 users
        for (let tick = 0; tick < TICKS; tick++) {
            // Each tick: one random client sends one update
            metrics.serverMessagesReceived += 1;
            metrics.serverBytesProcessed += AVG_MESSAGE_SIZE_BYTES;

            // Server broadcasts to N-1 other clients
            metrics.serverMessagesSent += (CLIENT_COUNT - 1);
            metrics.serverBytesProcessed += AVG_MESSAGE_SIZE_BYTES * (CLIENT_COUNT - 1);

            // Server writes to DB
            metrics.databaseWrites += 1;
        }

        // Latency: client -> server -> DB -> broadcast -> peer
        // Typical: 5ms (upload) + 1ms (DB) + 5ms (download) = ~11ms
        metrics.avgLatencyMs = 11;

        console.log('\n=== STAR TOPOLOGY (Server-Mediated) ===');
        console.log(`Clients: ${CLIENT_COUNT}`);
        console.log(`Updates: ${TICKS}`);
        console.log(`---`);
        console.log(`Server Messages IN: ${metrics.serverMessagesReceived}`);
        console.log(`Server Messages OUT: ${metrics.serverMessagesSent}`);
        console.log(`Server Total Messages: ${metrics.serverMessagesReceived + metrics.serverMessagesSent}`);
        console.log(`Server Bytes: ${(metrics.serverBytesProcessed / 1024).toFixed(2)} KB`);
        console.log(`Database Writes: ${metrics.databaseWrites}`);
        console.log(`Avg Latency: ${metrics.avgLatencyMs} ms`);

        // Store for comparison
        (globalThis as any).__starMetrics = metrics;

        expect(metrics.serverMessagesReceived).toBe(200);
        expect(metrics.serverMessagesSent).toBe(200 * 6); // Broadcast to 6 peers
        expect(metrics.databaseWrites).toBe(200);
    });

    it('Benchmark: P2P Mesh Topology', () => {
        /**
         * P2P MESH TOPOLOGY:
         * - Updates are broadcast directly to peers via WebRTC DataChannel
         * - Server ONLY handles:
         *   1. Signaling (WebRTC connection setup) - one-time per connection pair
         *   2. Presence (join/leave notifications)
         *   3. Initial sync snapshot (on join)
         * 
         * For N clients and M updates:
         * - Server messages: ~O(N²) signaling at setup, then minimal
         * - Server bytes: Signaling + occasional persistence checkpoints
         * - P2P messages: M × (N-1) (each peer sends directly to all others)
         * - DB writes: Periodic checkpoints only (e.g., every 10s or on disconnect)
         */
        const metrics: TopologyMetrics = {
            serverMessagesSent: 0,
            serverMessagesReceived: 0,
            serverBytesProcessed: 0,
            databaseWrites: 0,
            clientToClientMessages: 0,
            avgLatencyMs: 0,
        };

        // SIGNALING PHASE (one-time setup)
        // Each client establishes connections to all others: N × (N-1) / 2 pairs
        // Each connection requires ~4 signaling messages (offer, answer, ice, ice)
        const connectionPairs = (CLIENT_COUNT * (CLIENT_COUNT - 1)) / 2;
        const signalingMessagesPerPair = 4;
        const signalingMessageSize = 500; // SDP is larger than data

        metrics.serverMessagesReceived += connectionPairs * signalingMessagesPerPair;
        metrics.serverMessagesSent += connectionPairs * signalingMessagesPerPair;
        metrics.serverBytesProcessed += connectionPairs * signalingMessagesPerPair * signalingMessageSize * 2;

        // INITIAL SYNC (new joiner gets snapshot from one peer or server)
        // 7 clients = 7 initial syncs
        const snapshotSize = 2048; // Typical initial snapshot
        metrics.serverMessagesReceived += CLIENT_COUNT; // Join requests
        metrics.serverMessagesSent += CLIENT_COUNT; // Snapshots
        metrics.serverBytesProcessed += CLIENT_COUNT * snapshotSize;

        // STEADY STATE: P2P direct messaging (server NOT involved)
        for (let tick = 0; tick < TICKS; tick++) {
            // Each update goes directly to N-1 peers via WebRTC
            metrics.clientToClientMessages += (CLIENT_COUNT - 1);
            // Server NOT involved in data path
        }

        // DB WRITES: Only on periodic checkpoints or disconnect
        // Assume checkpoint every 50 ticks + final save
        const checkpointInterval = 50;
        metrics.databaseWrites = Math.floor(TICKS / checkpointInterval) + CLIENT_COUNT;

        // Latency: client -> peer (direct RTT, no server hop)
        // Typical: 2-5ms for LAN, 10-30ms for internet
        metrics.avgLatencyMs = 5;

        console.log('\n=== P2P MESH TOPOLOGY ===');
        console.log(`Clients: ${CLIENT_COUNT}`);
        console.log(`Updates: ${TICKS}`);
        console.log(`Signaling Pairs: ${connectionPairs}`);
        console.log(`---`);
        console.log(`Server Messages (Signaling): ${metrics.serverMessagesReceived + metrics.serverMessagesSent}`);
        console.log(`Server Bytes: ${(metrics.serverBytesProcessed / 1024).toFixed(2)} KB`);
        console.log(`Database Writes: ${metrics.databaseWrites}`);
        console.log(`P2P Messages (Client-to-Client): ${metrics.clientToClientMessages}`);
        console.log(`Avg Latency: ${metrics.avgLatencyMs} ms`);

        // Store for comparison
        (globalThis as any).__p2pMetrics = metrics;

        expect(metrics.databaseWrites).toBeLessThan(50); // Way fewer than 200
    });

    it('Summary: Cost Savings Analysis', () => {
        const star = (globalThis as any).__starMetrics as TopologyMetrics;
        const p2p = (globalThis as any).__p2pMetrics as TopologyMetrics;

        const serverMessagesSavings =
            ((star.serverMessagesReceived + star.serverMessagesSent) -
                (p2p.serverMessagesReceived + p2p.serverMessagesSent)) /
            (star.serverMessagesReceived + star.serverMessagesSent) * 100;

        const serverBytesSavings =
            (star.serverBytesProcessed - p2p.serverBytesProcessed) /
            star.serverBytesProcessed * 100;

        const dbWritesSavings =
            (star.databaseWrites - p2p.databaseWrites) /
            star.databaseWrites * 100;

        console.log('\n=========================================');
        console.log('       P2P vs SERVER COST ANALYSIS       ');
        console.log('=========================================');
        console.log(`Scenario: ${CLIENT_COUNT} users, ${TICKS} updates`);
        console.log('');
        console.log('| Metric                | Star   | P2P    | Savings |');
        console.log('|-----------------------|--------|--------|---------|');
        console.log(`| Server Messages       | ${(star.serverMessagesReceived + star.serverMessagesSent).toString().padStart(6)} | ${(p2p.serverMessagesReceived + p2p.serverMessagesSent).toString().padStart(6)} | ${serverMessagesSavings.toFixed(0)}%    |`);
        console.log(`| Server Bandwidth (KB) | ${(star.serverBytesProcessed / 1024).toFixed(1).padStart(6)} | ${(p2p.serverBytesProcessed / 1024).toFixed(1).padStart(6)} | ${serverBytesSavings.toFixed(0)}%    |`);
        console.log(`| Database Writes       | ${star.databaseWrites.toString().padStart(6)} | ${p2p.databaseWrites.toString().padStart(6)} | ${dbWritesSavings.toFixed(0)}%    |`);
        console.log(`| Avg Latency (ms)      | ${star.avgLatencyMs.toString().padStart(6)} | ${p2p.avgLatencyMs.toString().padStart(6)} | ${((star.avgLatencyMs - p2p.avgLatencyMs) / star.avgLatencyMs * 100).toFixed(0)}%    |`);
        console.log('');
        console.log('KEY INSIGHT:');
        console.log(`  P2P reduces server load by ~${serverMessagesSavings.toFixed(0)}% for steady-state ops.`);
        console.log(`  Cost impact: At scale (1000 rooms × 7 users), P2P saves:`);
        console.log(`    - ${((star.serverBytesProcessed - p2p.serverBytesProcessed) * 1000 / 1024 / 1024).toFixed(1)} MB/session in bandwidth`);
        console.log(`    - ${((star.databaseWrites - p2p.databaseWrites) * 1000).toLocaleString()} fewer DB writes/session`);
        console.log('');

        // Assertions
        expect(serverMessagesSavings).toBeGreaterThan(85); // >85% fewer server messages
        expect(dbWritesSavings).toBeGreaterThan(80); // >80% fewer DB writes
    });
});
