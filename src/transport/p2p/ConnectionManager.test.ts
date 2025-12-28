import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionManager } from './ConnectionManager';
import { MockRTCPeerConnection, setupTestMocks, teardownTestMocks } from '../../test-utils/mocks';

// Stub logger
vi.mock('../../utils/Logger', () => ({
    logger: {
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        conn: vi.fn(),
    }
}));

describe('ConnectionManager', () => {
    let mgr: ConnectionManager;
    const config = { iceServers: [] };

    beforeEach(() => {
        setupTestMocks();
        mgr = new ConnectionManager(config);
    });

    afterEach(() => {
        teardownTestMocks();
        vi.clearAllMocks();
    });

    it('should initialize connection on initiateConnection', async () => {
        const onSignal = vi.fn();
        mgr.setListeners({ onSignal });

        await mgr.initiateConnection('peer1');

        expect(mgr.hasPeer('peer1')).toBe(true);
        // Should create offer and signal it
        expect(onSignal).toHaveBeenCalledWith('peer1', expect.objectContaining({ type: 'offer' }));
    });

    it('should handle incoming offer and respond with answer', async () => {
        const onSignal = vi.fn();
        mgr.setListeners({ onSignal });

        await mgr.handleOffer('peer2', 'sdp-offer');

        expect(mgr.hasPeer('peer2')).toBe(true);
        expect(onSignal).toHaveBeenCalledWith('peer2', expect.objectContaining({ type: 'answer' }));
    });

    it('should handle incoming answer', async () => {
        await mgr.initiateConnection('peer3');
        const pc = (mgr as any).peers.get('peer3');
        pc.signalingState = 'have-local-offer';

        await mgr.handleAnswer('peer3', 'sdp-answer');

        expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'sdp-answer' });
    });

    it('should queue candidates until remote description is set', async () => {
        await mgr.initiateConnection('peer4');
        const pc = (mgr as any).peers.get('peer4') as MockRTCPeerConnection;

        // No remote description yet
        const cand = { candidate: 'cand', sdpMid: '0', sdpMLineIndex: 0 };
        await mgr.handleCandidate('peer4', cand);

        // Should be queued
        const pending = (mgr as any).pendingCandidates.get('peer4');
        expect(pending).toHaveLength(1);

        // Now set remote description (via answer)
        pc.signalingState = 'have-local-offer';
        vi.spyOn(pc, 'addIceCandidate');
        await mgr.handleAnswer('peer4', 'sdp-answer');

        // Should have flushed
        expect(pc.addIceCandidate).toHaveBeenCalled();
        expect((mgr as any).pendingCandidates.has('peer4')).toBe(false);
    });

    it('should setup datachannel on incoming connection', async () => {
        const onPeerJoin = vi.fn();
        const onMessage = vi.fn();
        mgr.setListeners({ onPeerJoin, onMessage });

        // Simulate incoming offer -> PC creation
        await mgr.handleOffer('peer5', 'sdp-offer');
        const pc = (mgr as any).peers.get('peer5') as MockRTCPeerConnection;

        // Simulate remote creating a data channel
        const mockDC = {
            binaryType: 'blob',
            readyState: 'connecting',
            onopen: null as any,
            onmessage: null as any,
            onclose: null as any
        };

        pc.ondatachannel!({ channel: mockDC } as any);

        // Simulate channel open
        mockDC.readyState = 'open';
        mockDC.onopen();

        expect(onPeerJoin).toHaveBeenCalledWith('peer5');
        expect(mgr.isDirect('peer5')).toBe(true);

        // Simulate message
        const data = new Uint8Array([1, 2, 3]);
        mockDC.onmessage({ data: data.buffer });
        expect(onMessage).toHaveBeenCalledWith('peer5', data.buffer);
    });

    it('should cleanup peer on closeAll', async () => {
        const onPeerDisconnect = vi.fn();
        mgr.setListeners({ onPeerDisconnect });

        await mgr.initiateConnection('peer6');
        mgr.closeAll();

        expect(mgr.hasPeer('peer6')).toBe(false);
        expect(onPeerDisconnect).toHaveBeenCalledWith('peer6');
    });

    it('should handle error during handleOffer', async () => {
        const onError = vi.fn();
        mgr.setListeners({ onError });

        // Simulating receiving offer for NEW peer
        const pc = (mgr as any).createPeerConnection('peer8');
        vi.spyOn(pc, 'setRemoteDescription').mockRejectedValue(new Error('SDP Error'));
        (mgr as any).peers.set('peer8', pc);

        await mgr.handleOffer('peer8', 'offer-sdp');
        expect(onError).toHaveBeenCalledWith('peer8', expect.any(Error));
    });

    it('should handle error during handleAnswer', async () => {
        const onError = vi.fn();
        mgr.setListeners({ onError });

        await mgr.initiateConnection('peer9');
        const pc = (mgr as any).peers.get('peer9');
        pc.signalingState = 'have-local-offer';
        vi.spyOn(pc, 'setRemoteDescription').mockRejectedValue(new Error('Answer Error'));

        await mgr.handleAnswer('peer9', 'answer-sdp');
        expect(onError).toHaveBeenCalledWith('peer9', expect.any(Error));
    });

    it('should ignore answer if connection does not exist', async () => {
        // Just ensure no crash
        await mgr.handleAnswer('unknown-peer', 'sdp');
    });

    it('should handle error during handleCandidate', async () => {
        await mgr.initiateConnection('peer10');
        const pc = (mgr as any).peers.get('peer10');
        pc.remoteDescription = { type: 'answer' }; // so it doesn't queue

        vi.spyOn(pc, 'addIceCandidate').mockRejectedValue(new Error('ICE Error'));

        // Should not crash, just log warn (which we stubbed)
        await mgr.handleCandidate('peer10', { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 });
    });

    it('should handle DataChannel errors', async () => {
        const onError = vi.fn();
        mgr.setListeners({ onError });

        // Setup peer & DC
        await mgr.initiateConnection('peer11');
        const pc = (mgr as any).peers.get('peer11');
        const mockDC = {
            binaryType: 'blob',
            readyState: 'open',
            onopen: null, onmessage: null, onclose: null, onerror: null
        };
        (mgr as any).setupDataChannel('peer11', mockDC);

        (mockDC.onerror as any)({ error: 'DC Error' });
        expect(onError).toHaveBeenCalled();
    });
});
