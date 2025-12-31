import { vi } from 'vitest';

// Global reference to most recent socket
export let lastWebSocket: MockWebSocket | null = null;

export class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    binaryType = 'arraybuffer';
    url: string;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(url: string) {
        this.url = url;
        lastWebSocket = this;
        // Simulate async connection
        setTimeout(() => {
            if (this.readyState !== MockWebSocket.CLOSED) {
                this.readyState = MockWebSocket.OPEN;
                this.onopen?.();
            }
        }, 10);
    }

    send = vi.fn();

    close = vi.fn(() => {
        this.readyState = MockWebSocket.CLOSED;
        setTimeout(() => this.onclose?.(), 0);
    });

    // Helper to simulate receiving a message
    simulateMessage(data: Uint8Array) {
        if (this.readyState === MockWebSocket.OPEN) {
            this.onmessage?.({ data: data.buffer as ArrayBuffer });
        }
    }
}

export function setupMockWebSocket() {
    vi.stubGlobal('WebSocket', MockWebSocket);
    lastWebSocket = null;
}

export function teardownMockWebSocket() {
    vi.unstubAllGlobals();
    lastWebSocket = null;
}


// =============================================================================
// Mock Client Factory
// =============================================================================

import type { NMeshedClient } from '../src/client';
import type { Mocked } from 'vitest';

export function createMockClient(): Mocked<NMeshedClient> {
    return {
        // Public API
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        on: vi.fn(),
        getStatus: vi.fn(() => 'connected'),
        getPeerId: vi.fn(() => 'peer_test'),
        getAllValues: vi.fn(() => ({})),
        forEach: vi.fn(),
        awaitReady: vi.fn(),
        disconnect: vi.fn(),

        // Private properties (casted to satisfy TS if needed, or ignored via partial)
        // In strict TS, we might need to mock private fields if they are accessed, 
        // but for public API testing this is sufficient if we cast.
        config: {},
        engine: {},
        transport: {},
        debug: false,
        unsubscribers: [],

        // Private methods (needed if class structure is strict)
        connect: vi.fn(),
        wireTransport: vi.fn(),
        handleMessage: vi.fn(),
        generatePeerId: vi.fn(),
        log: vi.fn(),
    } as unknown as Mocked<NMeshedClient>;
}
