import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NMeshedClient } from './client';
import { MockWasmCore } from './test-utils/mocks';

// Mock the WASM core before anything else boots
vi.mock('./wasm/nmeshed_core', () => {
    return {
        NMeshedClientCore: class {
            constructor() { return new MockWasmCore(''); }
        },
        default: vi.fn().mockResolvedValue({})
    };
});

// Mock transport to behave like a real EventEmitter
vi.mock('./transport/WebSocketTransport', async () => {
    const { EventEmitter } = await import('./utils/EventEmitter');
    return {
        WebSocketTransport: class extends EventEmitter<any> {
            public config = {};
            constructor() { super(); }
            connect = vi.fn().mockResolvedValue(undefined);
            send = vi.fn();
            sendEphemeral = vi.fn();
            broadcast = vi.fn();
            ping = vi.fn().mockResolvedValue(10);
            getPeers = vi.fn().mockReturnValue([]);
            disconnect = vi.fn();
            simulateLatency = vi.fn();
            simulatePacketLoss = vi.fn();
        }
    };
});

describe('NMeshedClient Authority API', () => {
    let client: NMeshedClient;

    beforeEach(async () => {
        vi.clearAllMocks();
        client = new NMeshedClient({
            workspaceId: 'test-ws',
            apiKey: 'test-key',
            userId: 'local-peer'
        });
        // We don't connect(), but we need the engine to be booted for some checks
        // Engine boots in constructor, so we are good.
    });

    it('should determine authority correctly with a single peer', () => {
        // With only one peer (self), I should be authority for everything
        expect(client.isAuthority('any-key')).toBe(true);
        expect(client.isAuthority('another-key')).toBe(true);
    });

    it('should redistribute authority when peers join', () => {
        // Peer join triggers recalculateAuthority
        (client as any).authorityRing.addNode('peer-2');
        (client as any).recalculateAuthority();

        // Statistical distribution check
        const keys = Array.from({ length: 20 }, (_, i) => `key-${i}`);
        const myAuthorityCount = keys.filter(k => client.isAuthority(k)).length;

        // With 2 peers, I should have roughly half
        expect(myAuthorityCount).toBeGreaterThan(0);
        expect(myAuthorityCount).toBeLessThan(20);
    });

    it('should fire onBecomeAuthority when ownership shifts to me', () => {
        const handler = vi.fn();
        client.onBecomeAuthority('boss:*', handler);

        // Simulate a message for a new key
        // This should trigger becomeAuthority because it's the first time we see this key
        (client as any).transport.emit('ephemeral', {
            type: 'op',
            payload: { key: 'boss:1', value: { x: 100 }, timestamp: Date.now() }
        });

        expect(handler).toHaveBeenCalledWith('boss:1');
    });

    it('should fire onLoseAuthority when others take over', () => {
        const loseHandler = vi.fn();

        // Set up initial state with one key I own
        (client as any).engine.core.state['task:1'] = {};

        // Become authority listener will fire immediately for existing keys I own
        client.onBecomeAuthority('task:*', () => { });
        client.onLoseAuthority('task:*', loseHandler);

        expect(client.isAuthority('task:1')).toBe(true);

        // Now a "superior" peer joins that takes this key
        // We force the ring to give it to peer-X
        const ring = (client as any).authorityRing;
        vi.spyOn(ring, 'getNode').mockReturnValue('peer-X');

        (client as any).recalculateAuthority();

        expect(loseHandler).toHaveBeenCalledWith('task:1');
    });
});
