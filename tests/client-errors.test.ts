
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NMeshedClient } from '../src/client';
import { InMemoryAdapter } from '../src/adapters/InMemoryAdapter';
import { SyncEngine } from '../src/engine';

// Mock dependencies
vi.mock('../src/transport', () => {
    class WebSocketTransport {
        connect = vi.fn().mockResolvedValue(undefined);
        disconnect = vi.fn();
        onMessage = vi.fn(() => () => { });
        onOpen = vi.fn(() => () => { });
        onClose = vi.fn(() => () => { });
        send = vi.fn();
        isConnected = vi.fn(() => true);
    }
    return { WebSocketTransport };
});

describe('Client Error Handling', () => {
    let client: NMeshedClient;
    // We need to spy on console.error
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

    beforeEach(() => {
        vi.clearAllMocks();
        client = new NMeshedClient({
            workspaceId: 'test-ws',
            token: 'test-token',
            storage: new InMemoryAdapter()
        });
    });

    it('should catch errors during set operation', async () => {
        // Access private engine to force failure
        const engine = (client as any).engine as SyncEngine;
        // Mock set to reject
        vi.spyOn(engine, 'set').mockImplementation(() => Promise.reject(new Error('Set Failed')));

        // Should not throw, but log error
        client.set('key', 'val');

        // Wait for async promise rejection handler
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(consoleErrorSpy).toHaveBeenCalledWith(
            expect.stringContaining('[NMeshed] Set operation failed'),
            expect.any(Error)
        );
    });

    it('should catch errors during delete operation', async () => {
        const engine = (client as any).engine as SyncEngine;
        vi.spyOn(engine, 'delete').mockImplementation(() => Promise.reject(new Error('Delete Failed')));

        client.delete('key');

        await new Promise(resolve => setTimeout(resolve, 0));

        expect(consoleErrorSpy).toHaveBeenCalledWith(
            expect.stringContaining('[NMeshed] Delete operation failed'),
            expect.any(Error)
        );
    });

    it('should handle storage initialization failure gracefully', async () => {
        // Create a failing adapter
        const failingStorage = new InMemoryAdapter();
        vi.spyOn(failingStorage, 'init').mockRejectedValueOnce(new Error('Storage Init Failed'));

        // Initialize client with failing storage
        const brokenClient = new NMeshedClient({
            workspaceId: 'test-ws',
            token: 'test-token',
            storage: failingStorage,
            debug: true // Enable logging
        });

        // init is called async in constructor. Wait for it.
        await new Promise(resolve => setTimeout(resolve, 100)); // Slightly longer due to jitter

        // Should log error but NOT crash
        expect(consoleLogSpy).toHaveBeenCalledWith(
            '[NMeshed Client]',
            'Storage initialization failed',
            expect.any(Error)
        );
    });
});
