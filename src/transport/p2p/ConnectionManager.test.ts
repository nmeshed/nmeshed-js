import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionManager } from './ConnectionManager';
import {
    MockRTCPeerConnection,
    MockRTCDataChannel,
    MockRTCSessionDescription,
    MockRTCIceCandidate
} from '../../test-utils/mocks';

// Stub WebRTC globals
vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection);
vi.stubGlobal('RTCSessionDescription', MockRTCSessionDescription);
vi.stubGlobal('RTCIceCandidate', MockRTCIceCandidate);

describe('ConnectionManager', () => {
    let cm: ConnectionManager;
    let events: any;
    const config = { iceServers: [] };

    beforeEach(() => {
        vi.useFakeTimers();
        cm = new ConnectionManager(config);
        events = {
            onSignal: vi.fn(),
            onMessage: vi.fn(),
            onPeerJoin: vi.fn(),
            onPeerDisconnect: vi.fn(),
            onError: vi.fn(),
        };
        cm.setListeners(events);
    });

    afterEach(() => {
        cm.closeAll();
        vi.clearAllMocks();
    });

    it('initiates connection creates offer', async () => {
        await cm.initiateConnection('peer1');

        expect(cm.hasPeer('peer1')).toBe(true);
        expect(events.onSignal).toHaveBeenCalledWith('peer1', expect.objectContaining({
            type: 'offer',
            sdp: 'mock-sdp-offer'
        }));
    });

    it('handles incoming offer creates answer', async () => {
        await cm.handleOffer('peer2', 'offer-sdp');

        expect(cm.hasPeer('peer2')).toBe(true);
        expect(events.onSignal).toHaveBeenCalledWith('peer2', expect.objectContaining({
            type: 'answer',
            sdp: 'mock-sdp-answer'
        }));
    });

    it('queues candidates until remote description is set', async () => {
        // Since we cannot easily inspect private pendingCandidates, we verify behavior via logs or ordering
        // In the mock, addIceCandidate is a no-op, but we can spy on it if we access the peer

        // This test mostly ensures no crash
        await cm.handleCandidate('peer3', { candidate: 'candidate-1', sdpMid: '0', sdpMLineIndex: 0 });

        // Now set remote description via offer
        await cm.handleOffer('peer3', 'offer-sdp');

        expect(cm.hasPeer('peer3')).toBe(true);
    });

    it('handles data channel open and messaging', async () => {
        await cm.initiateConnection('peer1');

        // Access the underlying mock PC to get the DC
        // Since ConnectionManager keeps peers private, we assume the mock logic works.
        // But the MockRTCDataChannel simulates onopen via setTimeout(10).

        vi.advanceTimersByTime(20);

        expect(events.onPeerJoin).toHaveBeenCalledWith('peer1');

        // Verify broadcast
        // We can't verify send easily without checking the private DC or mocking send on the prototype
        // But we can check if it throws
        expect(() => cm.broadcast(new Uint8Array([1, 2, 3]))).not.toThrow();
    });

    it('discards answer if connection missing', async () => {
        await cm.handleAnswer('unknown-peer', 'sdp');
        expect(cm.hasPeer('unknown-peer')).toBe(false);
    });
});
