import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshClient } from './MeshClient';
import { SignalingClient } from './SignalingClient';
import { ConnectionManager } from './ConnectionManager';

// Mock the dependencies
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
    broadcast: vi.fn(),
    sendToPeer: vi.fn(),
    initiateConnection: vi.fn(),
    handleOffer: vi.fn(),
    handleAnswer: vi.fn(),
    handleCandidate: vi.fn(),
    closeAll: vi.fn(),
    getPeerIds: vi.fn().mockReturnValue([]),
    isDirect: vi.fn().mockReturnValue(false),
    setListeners: vi.fn(),
};

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

describe('MeshClient Star Topology', () => {
    let signalingHandlers: any;
    let connectionHandlers: any;

    beforeEach(() => {
        vi.clearAllMocks();
        mockSignaling.setListeners.mockImplementation((handlers) => { signalingHandlers = handlers; });
        mockConnections.setListeners.mockImplementation((handlers) => { connectionHandlers = handlers; });
    });

    it('should initialize with star topology when configured', () => {
        const mesh = new MeshClient({
            workspaceId: 'test-ws',
            token: 'test-token',
            topology: 'star'
        });

        // @ts-ignore - checking private field for test
        expect(mesh.effectiveTopology).toBe('star');
    });

    it('should skip P2P connection initiation in star mode', async () => {
        const mesh = new MeshClient({
            workspaceId: 'test-ws',
            token: 'test-token',
            topology: 'star'
        });

        await mesh.connect();
        signalingHandlers.onConnect();

        // I am larger than peerId, normally would initiate
        signalingHandlers.onPresence('peer-1', 'online', 'peer-id-larger');

        expect(mockConnections.initiateConnection).not.toHaveBeenCalled();
    });

    it('should route broadcast through signaling in star mode', () => {
        const mesh = new MeshClient({
            workspaceId: 'test-ws',
            token: 'test-token',
            topology: 'star'
        });

        // Transition to ACTIVE to allow sending
        signalingHandlers.onInit({ workspaceId: 'test-ws' });

        const data = new Uint8Array([1, 2, 3]);

        // Add a peer
        signalingHandlers.onPresence('peer-1', 'online', 'peer-1');

        mesh.broadcast(data);

        // Should use signaling relay for the peer
        expect(mockSignaling.sendSignal).toHaveBeenCalledWith('peer-1', { type: 'relay', data });
        // Should NOT use connection manager broadcast
        expect(mockConnections.broadcast).not.toHaveBeenCalled();
    });

    it('should automatically downgrade to star when peer limit is exceeded', () => {
        const mesh = new MeshClient({
            workspaceId: 'test-ws',
            token: 'test-token',
            topology: 'mesh',
            maxPeersForMesh: 1
        });

        const topologyChangeListener = vi.fn();
        mesh.on('topologyChange', topologyChangeListener);

        // Add first peer
        signalingHandlers.onPresence('peer-1', 'online', 'p1');
        // @ts-ignore
        expect(mesh.effectiveTopology).toBe('mesh');
        expect(topologyChangeListener).not.toHaveBeenCalled();

        // Add second peer (exceeds limit of 1)
        signalingHandlers.onPresence('peer-2', 'online', 'p2');
        // @ts-ignore
        expect(mesh.effectiveTopology).toBe('star');
        expect(topologyChangeListener).toHaveBeenCalledWith('star', 'peer_limit_exceeded');
    });

    it('should restore mesh topology when peer count drops below limit', () => {
        const mesh = new MeshClient({
            workspaceId: 'test-ws',
            token: 'test-token',
            topology: 'mesh',
            maxPeersForMesh: 1
        });

        // Trigger downgrade
        signalingHandlers.onPresence('peer-1', 'online', 'p1');
        signalingHandlers.onPresence('peer-2', 'online', 'p2');
        // @ts-ignore
        expect(mesh.effectiveTopology).toBe('star');

        const topologyChangeListener = vi.fn();
        mesh.on('topologyChange', topologyChangeListener);

        // Remove peer
        signalingHandlers.onPresence('peer-2', 'offline', 'p2');
        // @ts-ignore
        expect(mesh.effectiveTopology).toBe('mesh');
        expect(topologyChangeListener).toHaveBeenCalledWith('mesh', 'peer_limit_restored');
    });

    it('should ignore topology switching if config is already star', () => {
        const mesh = new MeshClient({
            workspaceId: 'test-ws',
            token: 'test-token',
            topology: 'star',
            maxPeersForMesh: 1
        });

        signalingHandlers.onPresence('peer-1', 'online', 'p1');
        // @ts-ignore
        expect(mesh.effectiveTopology).toBe('star');

        signalingHandlers.onPresence('peer-2', 'online', 'p2');
        // @ts-ignore
        expect(mesh.effectiveTopology).toBe('star');
    });
});
