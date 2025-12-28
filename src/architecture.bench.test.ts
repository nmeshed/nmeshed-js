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

});
