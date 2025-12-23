import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MeshClient } from './MeshClient';
import { MeshMetrics } from './types';

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

describe('MeshClient Connection Metrics', () => {
    let ephemeralHandler: any;
    let mesh: MeshClient;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();

        mockSignaling.setListeners.mockImplementation((handlers) => {
            ephemeralHandler = handlers.onEphemeral;
        });

        mesh = new MeshClient({
            workspaceId: 'test-ws',
            token: 'test-token',
            metricsInterval: 1000 // Short interval for testing
        });
    });

    afterEach(() => {
        mesh.disconnect();
        vi.useRealTimers();
    });

    it('should periodically ping peers and emit metricsUpdate', async () => {
        const metricsListener = vi.fn();
        mesh.on('metricsUpdate', metricsListener);

        // Mock some peers
        // @ts-ignore - reaching into private state for test setup
        mesh.peerStatus.set('peer-1', 'p2p');
        // @ts-ignore
        mesh.peerStatus.set('peer-2', 'relay');

        // Advance time and wait for the interval to trigger
        await vi.advanceTimersByTimeAsync(1100);

        // Verify pings were sent
        expect(mockSignaling.sendEphemeral).toHaveBeenCalledTimes(2);

        const firstPing = mockSignaling.sendEphemeral.mock.calls[0][0];
        const secondPing = mockSignaling.sendEphemeral.mock.calls[1][0];

        expect(firstPing.type).toBe('__ping__');
        expect(secondPing.type).toBe('__ping__');

        // Simulate pongs
        ephemeralHandler({
            type: '__pong__',
            requestId: firstPing.requestId,
            timestamp: firstPing.timestamp,
            from: 'peer-1'
        });

        ephemeralHandler({
            type: '__pong__',
            requestId: secondPing.requestId,
            timestamp: secondPing.timestamp,
            from: 'peer-2'
        });

        // Run all microtasks to allow Promise.all to finish and emit
        await vi.runAllTicks();
        await Promise.resolve();

        await vi.waitFor(() => {
            expect(metricsListener).toHaveBeenCalled();
            expect(metricsListener).toHaveBeenCalledWith(expect.objectContaining({
                peers: expect.arrayContaining([
                    expect.objectContaining({ peerId: 'peer-1', status: 'p2p' }),
                    expect.objectContaining({ peerId: 'peer-2', status: 'relay' })
                ]),
                totalPeers: 2
            }));
        }, { timeout: 2000, interval: 100 });
    });

    it('should stop metrics task on disconnect', () => {
        const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
        mesh.disconnect();
        expect(clearIntervalSpy).toHaveBeenCalled();
    });
});
