import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { P2PTransport } from './P2PTransport';

// Capture listeners set on mocks
let signalingListeners: any = {};
let connectionListeners: any = {};

// Mock SignalingClient class
class MockSignalingClient {
    connect = vi.fn();
    close = vi.fn();
    setListeners = vi.fn((listeners: any) => { signalingListeners = listeners; });
    sendSignal = vi.fn();
    sendEphemeral = vi.fn();
    sendSync = vi.fn();
    updateToken = vi.fn();
    get connected() { return true; }
}

// Mock ConnectionManager class
class MockConnectionManager {
    setListeners = vi.fn((listeners: any) => { connectionListeners = listeners; });
    closeAll = vi.fn();
    broadcast = vi.fn();
    initiateConnection = vi.fn();
    handleOffer = vi.fn();
    handleAnswer = vi.fn();
    handleCandidate = vi.fn();
    hasPeer = vi.fn();
    isDirect = vi.fn();
    getPeerIds = vi.fn(() => []);
}

// Keep references to capture instances
let signalingInstance: MockSignalingClient;
let connectionsInstance: MockConnectionManager;

vi.mock('./p2p/SignalingClient', () => {
    return {
        SignalingClient: class {
            connect = vi.fn();
            close = vi.fn();
            setListeners = vi.fn((listeners: any) => { signalingListeners = listeners; });
            sendSignal = vi.fn();
            sendEphemeral = vi.fn();
            sendSync = vi.fn();
            updateToken = vi.fn();
            get connected() { return true; }

            constructor() {
                signalingInstance = this as any;
            }
        }
    };
});

vi.mock('./p2p/ConnectionManager', () => {
    return {
        ConnectionManager: class {
            setListeners = vi.fn((listeners: any) => { connectionListeners = listeners; });
            closeAll = vi.fn();
            broadcast = vi.fn();
            initiateConnection = vi.fn();
            handleOffer = vi.fn();
            handleAnswer = vi.fn();
            handleCandidate = vi.fn();
            hasPeer = vi.fn();
            isDirect = vi.fn();
            getPeerIds = vi.fn(() => []);

            constructor() {
                connectionsInstance = this as any;
            }
        }
    };
});

