/**
 * NMeshed v2 - Client Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NMeshedClient } from '../src/client';
import { MsgType } from '../src/protocol';

// Store last created WebSocket instance for message simulation
let lastWebSocket: MockWebSocket | null = null;

// Mock WebSocket
class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.OPEN;
    binaryType = 'arraybuffer';
    url: string;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(url: string) {
        this.url = url;
        lastWebSocket = this;
        // Simulate connection
        setTimeout(() => {
            this.readyState = MockWebSocket.OPEN;
            this.onopen?.();
        }, 0);
    }

    send = vi.fn();
    close = vi.fn(() => {
        this.readyState = MockWebSocket.CLOSED;
        setTimeout(() => this.onclose?.(), 0);
    });

    // Helper to simulate receiving a message
    simulateMessage(data: Uint8Array) {
        this.onmessage?.({ data: data.buffer });
    }
}

vi.stubGlobal('WebSocket', MockWebSocket);

describe('NMeshedClient', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        lastWebSocket = null;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('constructor', () => {
        it('should require workspaceId', () => {
            expect(() => new NMeshedClient({ workspaceId: '' } as any)).toThrow('workspaceId is required');
        });

        it('should require token or apiKey', () => {
            expect(() => new NMeshedClient({ workspaceId: 'test' } as any)).toThrow('token or apiKey is required');
        });

        it('should create client with valid config', () => {
            const client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            vi.advanceTimersByTime(100);
            expect(client).toBeDefined();
            expect(client.getPeerId()).toBeDefined();
            client.disconnect();
        });

        it('should use apiKey as alternative to token', () => {
            const client = new NMeshedClient({ workspaceId: 'test', apiKey: 'api-key-123' });
            vi.advanceTimersByTime(100);
            expect(client).toBeDefined();
            client.disconnect();
        });

        it('should use userId if provided', () => {
            const client = new NMeshedClient({
                workspaceId: 'test',
                token: 'token',
                userId: 'custom-user-id',
            });
            vi.advanceTimersByTime(100);
            expect(client.getPeerId()).toBe('custom-user-id');
            client.disconnect();
        });

        it('should generate peerId if userId not provided', () => {
            const client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            vi.advanceTimersByTime(100);
            expect(client.getPeerId()).toMatch(/^peer_[a-z0-9]+$/);
            client.disconnect();
        });

        it('should enable debug mode', () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
            const client = new NMeshedClient({
                workspaceId: 'test',
                token: 'token',
                debug: true,
            });
            vi.advanceTimersByTime(100);
            client.set('key', 'value');
            client.disconnect();
            consoleSpy.mockRestore();
        });
    });

    describe('get/set', () => {
        let client: NMeshedClient;

        beforeEach(() => {
            client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            vi.advanceTimersByTime(100);
        });

        afterEach(() => {
            client.disconnect();
        });

        it('should set and get values', () => {
            client.set('key', 'value');
            expect(client.get('key')).toBe('value');
        });

        it('should delete values (set to null tombstone)', () => {
            client.set('key', 'value');
            client.delete('key');
            expect(client.get('key')).toBeNull();
        });

        it('should handle complex values', () => {
            const value = { nested: { data: [1, 2, 3] } };
            client.set('complex', value);
            expect(client.get('complex')).toEqual(value);
        });

        it('should send data over WebSocket when connected', () => {
            client.set('key', 'value');
            expect(lastWebSocket?.send).toHaveBeenCalled();
        });
    });

    describe('events', () => {
        let client: NMeshedClient;

        beforeEach(() => {
            client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            vi.advanceTimersByTime(100);
        });

        afterEach(() => {
            client.disconnect();
        });

        it('should emit op events', () => {
            const handler = vi.fn();
            client.on('op', handler);

            client.set('key', 'value');

            expect(handler).toHaveBeenCalledWith('key', 'value', true);
        });

        it('should return unsubscribe function', () => {
            const handler = vi.fn();
            const unsub = client.on('op', handler);

            unsub();
            client.set('key', 'value');

            expect(handler).not.toHaveBeenCalled();
        });

        it('should emit status events on status change', () => {
            const handler = vi.fn();
            client.on('status', handler);

            // Trigger a message that changes status
            const snapshot = { test: 'data' };
            const snapshotBytes = new TextEncoder().encode(JSON.stringify(snapshot));
            const msg = new Uint8Array([0, ...snapshotBytes]); // MsgType.Init = 0
            lastWebSocket?.simulateMessage(msg);

            // Now status should have changed to 'ready'
            expect(handler).toHaveBeenCalled();
        });
    });

    describe('status', () => {
        it('should return current status', () => {
            const client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            vi.advanceTimersByTime(100);

            // After connection, status should be 'connected' or later
            const status = client.getStatus();
            expect(['connecting', 'connected', 'syncing', 'ready']).toContain(status);

            client.disconnect();
        });
    });

    describe('getAllValues / forEach', () => {
        let client: NMeshedClient;

        beforeEach(() => {
            client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            vi.advanceTimersByTime(100);
        });

        afterEach(() => {
            client.disconnect();
        });

        it('should return all values', () => {
            client.set('a', 1);
            client.set('b', 2);

            const values = client.getAllValues();

            expect(values).toEqual({ a: 1, b: 2 });
        });

        it('should iterate over all entries with forEach', () => {
            client.set('x', 'y');
            client.set('z', 123);

            const entries: [string, unknown][] = [];
            client.forEach((value, key) => entries.push([key, value]));

            expect(entries).toContainEqual(['x', 'y']);
            expect(entries).toContainEqual(['z', 123]);
        });
    });

    describe('awaitReady', () => {
        it('should resolve immediately if already ready', async () => {
            const client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            vi.advanceTimersByTime(100);

            // Simulate INIT message to trigger ready
            if (lastWebSocket) {
                const snapshot = { existing: 'data' };
                const snapshotBytes = new TextEncoder().encode(JSON.stringify(snapshot));
                const msg = new Uint8Array([MsgType.Init, ...snapshotBytes]);
                lastWebSocket.simulateMessage(msg);
            }
            vi.advanceTimersByTime(10);

            // Now awaitReady should resolve quickly
            const promise = client.awaitReady();
            vi.advanceTimersByTime(10);
            await promise;

            expect(client.getStatus()).toBe('ready');
            client.disconnect();
        });

        it('should wait for ready when not yet ready', async () => {
            const client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            vi.advanceTimersByTime(100);

            // Client is connected but not ready (no Init message yet)
            expect(client.getStatus()).not.toBe('ready');

            // Start waiting for ready
            let resolved = false;
            const promise = client.awaitReady().then(() => {
                resolved = true;
            });

            // Should not be resolved yet
            await vi.advanceTimersByTimeAsync(10);
            expect(resolved).toBe(false);

            // Now simulate Init to trigger ready
            if (lastWebSocket) {
                const snapshot = { data: 'test' };
                const snapshotBytes = new TextEncoder().encode(JSON.stringify(snapshot));
                const msg = new Uint8Array([MsgType.Init, ...snapshotBytes]);
                lastWebSocket.simulateMessage(msg);
            }

            // Flush microtasks and timers
            await vi.advanceTimersByTimeAsync(10);
            await promise;

            expect(resolved).toBe(true);
            expect(client.getStatus()).toBe('ready');
            client.disconnect();
        });
    });

    describe('handleMessage', () => {
        let client: NMeshedClient;

        beforeEach(() => {
            client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            vi.advanceTimersByTime(100);
        });

        afterEach(() => {
            client.disconnect();
        });

        it('should handle Init message', () => {
            const readyHandler = vi.fn();
            client.on('ready', readyHandler);

            // Simulate Init message
            const snapshot = { key1: 'value1' };
            const snapshotBytes = new TextEncoder().encode(JSON.stringify(snapshot));
            const msg = new Uint8Array([MsgType.Init, ...snapshotBytes]);
            lastWebSocket?.simulateMessage(msg);

            expect(readyHandler).toHaveBeenCalled();
            expect(client.get('key1')).toBe('value1');
        });

        it('should handle Op message', () => {
            const opHandler = vi.fn();
            client.on('op', opHandler);

            // Format: [type, keyLen, key..., payload...]
            const key = 'remoteKey';
            const payload = new TextEncoder().encode(JSON.stringify('remoteValue'));
            const msg = new Uint8Array([
                MsgType.Op,
                key.length,
                ...new TextEncoder().encode(key),
                ...payload,
            ]);
            lastWebSocket?.simulateMessage(msg);

            expect(opHandler).toHaveBeenCalledWith('remoteKey', 'remoteValue', false);
        });

        it('should handle Ack message', () => {
            // Set a value to create pending op
            client.set('key', 'value');

            // Simulate Ack
            const msg = new Uint8Array([MsgType.Ack]);
            lastWebSocket?.simulateMessage(msg);

            // Pending should be cleared (internal state)
        });

        it('should handle Presence message', () => {
            const peerHandler = vi.fn();
            client.on('peerJoin', peerHandler);

            // Simulate Presence
            const peerId = 'new-peer-123';
            const msg = new Uint8Array([
                MsgType.Presence,
                ...new TextEncoder().encode(peerId),
            ]);
            lastWebSocket?.simulateMessage(msg);

            expect(peerHandler).toHaveBeenCalledWith(peerId);
        });
    });

    describe('disconnect', () => {
        it('should disconnect cleanly', () => {
            const client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            vi.advanceTimersByTime(100);

            client.disconnect();
            vi.advanceTimersByTime(100);

            expect(lastWebSocket?.close).toHaveBeenCalled();
        });
    });

    describe('connection error handling', () => {
        it('should handle disconnect and reconnect', () => {
            const client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            vi.advanceTimersByTime(100);

            // Simulate close event
            lastWebSocket?.close();
            vi.advanceTimersByTime(100);

            // Client should be in reconnecting state or attempting to reconnect
            expect(['reconnecting', 'connecting', 'connected']).toContain(client.getStatus());
            client.disconnect();
        });

        it('should handle connection errors gracefully', () => {
            // Create a WebSocket that fails to connect
            class FailingWebSocket {
                static CONNECTING = 0;
                static OPEN = 1;
                static CLOSING = 2;
                static CLOSED = 3;

                readyState = FailingWebSocket.CONNECTING;
                binaryType = 'arraybuffer';
                url: string;
                onopen: (() => void) | null = null;
                onclose: (() => void) | null = null;
                onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
                onerror: ((event: Event) => void) | null = null;

                constructor(url: string) {
                    this.url = url;
                    // Simulate failed connection
                    setTimeout(() => {
                        this.onerror?.(new Event('error'));
                    }, 10);
                }

                send = vi.fn();
                close = vi.fn();
            }

            vi.stubGlobal('WebSocket', FailingWebSocket);

            const client = new NMeshedClient({ workspaceId: 'test', token: 'token' });
            const errorHandler = vi.fn();
            client.on('error', errorHandler);

            vi.advanceTimersByTime(100);

            // The client should handle the error - status may be error, connecting, or reconnecting
            expect(['error', 'connecting', 'reconnecting']).toContain(client.getStatus());

            client.disconnect();

            // Restore original mock
            vi.stubGlobal('WebSocket', MockWebSocket);
        });
    });

    describe('debug logging', () => {
        it('should log when debug is enabled', () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

            const client = new NMeshedClient({
                workspaceId: 'test',
                token: 'token',
                debug: true,
            });
            vi.advanceTimersByTime(100);

            // Set a value to trigger logging
            client.set('key', 'value');

            // Check for Client-specific logs
            const clientLogs = consoleSpy.mock.calls.filter(
                call => call[0]?.includes?.('[NMeshed')
            );
            // There should be some logs from debug mode
            expect(clientLogs.length).toBeGreaterThan(0);

            client.disconnect();
            consoleSpy.mockRestore();
        });
    });
});
