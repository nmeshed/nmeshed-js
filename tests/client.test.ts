/**
 * NMeshed v2 - Client Unit Tests (Refactored for Testability)
 * 
 * Uses Dependency Injection (Transport + Jitter) for deterministic testing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { encode } from '@msgpack/msgpack';
import { NMeshedClient } from '../src/client';
import { MsgType, encodeOp, encodeInit, encodePong, decodeMessage, encodeValue } from '../src/protocol';
import { InMemoryAdapter } from '../src/adapters/InMemoryAdapter';
import type { Transport } from '../src/types';

// =============================================================================
// Test Infrastructure
// =============================================================================

class TestTransport implements Transport {
    public sent: Uint8Array[] = [];
    public messageHandler: ((data: Uint8Array) => void) | null = null;
    public openHandler: (() => void) | null = null;
    public closeHandler: (() => void) | null = null;
    public connected = false;

    async connect() {
        this.connected = true;
        // Simulate immediate connection or manual trigger
        setTimeout(() => {
            if (this.openHandler && this.connected) this.openHandler();
        }, 0);
    }

    disconnect() {
        this.connected = false;
        if (this.closeHandler) this.closeHandler();
    }

    async reconnect() {
        this.disconnect();
        await this.connect();
    }

    send(data: Uint8Array) {
        this.sent.push(data);
    }

    onMessage(handler: (data: Uint8Array) => void) {
        this.messageHandler = handler;
        return () => { this.messageHandler = null; };
    }

    onOpen(handler: () => void) {
        this.openHandler = handler;
        return () => { this.openHandler = null; };
    }

    onClose(handler: () => void) {
        this.closeHandler = handler;
        return () => { this.closeHandler = null; };
    }

    isConnected() {
        return this.connected;
    }

    // --- Test Helpers ---

    simulateMessage(data: Uint8Array) {
        if (this.messageHandler) {
            this.messageHandler(data);
        }
    }

    getLastSentType(): MsgType | undefined {
        const last = this.sent[this.sent.length - 1];
        if (!last) return undefined;
        try {
            const decoded = decodeMessage(last);
            return decoded?.type;
        } catch {
            return undefined;
        }
    }
}

describe('NMeshedClient (Refactored)', () => {
    let transport: TestTransport;
    let client: NMeshedClient;

    beforeEach(() => {
        // Use Real Timers by default, unless specific test needs to control time
        vi.useRealTimers();
        transport = new TestTransport();
    });

    afterEach(() => {
        if (client) client.disconnect();
        vi.restoreAllMocks();
    });

    const createConfig = (overrides = {}) => ({
        workspaceId: 'test',
        token: 'token',
        connectJitter: 0, // Deterministic!
        transport: transport, // Injected!
        storage: new InMemoryAdapter(),
        ...overrides
    });

    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const waitFor = async (condition: () => boolean | Promise<boolean>, timeout = 1000) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (await condition()) return;
            await new Promise(r => setTimeout(r, 10));
        }
        throw new Error('Timeout waiting for condition');
    };

    it('should initialize and connect immediately (jitter=0)', async () => {
        client = new NMeshedClient(createConfig());
        // Init is async, wait for transport connection
        await waitFor(() => transport.connected);
        expect(transport.connected).toBe(true);
        expect(client.getStatus()).toMatch(/syncing|connected|ready/);
    });

    it('should handle Init message and transition to ready', async () => {
        client = new NMeshedClient(createConfig());
        await waitFor(() => transport.connected);

        // Client is syncing. Send Init.
        const snapshot = { key1: 'value1' };
        const msg = encodeInit(encode(snapshot));
        transport.simulateMessage(msg);

        // Wait for Ready
        await waitFor(() => client.getStatus() === 'ready');

        expect(client.getStatus()).toBe('ready');
        expect(client.get('key1')).toBe('value1');
    });

    it('should emit status events', async () => {
        client = new NMeshedClient(createConfig());
        const statusSpy = vi.fn();
        client.on('status', statusSpy);

        await waitFor(() => transport.connected);

        // Initial state transition sequence might be captured
        expect(statusSpy).toHaveBeenCalledWith(expect.stringMatching(/syncing|connected/));

        // Send Init -> Ready
        transport.simulateMessage(encodeInit(encode({})));
        await waitFor(() => client.getStatus() === 'ready');

        expect(statusSpy).toHaveBeenCalledWith('ready');
    });

    it('should handle remote Op message', async () => {
        client = new NMeshedClient(createConfig());
        const opSpy = vi.fn();
        client.on('op', opSpy);

        await waitFor(() => transport.connected);

        // Send Init to make ready
        transport.simulateMessage(encodeInit(encode({})));
        await waitFor(() => client.getStatus() === 'ready');

        const msg = encodeOp('remote-key', encode('remote-val'));
        transport.simulateMessage(msg);

        await waitFor(() => opSpy.mock.calls.length > 0);

        // Relaxed assertion: don't check trailing undefineds
        expect(opSpy).toHaveBeenCalledWith('remote-key', 'remote-val', false, expect.anything());
        expect(client.get('remote-key')).toBe('remote-val');
    });

    it('should send pings periodically', async () => {
        vi.useFakeTimers(); // Control time for this test
        transport = new TestTransport();

        client = new NMeshedClient({
            ...createConfig(),
            transport // Reuse injected transport
        });

        // Init uses setTimeout to yield, so advance to run init
        await vi.advanceTimersByTimeAsync(10);

        // Transport connect also has setTimeout(0) for openHandler
        await vi.advanceTimersByTimeAsync(10);

        expect(transport.connected).toBe(true);

        // Start heartbeat logic is inside transport onOpen
        // Advance 30s
        await vi.advanceTimersByTimeAsync(30000);

        // It might need multiple ticks
        await vi.advanceTimersByTimeAsync(100);

        expect(transport.getLastSentType()).toBe(MsgType.Ping);

        client.disconnect();
        vi.useRealTimers();
    });

    it('should update clock on Pong', async () => {
        client = new NMeshedClient(createConfig());
        await waitFor(() => transport.connected);

        const engineSpy = vi.spyOn((client as any).engine, 'setClockOffset');
        const futureTime = Date.now() + 5000;

        transport.simulateMessage(encodePong(futureTime));

        await waitFor(() => engineSpy.mock.calls.length > 0);

        const callArgs = engineSpy.mock.calls[0];
        const offset = callArgs[0] as number;

        // Expect offset roughly 5000ms
        expect(offset).toBeGreaterThan(4000);
        expect(offset).toBeLessThan(6000);
    });

    // --- Regression Tests ---

    it('should handle garbage gracefully', async () => {
        client = new NMeshedClient(createConfig());
        await waitFor(() => transport.connected);

        const garbage = new Uint8Array([0xFF, 0x00]);
        transport.simulateMessage(garbage);

        // Should not crash
        await wait(10);
        expect(client.getStatus()).not.toBe('error');
    });

    // --- Coverage for Config/Errors ---

    it('should throw if workspaceId missing', () => {
        expect(() => new NMeshedClient({} as any)).toThrow('workspaceId');
    });

    it('should fallback to InMemory if storage init fails', async () => {
        const badStorage = {
            init: vi.fn().mockRejectedValue(new Error('Fail')),
            get: vi.fn(), set: vi.fn(), delete: vi.fn(), scanPrefix: vi.fn(), clear: vi.fn(), clearAll: vi.fn(), close: vi.fn()
        };
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        client = new NMeshedClient({
            ...createConfig(),
            storage: badStorage,
            debug: true // Enable logging
        });

        await waitFor(() => transport.connected, 2000);

        // Expect prefixed log
        expect(logSpy).toHaveBeenCalledWith('[NMeshed Client]', expect.stringContaining('failed'), expect.anything());
        logSpy.mockRestore();
    });
});
