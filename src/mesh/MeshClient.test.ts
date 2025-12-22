import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshClient } from './MeshClient';
import { SignalingClient } from './SignalingClient';
import { ConnectionManager } from './ConnectionManager';

// Define Mock Objects at Module Level to avoid Scope Issues
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

// Mock the modules using factory with explicit classes
vi.mock('./SignalingClient', () => ({
    SignalingClient: class {
        constructor() { return mockSignaling; }
    },
}));

vi.mock('./ConnectionManager', () => ({
    ConnectionManager: class {
        constructor() { return mockConnections; }
    },
}));

describe('MeshClient', () => {
    let mesh: MeshClient;
    let signalingListeners: any;
    let connectionListeners: any;

    const config = {
        workspaceId: 'ws-test',
        token: 'token-test',
        serverUrl: 'wss://test.com',
    };

    beforeEach(() => {
        vi.clearAllMocks();

        // Capture listeners when setListeners is called
        mockSignaling.setListeners.mockImplementation((listeners) => {
            signalingListeners = listeners;
        });
        mockConnections.setListeners.mockImplementation((listeners) => {
            connectionListeners = listeners;
        });

        // Default return values
        mockConnections.getPeerIds.mockReturnValue([]);
        mockConnections.isDirect.mockReturnValue(false);
    });

    describe('constructor', () => {
        it('throws if workspaceId is missing', () => {
            expect(() => new MeshClient({ ...config, workspaceId: '' })).toThrow();
        });

        it('throws if token is missing', () => {
            expect(() => new MeshClient({ ...config, token: '' })).toThrow();
        });

        it('initializes dependencies and sets listeners', () => {
            mesh = new MeshClient(config);
            expect(mockSignaling.setListeners).toHaveBeenCalled();
            expect(mockConnections.setListeners).toHaveBeenCalled();
        });
    });

    describe('connect', () => {
        it('calls signaling.connect()', async () => {
            mesh = new MeshClient(config);
            await mesh.connect();
            expect(mockSignaling.connect).toHaveBeenCalled();
        });

        it('updates status on connect event', async () => {
            mesh = new MeshClient(config);
            const statusListener = vi.fn();
            mesh.on('statusChange', statusListener);

            // Trigger connect (need access to listeners)
            // Constructor called above, so listeners captured
            signalingListeners.onConnect();

            expect(mesh.getStatus()).toBe('CONNECTED');
            expect(statusListener).toHaveBeenCalledWith('CONNECTED');
        });
    });

    describe('Presence Handling', () => {
        beforeEach(() => {
            mesh = new MeshClient(config);
        });

        it('registers new peer as relay when online', () => {
            const joinListener = vi.fn();
            mesh.on('peerJoin', joinListener);
            const statusListener = vi.fn();
            mesh.on('peerStatus', statusListener);

            signalingListeners.onPresence('peer-1', 'online', 'peer-1-mesh');

            expect(joinListener).toHaveBeenCalledWith('peer-1-mesh');
            expect(statusListener).toHaveBeenCalledWith('peer-1-mesh', 'relay');
        });

        it('removes peer when offline', () => {
            const disconnectListener = vi.fn();
            mesh.on('peerDisconnect', disconnectListener);

            signalingListeners.onPresence('peer-1', 'online', 'peer-1-mesh');
            signalingListeners.onPresence('peer-1', 'offline', 'peer-1-mesh');

            expect(disconnectListener).toHaveBeenCalledWith('peer-1-mesh');
        });
    });

    describe('Signal Logic', () => {
        beforeEach(() => { mesh = new MeshClient(config); });

        it('handles JOIN signal', () => {
            const env = { from: 'peer-2', signal: { type: 'join' } };
            signalingListeners.onSignal(env);
            expect(mockConnections.initiateConnection).toHaveBeenCalledWith('peer-2');
        });

        it('handles OFFER signal', () => {
            const env = { from: 'peer-2', signal: { type: 'offer', sdp: 'sdp-o' } };
            signalingListeners.onSignal(env);
            expect(mockConnections.handleOffer).toHaveBeenCalledWith('peer-2', 'sdp-o');
        });

        it('handles RELAY signal (data message)', () => {
            const msgListener = vi.fn();
            mesh.on('message', msgListener);

            const u8 = new Uint8Array([1, 2, 3]);
            // Mock buffer property for slice check in MeshClient
            const dataObj = {
                buffer: u8.buffer,
                byteOffset: 0,
                byteLength: u8.byteLength
            };

            const env = { from: 'peer-2', signal: { type: 'relay', data: dataObj } }; // MeshClient casts to any and accesses .buffer

            // The MeshClient implementation uses `(signal as any).data.buffer`. 
            // ProtocolUtils creates flatbuffer vectors usually? 
            // But if we mock `signal.data` as Uint8Array, it has `.buffer`.
            // Let's pass Uint8Array directly.

            const envReal = { from: 'peer-2', signal: { type: 'relay', data: u8 } };

            signalingListeners.onSignal(envReal);

            expect(msgListener).toHaveBeenCalled();
            const callArgs = msgListener.mock.calls[0];
            expect(callArgs[0]).toBe('peer-2');
            expect(new Uint8Array(callArgs[1])).toEqual(u8);
        });
    });

    describe('Messaging', () => {
        beforeEach(() => { mesh = new MeshClient(config); });

        it('broadcast uses Hybrid Routing', () => {
            connectionListeners.onPeerJoin('peer-a');
            signalingListeners.onPresence('peer-b', 'online');

            const data = new Uint8Array([10, 20]);
            mesh.broadcast(data);

            expect(mockConnections.broadcast).toHaveBeenCalledWith(data);
            expect(mockSignaling.sendSignal).toHaveBeenCalledWith(
                'peer-b',
                expect.objectContaining({ type: 'relay' })
            );
        });

        it('sendToPeer uses P2P if direct connection exists', () => {
            connectionListeners.onPeerJoin('peer-a');
            mockConnections.isDirect.mockReturnValue(true);

            const data = new Uint8Array([1]);
            mesh.sendToPeer('peer-a', data);

            expect(mockConnections.sendToPeer).toHaveBeenCalledWith('peer-a', data);
            expect(mockSignaling.sendSignal).not.toHaveBeenCalled();
        });

        it('sendToPeer falls back to Relay if no direct connection', () => {
            signalingListeners.onPresence('peer-b', 'online');
            mockConnections.isDirect.mockReturnValue(false);

            const data = new Uint8Array([1]);
            mesh.sendToPeer('peer-b', data);

            expect(mockSignaling.sendSignal).toHaveBeenCalledWith(
                'peer-b',
                expect.objectContaining({ type: 'relay' })
            );
        });
    });

    describe('Events', () => {
        beforeEach(() => { mesh = new MeshClient(config); });

        it('emits authorityMessage', () => {
            const listener = vi.fn();
            mesh.on('authorityMessage', listener);
            const data = { foo: 'bar' };
            signalingListeners.onServerMessage(data);
            expect(listener).toHaveBeenCalledWith(data);
        });

        it('emits ephemeral', () => {
            const listener = vi.fn();
            mesh.on('ephemeral', listener);
            const data = { cursor: 1 };
            signalingListeners.onEphemeral(data);
            expect(listener).toHaveBeenCalledWith(data);
        });
    });

    it('destroy cleans up', () => {
        mesh = new MeshClient(config);
        mesh.destroy();
        expect(mockConnections.closeAll).toHaveBeenCalled();
        expect(mockSignaling.close).toHaveBeenCalled();
        expect(mesh.getStatus()).toBe('DISCONNECTED');
    });

    describe('Additional Signal Handling', () => {
        beforeEach(() => { mesh = new MeshClient(config); });

        it('handles ANSWER signal', () => {
            const env = { from: 'peer-2', signal: { type: 'answer', sdp: 'sdp-a' } };
            signalingListeners.onSignal(env);
            expect(mockConnections.handleAnswer).toHaveBeenCalledWith('peer-2', 'sdp-a');
        });

        it('handles CANDIDATE signal', () => {
            const candidateData = { candidate: 'cand', sdpMid: '0', sdpMLineIndex: 0 };
            const env = { from: 'peer-2', signal: { type: 'candidate', candidate: candidateData } };
            signalingListeners.onSignal(env);
            expect(mockConnections.handleCandidate).toHaveBeenCalledWith('peer-2', candidateData);
        });
    });

    describe('P2P Upgrade Logic', () => {
        beforeEach(() => { mesh = new MeshClient(config); });

        it('upgrades peer to P2P on peerJoin from ConnectionManager', () => {
            const statusListener = vi.fn();
            mesh.on('peerStatus', statusListener);

            // First add as relay via presence
            signalingListeners.onPresence('peer-1', 'online', 'peer-1-mesh');

            // Then upgrade via peerJoin from connections
            connectionListeners.onPeerJoin('peer-1-mesh');

            expect(statusListener).toHaveBeenCalledWith('peer-1-mesh', 'p2p');
        });
    });

    describe('Error Handling', () => {
        beforeEach(() => { mesh = new MeshClient(config); });

        it('catches errors in event handlers without crashing', () => {
            const errorHandler = vi.fn(() => { throw new Error('Handler error'); });
            mesh.on('peerJoin', errorHandler);

            // Should not throw
            expect(() => {
                signalingListeners.onPresence('peer-1', 'online', 'peer-1-mesh');
            }).not.toThrow();

            expect(errorHandler).toHaveBeenCalled();
        });
    });

    describe('Off/Remove Listener', () => {
        beforeEach(() => { mesh = new MeshClient(config); });

        it('off() removes listener', () => {
            const listener = vi.fn();
            mesh.on('peerJoin', listener);
            mesh.off('peerJoin', listener);

            signalingListeners.onPresence('peer-1', 'online', 'peer-1-mesh');

            expect(listener).not.toHaveBeenCalled();
        });
    });
});
