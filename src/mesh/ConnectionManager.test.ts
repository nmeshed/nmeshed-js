import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionManager } from './ConnectionManager';

// Mock RTCPeerConnection and RTCDataChannel
class MockRTCDataChannel {
    binaryType = 'arraybuffer';
    readyState = 'connecting';
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((e: any) => void) | null = null;
    onerror: ((e: any) => void) | null = null;
    send = vi.fn();
    close = vi.fn();

    simulateOpen() {
        this.readyState = 'open';
        this.onopen?.();
    }

    simulateClose() {
        this.readyState = 'closed';
        this.onclose?.();
    }

    simulateMessage(data: ArrayBuffer) {
        this.onmessage?.({ data });
    }
}

class MockRTCPeerConnection {
    static instances: MockRTCPeerConnection[] = [];
    signalingState = 'stable';
    remoteDescription: any = null;
    localDescription: any = null;
    onicecandidate: ((e: any) => void) | null = null;
    ondatachannel: ((e: any) => void) | null = null;

    dataChannel: MockRTCDataChannel | null = null;

    constructor() {
        MockRTCPeerConnection.instances.push(this);
    }

    createDataChannel = vi.fn((name: string) => {
        this.dataChannel = new MockRTCDataChannel();
        return this.dataChannel;
    });

    createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'fake-offer-sdp' });
    createAnswer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'fake-answer-sdp' });

    setLocalDescription = vi.fn().mockImplementation(async (desc) => {
        this.localDescription = desc;
        if (desc?.type === 'offer') this.signalingState = 'have-local-offer';
    });

    setRemoteDescription = vi.fn().mockImplementation(async (desc) => {
        this.remoteDescription = desc;
        if (desc?.type === 'answer') this.signalingState = 'stable';
    });

    addIceCandidate = vi.fn().mockResolvedValue(undefined);
    close = vi.fn();

    simulateIceCandidate(candidate: any) {
        this.onicecandidate?.({ candidate });
    }

    simulateDataChannel(dc: MockRTCDataChannel) {
        this.ondatachannel?.({ channel: dc });
    }
}

vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection);
vi.stubGlobal('RTCSessionDescription', class { constructor(public desc: any) { } });
vi.stubGlobal('RTCIceCandidate', class { constructor(public candidate: any) { } });