describe('P2PTransport', () => {
    let transport: P2PTransport;

    const config = {
        workspaceId: 'ws-test',
        userId: 'user-1',
        token: 'token-123'
    };

    beforeEach(() => {
        vi.useFakeTimers();
        signalingListeners = {};
        connectionListeners = {};
        vi.clearAllMocks();

        transport = new P2PTransport(config);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('connect calls signaling connect', async () => {
        await transport.connect();
        expect(signalingInstance.connect).toHaveBeenCalled();
        expect(transport.getStatus()).toBe('CONNECTING');
    });

    it('updates status on signaling connect', () => {
        transport.connect();
        signalingListeners.onConnect();
        expect(transport.getStatus()).toBe('CONNECTED');
    });

    it('handles signaling error', () => {
        const err = new Error('Sig Error');
        const errSpy = vi.fn();
        transport.on('error', errSpy);
        transport.connect();
        signalingListeners.onError(err);
        expect(transport.getStatus()).toBe('ERROR');
        expect(errSpy).toHaveBeenCalledWith(err);
    });

    it('disconnect closes everything', () => {
        transport.disconnect();
        expect(signalingInstance.close).toHaveBeenCalled();
        expect(connectionsInstance.closeAll).toHaveBeenCalled();
        expect(transport.getStatus()).toBe('DISCONNECTED');
    });

    it('handles presence online by initiating connection if myId > peerId', () => {
        transport.connect();
        signalingListeners.onConnect();
        signalingListeners.onPresence('user-0', 'online');
        expect(connectionsInstance.initiateConnection).toHaveBeenCalledWith('user-0');
    });

    it('does not initiate connection if myId < peerId', () => {
        transport.connect();
        signalingListeners.onPresence('user-2', 'online');
        expect(connectionsInstance.initiateConnection).not.toHaveBeenCalled();
    });

    it('broadcasts via relay if peer not p2p', () => {
        transport.connect();
        signalingListeners.onPresence('user-2', 'online');
        const data = new Uint8Array([1, 2, 3]);
        transport.broadcast(data);
        expect(signalingInstance.sendSignal).toHaveBeenCalledWith('user-2', expect.objectContaining({
            type: 'relay',
            data: data
        }));
        expect(connectionsInstance.broadcast).toHaveBeenCalledWith(data);
    });

    it('broadcasts via p2p only if peer joined p2p', () => {
        transport.connect();
        connectionListeners.onPeerJoin('user-2');
        const data = new Uint8Array([1, 2, 3]);
        transport.broadcast(data);
        expect(signalingInstance.sendSignal).not.toHaveBeenCalledWith('user-2', expect.objectContaining({ type: 'relay' }));
        expect(connectionsInstance.broadcast).toHaveBeenCalledWith(data);
    });

    it('routes incoming signals to connection manager', () => {
        transport.connect();
        signalingListeners.onSignal({ from: 'u2', signal: { type: 'offer', sdp: 'sdp' } });
        expect(connectionsInstance.handleOffer).toHaveBeenCalledWith('u2', 'sdp');
        signalingListeners.onSignal({ from: 'u3', signal: { type: 'answer', sdp: 'sdp-ans' } });
        expect(connectionsInstance.handleAnswer).toHaveBeenCalledWith('u3', 'sdp-ans');
        const cand = { candidate: 'c', sdpMid: 'm', sdpMLineIndex: 0 };
        signalingListeners.onSignal({ from: 'u4', signal: { type: 'candidate', candidate: cand } });
        expect(connectionsInstance.handleCandidate).toHaveBeenCalledWith('u4', cand);
    });

    it('routes join signal to initiate connection', () => {
        transport.connect();
        signalingListeners.onSignal({ from: 'u5', signal: { type: 'join' } });
        expect(connectionsInstance.initiateConnection).toHaveBeenCalledWith('u5');
    });

    it('routes connection signals to signaling client', () => {
        transport.connect();
        connectionListeners.onSignal('u5', { type: 'offer', sdp: 'o' });
        expect(signalingInstance.sendSignal).toHaveBeenCalledWith('u5', { type: 'offer', sdp: 'o' });
    });

    it('ping sends ephemeral and resolves on pong', async () => {
        transport.connect();
        const pingPromise = transport.ping('target-peer');
        expect(signalingInstance.sendEphemeral).toHaveBeenCalledWith(expect.objectContaining({
            type: '__ping__',
        }), 'target-peer');
        const call = signalingInstance.sendEphemeral.mock.calls[0];
        const requestId = call[0].requestId;
        vi.advanceTimersByTime(50);
        signalingListeners.onEphemeral({ type: '__pong__', requestId }, 'target-peer');
        const latency = await pingPromise;
        expect(latency).toBe(50);
    });

    it('responds to ping with pong', () => {
        transport.connect();
        signalingListeners.onEphemeral({ type: '__ping__', requestId: 'req-1', from: 'sender' }, 'sender');
        expect(signalingInstance.sendEphemeral).toHaveBeenCalledWith(expect.objectContaining({
            type: '__pong__',
            requestId: 'req-1'
        }), 'sender');
    });

    it('handles presence offline', () => {
        transport.connect();
        signalingListeners.onPresence('user-3', 'online');
        const leaveSpy = vi.fn();
        transport.on('peerDisconnect', leaveSpy);
        signalingListeners.onPresence('user-3', 'offline');
        expect(leaveSpy).toHaveBeenCalledWith('user-3');
    });

    it('emits peerJoin when connection established', () => {
        transport.connect();
        const joinSpy = vi.fn();
        transport.on('peerJoin', joinSpy);
        connectionListeners.onPeerJoin('user-5');
        expect(joinSpy).toHaveBeenCalledWith('user-5');
    });

    it('emits peerDisconnect when connection closes', () => {
        transport.connect();
        const leaveSpy = vi.fn();
        transport.on('peerDisconnect', leaveSpy);
        connectionListeners.onPeerDisconnect('user-6');
        expect(leaveSpy).toHaveBeenCalledWith('user-6');
    });

    it('emits error on connection error', () => {
        transport.connect();
        const errSpy = vi.fn();
        transport.on('error', errSpy);
        const err = new Error('Peer Error');
        connectionListeners.onError('user-7', err);
        expect(errSpy).toHaveBeenCalledWith(err);
    });

    it('getPeers returns known peers', () => {
        transport.connect();
        signalingListeners.onPresence('peerA', 'online');
        signalingListeners.onPresence('peerB', 'online');
        const peers = transport.getPeers();
        expect(peers).toContain('peerA');
        expect(peers).toContain('peerB');
    });

    // === Additional coverage tests ===

    it('send() wraps data in WirePacket and broadcasts', () => {
        transport.connect();
        const data = new Uint8Array([10, 20, 30]);
        transport.send(data);
        expect(connectionsInstance.broadcast).toHaveBeenCalled();
    });

    it('simulateLatency delays broadcasts', () => {
        transport.connect();
        transport.simulateLatency(100);
        signalingListeners.onPresence('peer-delayed', 'online');
        const data = new Uint8Array([1]);
        transport.broadcast(data);
        // Broadcast not called immediately
        expect(connectionsInstance.broadcast).not.toHaveBeenCalled();
        vi.advanceTimersByTime(100);
        expect(connectionsInstance.broadcast).toHaveBeenCalled();
    });

    it('simulatePacketLoss drops messages probabilistically', () => {
        transport.connect();
        transport.simulatePacketLoss(1.0); // 100% loss
        signalingListeners.onPresence('peer-loss', 'online');
        const data = new Uint8Array([1]);
        transport.broadcast(data);
        // Nothing should be sent with 100% loss
        expect(signalingInstance.sendSignal).not.toHaveBeenCalled();
        expect(connectionsInstance.broadcast).not.toHaveBeenCalled();
    });

    it('ping timeout rejects after 5 seconds', async () => {
        transport.connect();
        const pingPromise = transport.ping('no-response-peer');
        vi.advanceTimersByTime(5000);
        await expect(pingPromise).rejects.toThrow('Ping timeout');
    });


    // NOTE: handleRawMessage and relay signal routing is tested via integration tests
    // since unit mocks don't preserve the actual method invocation chain.



    it('does not emit presence for self', () => {
        transport.connect();
        const joinSpy = vi.fn();
        transport.on('peerJoin', joinSpy);

        // The transport's myId is 'user-1'
        signalingListeners.onPresence('user-1', 'online');
        expect(joinSpy).not.toHaveBeenCalled();
    });

    it('ignores signal from self', () => {
        transport.connect();
        // Own signals should be ignored
        signalingListeners.onSignal({ from: 'user-1', signal: { type: 'offer', sdp: 'x' } });
        expect(connectionsInstance.handleOffer).not.toHaveBeenCalled();
    });

    it('handles presence with meshId', () => {
        transport.connect();
        const joinSpy = vi.fn();
        transport.on('peerJoin', joinSpy);

        // meshId provided - should use meshId as peerId
        signalingListeners.onPresence('real-user', 'online', 'mesh-id-123');
        expect(joinSpy).toHaveBeenCalledWith('mesh-id-123');
    });

    it('sendEphemeral with latency delays send', () => {
        transport.connect();
        transport.simulateLatency(50);
        transport.sendEphemeral({ foo: 'bar' }, 'target');
        expect(signalingInstance.sendEphemeral).not.toHaveBeenCalled();
        vi.advanceTimersByTime(50);
        expect(signalingInstance.sendEphemeral).toHaveBeenCalledWith({ foo: 'bar' }, 'target');
    });

    it('sendEphemeral with packet loss drops message', () => {
        transport.connect();
        transport.simulatePacketLoss(1.0);
        transport.sendEphemeral({ foo: 'bar' }, 'target');
        expect(signalingInstance.sendEphemeral).not.toHaveBeenCalled();
    });

    it('handleSignal ignores null/empty envelope', () => {
        transport.connect();
        signalingListeners.onSignal(null);
        signalingListeners.onSignal({});
        signalingListeners.onSignal({ from: null, signal: null });
        // Should not throw, just ignore
        expect(connectionsInstance.handleOffer).not.toHaveBeenCalled();
    });

    // === Additional tests for remaining uncovered lines ===

    it('disconnect clears syncTimeout if set', () => {
        transport.connect();
        // onConnect sets syncTimeout
        signalingListeners.onConnect();

        // Now disconnect should clear it
        transport.disconnect();

        // Advance time past the 5s timeout - should not cause any issues
        vi.advanceTimersByTime(6000);
        expect(transport.getStatus()).toBe('DISCONNECTED');
    });

    it('onDisconnect callback sets status to DISCONNECTED', () => {
        transport.connect();
        signalingListeners.onConnect();
        expect(transport.getStatus()).toBe('CONNECTED');

        // Simulate connection lost
        signalingListeners.onDisconnect();
        expect(transport.getStatus()).toBe('DISCONNECTED');
    });
});
