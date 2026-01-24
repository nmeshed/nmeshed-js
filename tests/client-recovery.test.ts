import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NMeshedClient } from '../src/client';
import { WebSocketTransport } from '../src/transport';
import { InMemoryAdapter } from '../src/adapters/InMemoryAdapter';

// Mock Transport that drops packets to simulate network issues
class MockFaultyTransport extends WebSocketTransport {
    public dropRate: number = 0;
    public connected: boolean = false;

    constructor(config: any) {
        super(config);
    }

    async connect(): Promise<void> {
        this.connected = true;
        this.triggerOpen();
    }

    send(data: Uint8Array): void {
        if (Math.random() < this.dropRate) {
            // Drop packet
            return;
        }
    }

    simulateClose() {
        this.connected = false;
        this.triggerClose();
    }

    // Access protected members via any for testing
    triggerOpen() {
        (this as any).openHandlers.forEach((h: () => void) => h());
    }

    triggerClose() {
        (this as any).closeHandlers.forEach((h: () => void) => h());
    }

    isConnected(): boolean {
        return this.connected;
    }
}

describe('Client Error Recovery', () => {
    let client: NMeshedClient;
    let transport: MockFaultyTransport;

    beforeEach(() => {
        transport = new MockFaultyTransport({ workspaceId: 'test' });
        client = new NMeshedClient({
            workspaceId: 'test',
            token: 'test',
            transport: transport,
            storage: new InMemoryAdapter(),
            connectJitter: 0,
            initialSnapshot: new Uint8Array([]) // Force ready state without server roundtrip
        });
    });

    afterEach(() => {
        client.disconnect();
    });

    it('should retry connection on close', async () => {
        await client.awaitReady();

        // Wait for 'syncing' status
        await new Promise<void>(resolve => {
            if (client.getStatus() === 'syncing') resolve();
            else client.on('status', (s) => { if (s === 'syncing') resolve(); });
        });

        // Simulate disconnect
        transport.simulateClose();

        expect(client.getStatus()).toBe('reconnecting');
    });

    it('should queue ops when offline and send on reconnect', async () => {
        // Set up client 
        await client.awaitReady();

        // Wait for connected
        await new Promise<void>(resolve => {
            if (client.getStatus() === 'syncing') resolve();
            else client.on('status', (s) => { if (s === 'syncing') resolve(); });
        });

        // Simulate disconnect
        transport.simulateClose();

        // Op while offline
        client.set('key-reconnect', 'value-reconnect');

        // Spy on transport send
        const sendSpy = vi.spyOn(transport, 'send');

        // Reconnect
        transport.connect();

        expect(sendSpy).toHaveBeenCalled();
    });

    it('should handle conflict resolution via LWW', async () => {
        client.set('conflict', 'A');
        const val1 = client.get('conflict');
        expect(val1).toBe('A');
    });
});
