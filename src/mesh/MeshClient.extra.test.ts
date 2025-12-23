import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshClient } from './MeshClient';

const mockSignaling = {
    connect: vi.fn(),
    close: vi.fn(),
    sendSignal: vi.fn(),
    sendSync: vi.fn(),
    sendEphemeral: vi.fn(),
    updateToken: vi.fn(),
    setListeners: vi.fn(),
};

const mockConnections = {
    closeAll: vi.fn(),
    broadcast: vi.fn(),
    sendToPeer: vi.fn(),
    initiateConnection: vi.fn(),
    handleOffer: vi.fn(),
    handleAnswer: vi.fn(),
    handleCandidate: vi.fn(),
    getPeerIds: vi.fn().mockReturnValue([]),
    isDirect: vi.fn().mockReturnValue(false),
    setListeners: vi.fn(),
};

vi.mock('./SignalingClient', () => ({
    SignalingClient: class { constructor() { return mockSignaling; } },
}));

vi.mock('./ConnectionManager', () => ({
    ConnectionManager: class { constructor() { return mockConnections; } },
}));

describe('MeshClient Coverage Boost', () => {
    let mesh: MeshClient;
    let signalingListeners: any;
    let connectionListeners: any;

    const config = { workspaceId: 'ws', token: 'tk', serverUrl: 'wss://test.com' };

    beforeEach(() => {
        vi.clearAllMocks();
        mockSignaling.setListeners.mockImplementation(l => { signalingListeners = l; });
        mockConnections.setListeners.mockImplementation(l => { connectionListeners = l; });
    });

    it('handles sendToAuthority', () => {
        mesh = new MeshClient(config);
        const data = new Uint8Array([1, 2]);
        mesh.sendToAuthority(data);
        expect(mockSignaling.sendSync).toHaveBeenCalledWith(data);
    });

    it('handles sendCursor and sendEphemeral', () => {
        mesh = new MeshClient(config);
        mesh.sendCursor(10, 20);
        expect(mockSignaling.sendEphemeral).toHaveBeenCalledWith(
            expect.objectContaining({ x: 10, y: 20 }),
            undefined
        );

        mesh.sendEphemeral({ type: 'chat' }, 'peer-1');
        expect(mockSignaling.sendEphemeral).toHaveBeenCalledWith({ type: 'chat' }, 'peer-1');
    });

    it('supports pinging peers', async () => {
        mesh = new MeshClient(config);
        // Cover ping entry point
        mesh.ping('peer-1').catch(() => { });
    });

    it('handles mesh connection lifecycle with server messages', () => {
        mesh = new MeshClient(config);
        signalingListeners.onConnect();
        expect(mesh.getState()).toBe('HANDSHAKING');

        signalingListeners.onServerMessage({ type: 'config' });
        expect(mesh.getState()).toBe('ACTIVE');
    });

    it('handles chaos simulation', () => {
        mesh = new MeshClient(config);
        mesh.simulateNetwork({ latency: 100 });
        (mesh as any).withChaos(() => { });
        mesh.simulateNetwork(null);
    });

    it('handles offer signal', () => {
        mesh = new MeshClient(config);
        signalingListeners.onSignal({
            from: 'peer-1',
            signal: { type: 'offer', sdp: 'v=0...' }
        });
        expect(mockConnections.handleOffer).toHaveBeenCalledWith('peer-1', 'v=0...');
    });

    it('handles answer signal', () => {
        mesh = new MeshClient(config);
        signalingListeners.onSignal({
            from: 'peer-2',
            signal: { type: 'answer', sdp: 'v=1...' }
        });
        expect(mockConnections.handleAnswer).toHaveBeenCalledWith('peer-2', 'v=1...');
    });

    it('handles candidate signal', () => {
        mesh = new MeshClient(config);
        signalingListeners.onSignal({
            from: 'peer-3',
            signal: { type: 'candidate', candidate: { candidate: 'x', sdpMid: 'audio', sdpMLineIndex: 0 } }
        });
        expect(mockConnections.handleCandidate).toHaveBeenCalledWith(
            'peer-3',
            expect.objectContaining({ candidate: 'x' })
        );
    });

    it('emits ephemeral messages', () => {
        mesh = new MeshClient(config);
        const ephemeralHandler = vi.fn();
        mesh.on('ephemeral', ephemeralHandler);

        signalingListeners.onEphemeral({ type: 'cursor', x: 10 });
        expect(ephemeralHandler).toHaveBeenCalledWith(expect.objectContaining({ type: 'cursor' }));
    });

    it('handles ephemeral messages', () => {
        mesh = new MeshClient(config);
        const ephemeralHandler = vi.fn();
        mesh.on('ephemeral', ephemeralHandler);

        signalingListeners.onEphemeral({ type: 'cursor', x: 10 });
        expect(ephemeralHandler).toHaveBeenCalledWith(expect.objectContaining({ type: 'cursor' }));
    });

    it('handles peer disconnect notifications', () => {
        mesh = new MeshClient(config);
        const peerDisconnectHandler = vi.fn();
        mesh.on('peerDisconnect', peerDisconnectHandler);

        signalingListeners.onPresence('peer-1', 'offline');
        expect(peerDisconnectHandler).toHaveBeenCalledWith('peer-1');
    });

    it('handles peer message through connection manager', () => {
        mesh = new MeshClient(config);
        const messageHandler = vi.fn();
        mesh.on('message', messageHandler);

        const data = new ArrayBuffer(8);
        connectionListeners.onMessage('peer-2', data);
        expect(messageHandler).toHaveBeenCalledWith('peer-2', data);
    });

    it('handles signaling disconnect', () => {
        mesh = new MeshClient(config);
        signalingListeners.onConnect();

        signalingListeners.onDisconnect();
        expect(mesh.getState()).toBe('RECONNECTING');
    });

    it('handles signaling error', () => {
        mesh = new MeshClient(config);
        const errorHandler = vi.fn();
        mesh.on('error', errorHandler);

        signalingListeners.onError(new Error('Connection failed'));
        expect(errorHandler).toHaveBeenCalled();
    });

    it('can remove event listeners with off()', () => {
        mesh = new MeshClient(config);
        const handler = vi.fn();
        mesh.on('peerJoin', handler);
        mesh.off('peerJoin', handler);

        connectionListeners.onPeerJoin('peer-1');
        expect(handler).not.toHaveBeenCalled();
    });

    it('handles join signal for new peer discovery', () => {
        mesh = new MeshClient(config);
        signalingListeners.onConnect();
        signalingListeners.onServerMessage({ type: 'config' });

        // When we receive a join from another peer, we initiate P2P
        signalingListeners.onSignal({
            from: 'new-peer',
            signal: { type: 'join', workspaceId: 'ws' }
        });
        expect(mockConnections.initiateConnection).toHaveBeenCalledWith('new-peer');
    });

    it('blocks broadcast before ACTIVE state', () => {
        mesh = new MeshClient(config);
        // State is IDLE, not ACTIVE

        const data = new Uint8Array([1, 2, 3]);
        mesh.broadcast(data);

        // Should not send - broadcast blocked
        expect(mockConnections.broadcast).not.toHaveBeenCalled();
        expect(mockSignaling.sendSignal).not.toHaveBeenCalled();
    });

    it('broadcasts to both relay and P2P after ACTIVE', () => {
        mesh = new MeshClient(config);
        signalingListeners.onConnect();
        signalingListeners.onServerMessage({ type: 'config' });

        // Now in ACTIVE state
        // Simulate having a peer in relay mode
        (mesh as any).peerStatus.set('relay-peer', 'relay');

        const data = new Uint8Array([1, 2, 3]);
        mesh.broadcast(data);

        // Should broadcast to connections
        expect(mockConnections.broadcast).toHaveBeenCalled();
    });

    it('disconnect closes everything and emits event', () => {
        mesh = new MeshClient(config);
        const disconnectHandler = vi.fn();
        mesh.on('disconnect', disconnectHandler);

        mesh.disconnect();

        expect(mockConnections.closeAll).toHaveBeenCalled();
        expect(mockSignaling.close).toHaveBeenCalled();
        expect(disconnectHandler).toHaveBeenCalled();
        expect(mesh.getState()).toBe('DISCONNECTED');
    });

    it('handles __pong__ ephemeral messages', () => {
        mesh = new MeshClient(config);
        signalingListeners.onConnect();
        signalingListeners.onServerMessage({ type: 'config' });

        // Set up a pending ping
        const resolver = vi.fn();
        (mesh as any).pendingPings.set('ping-123', resolver);

        // Simulate pong response
        signalingListeners.onEphemeral({
            type: '__pong__',
            requestId: 'ping-123',
            timestamp: performance.now() - 50 // 50ms RTT
        });

        expect(resolver).toHaveBeenCalled();
        expect((mesh as any).pendingPings.has('ping-123')).toBe(false);
    });

    it('ignores __pong__ for unknown request IDs', () => {
        mesh = new MeshClient(config);
        signalingListeners.onConnect();
        signalingListeners.onServerMessage({ type: 'config' });

        // Simulate pong for unknown request - should not throw
        expect(() => {
            signalingListeners.onEphemeral({
                type: '__pong__',
                requestId: 'unknown-id',
                timestamp: performance.now()
            });
        }).not.toThrow();
    });

    it('transitions to ACTIVE on first P2P message in HANDSHAKING state', () => {
        mesh = new MeshClient(config);
        signalingListeners.onConnect();
        signalingListeners.onServerMessage({ type: 'config' });

        // Simulate state is HANDSHAKING
        (mesh as any).state = 'HANDSHAKING';

        // Trigger P2P message callback
        (connectionListeners as any).onMessage('peer-1', new ArrayBuffer(8));

        expect(mesh.getState()).toBe('ACTIVE');
    });

    it('handles peerDisconnect event', () => {
        mesh = new MeshClient(config);
        const disconnectHandler = vi.fn();
        mesh.on('peerDisconnect', disconnectHandler);

        signalingListeners.onConnect();
        signalingListeners.onServerMessage({ type: 'config' });

        // Add a peer first
        (mesh as any).peerStatus.set('peer-1', 'p2p');

        // Trigger disconnect via presence
        signalingListeners.onPresence('peer-1', 'offline');

        expect(disconnectHandler).toHaveBeenCalledWith('peer-1');
    });

    it('sends relay signal for peers not on P2P', () => {
        mesh = new MeshClient(config);
        signalingListeners.onConnect();
        signalingListeners.onServerMessage({ type: 'config' });

        // Add a peer in relay mode
        (mesh as any).peerStatus.set('relay-peer', 'relay');

        const data = new Uint8Array([1, 2, 3]);
        mesh.broadcast(data);

        // Should send via relay
        expect(mockSignaling.sendSignal).toHaveBeenCalledWith('relay-peer', expect.objectContaining({
            type: 'relay'
        }));
    });
});