describe('ConnectionManager', () => {
    const config = { iceServers: [{ urls: 'stun:stun.example.com' }] };

    beforeEach(() => {
        MockRTCPeerConnection.instances = [];
    });

    it('initiates connection and creates offer', async () => {
        const cm = new ConnectionManager(config);
        const onSignal = vi.fn();
        cm.setListeners({ onSignal });

        await cm.initiateConnection('peer-1');

        expect(MockRTCPeerConnection.instances.length).toBe(1);
        expect(MockRTCPeerConnection.instances[0].createOffer).toHaveBeenCalled();
        expect(onSignal).toHaveBeenCalledWith('peer-1', expect.objectContaining({ type: 'offer' }));
    });

    it('does not duplicate connection for same peer', async () => {
        const cm = new ConnectionManager(config);
        await cm.initiateConnection('peer-1');
        await cm.initiateConnection('peer-1');

        expect(MockRTCPeerConnection.instances.length).toBe(1);
    });

    it('handles offer and creates answer', async () => {
        const cm = new ConnectionManager(config);
        const onSignal = vi.fn();
        cm.setListeners({ onSignal });

        await cm.handleOffer('peer-2', 'remote-offer-sdp');

        expect(MockRTCPeerConnection.instances.length).toBe(1);
        expect(onSignal).toHaveBeenCalledWith('peer-2', expect.objectContaining({ type: 'answer' }));
    });

    it('handles answer', async () => {
        const cm = new ConnectionManager(config);
        await cm.initiateConnection('peer-1');

        const pc = MockRTCPeerConnection.instances[0];
        pc.signalingState = 'have-local-offer';

        await cm.handleAnswer('peer-1', 'remote-answer-sdp');

        expect(pc.setRemoteDescription).toHaveBeenCalled();
    });

    it('ignores answer when no connection exists', async () => {
        const cm = new ConnectionManager(config);
        await cm.handleAnswer('unknown', 'sdp');
        // No error
    });

    it('handles ICE candidate', async () => {
        const cm = new ConnectionManager(config);
        await cm.initiateConnection('peer-1');

        const pc = MockRTCPeerConnection.instances[0];
        pc.remoteDescription = { type: 'answer', sdp: 'sdp' };

        await cm.handleCandidate('peer-1', { candidate: 'ice-candidate' });

        expect(pc.addIceCandidate).toHaveBeenCalled();
    });

    it('queues ICE candidate if no remote description', async () => {
        const cm = new ConnectionManager(config);
        await cm.initiateConnection('peer-1');

        await cm.handleCandidate('peer-1', { candidate: 'early-candidate' });

        // Not added yet
        expect(MockRTCPeerConnection.instances[0].addIceCandidate).not.toHaveBeenCalled();
    });

    it('notifies on peer join when data channel opens', async () => {
        const cm = new ConnectionManager(config);
        const onPeerJoin = vi.fn();
        cm.setListeners({ onPeerJoin });

        await cm.initiateConnection('peer-1');

        const dc = MockRTCPeerConnection.instances[0].dataChannel!;
        dc.simulateOpen();

        expect(onPeerJoin).toHaveBeenCalledWith('peer-1');
    });

    it('handles incoming data channel', async () => {
        const cm = new ConnectionManager(config);
        const onPeerJoin = vi.fn();
        const onMessage = vi.fn();
        cm.setListeners({ onPeerJoin, onMessage });

        await cm.handleOffer('peer-2', 'offer-sdp');

        const pc = MockRTCPeerConnection.instances[0];
        const incomingDc = new MockRTCDataChannel();
        pc.simulateDataChannel(incomingDc);

        incomingDc.simulateOpen();
        expect(onPeerJoin).toHaveBeenCalledWith('peer-2');

        const buffer = new ArrayBuffer(8);
        incomingDc.simulateMessage(buffer);
        expect(onMessage).toHaveBeenCalledWith('peer-2', buffer);
    });

    it('broadcasts to all open channels', async () => {
        const cm = new ConnectionManager(config);
        await cm.initiateConnection('peer-1');
        await cm.initiateConnection('peer-2');

        MockRTCPeerConnection.instances[0].dataChannel!.simulateOpen();
        MockRTCPeerConnection.instances[1].dataChannel!.simulateOpen();

        cm.broadcast(new Uint8Array([1, 2, 3]));

        expect(MockRTCPeerConnection.instances[0].dataChannel!.send).toHaveBeenCalled();
        expect(MockRTCPeerConnection.instances[1].dataChannel!.send).toHaveBeenCalled();
    });

    it('sends to specific peer', async () => {
        const cm = new ConnectionManager(config);
        await cm.initiateConnection('peer-1');

        MockRTCPeerConnection.instances[0].dataChannel!.simulateOpen();

        cm.sendToPeer('peer-1', new Uint8Array([1]));
        expect(MockRTCPeerConnection.instances[0].dataChannel!.send).toHaveBeenCalled();
    });

    it('isDirect returns true for open channel', async () => {
        const cm = new ConnectionManager(config);
        await cm.initiateConnection('peer-1');

        expect(cm.isDirect('peer-1')).toBe(false);

        MockRTCPeerConnection.instances[0].dataChannel!.simulateOpen();
        expect(cm.isDirect('peer-1')).toBe(true);
    });

    it('hasPeer returns correct status', async () => {
        const cm = new ConnectionManager(config);
        expect(cm.hasPeer('peer-1')).toBe(false);

        await cm.initiateConnection('peer-1');
        expect(cm.hasPeer('peer-1')).toBe(true);
    });

    it('getPeerIds returns all peers', async () => {
        const cm = new ConnectionManager(config);
        await cm.initiateConnection('peer-1');
        await cm.initiateConnection('peer-2');

        expect(cm.getPeerIds()).toEqual(['peer-1', 'peer-2']);
    });

    it('closes all connections', async () => {
        const cm = new ConnectionManager(config);
        const onPeerDisconnect = vi.fn();
        cm.setListeners({ onPeerDisconnect });

        await cm.initiateConnection('peer-1');
        await cm.initiateConnection('peer-2');

        cm.closeAll();

        expect(onPeerDisconnect).toHaveBeenCalledWith('peer-1');
        expect(onPeerDisconnect).toHaveBeenCalledWith('peer-2');
    });

    it('handles data channel close', async () => {
        const cm = new ConnectionManager(config);
        const onPeerDisconnect = vi.fn();
        cm.setListeners({ onPeerDisconnect });

        await cm.initiateConnection('peer-1');
        MockRTCPeerConnection.instances[0].dataChannel!.simulateOpen();
        MockRTCPeerConnection.instances[0].dataChannel!.simulateClose();

        expect(onPeerDisconnect).toHaveBeenCalledWith('peer-1');
    });

    it('logs warning when sending to peer with closed channel', async () => {
        const cm = new ConnectionManager(config);
        await cm.initiateConnection('peer-1');
        // DC is in 'connecting' state, not 'open'

        // Should not throw
        cm.sendToPeer('peer-1', new Uint8Array([1, 2, 3]));
        expect(MockRTCPeerConnection.instances[0].dataChannel!.send).not.toHaveBeenCalled();
    });

    it('handles glare (simultaneous offers) by rolling back', async () => {
        const cm = new ConnectionManager(config);
        const onSignal = vi.fn();
        cm.setListeners({ onSignal });

        // First, initiate our own connection (we have local offer)
        await cm.initiateConnection('peer-1');
        const pc = MockRTCPeerConnection.instances[0];
        pc.signalingState = 'have-local-offer'; // Simulate being in offer state

        // Now receive an offer from the same peer (glare condition)
        await cm.handleOffer('peer-1', 'remote-offer-sdp');

        // Should have called setLocalDescription with rollback
        expect(pc.setLocalDescription).toHaveBeenCalledWith(expect.objectContaining({ type: 'rollback' }));
    });

    it('ignores answer when signaling state is not have-local-offer', async () => {
        const cm = new ConnectionManager(config);
        await cm.initiateConnection('peer-1');

        const pc = MockRTCPeerConnection.instances[0];
        pc.signalingState = 'stable'; // Not in a state expecting answer

        await cm.handleAnswer('peer-1', 'random-answer-sdp');

        // setRemoteDescription should NOT have been called with the answer
        expect(pc.setRemoteDescription).toHaveBeenCalledTimes(0);
    });

    it('handles ICE candidate for unknown peer without error', async () => {
        const cm = new ConnectionManager(config);
        // No connection established
        await cm.handleCandidate('unknown-peer', { candidate: 'ice' });
        // Should not throw
    });
});
