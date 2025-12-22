import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionManager } from './ConnectionManager';

// Mock WebRTC interfaces
class MockRTCDataChannel {
    readyState = 'connecting';
    binaryType = 'blob';
    onopen: any = null;
    onmessage: any = null;
    onclose: any = null;
    onerror: any = null;

    send = vi.fn();
    close = vi.fn();

    constructor(public label: string) { }

    // Helper to simulate events
    open() {
        this.readyState = 'open';
        this.onopen?.();
    }

    receive(data: any) {
        this.onmessage?.({ data });
    }
}

class MockRTCSessionDescription {
    constructor(public init: any) { }
    get type() { return this.init.type; }
    get sdp() { return this.init.sdp; }
}

class MockRTCIceCandidate {
    constructor(public init: any) { }
    get candidate() { return this.init.candidate; }
    get sdpMid() { return this.init.sdpMid; }
    get sdpMLineIndex() { return this.init.sdpMLineIndex; }
}

class MockRTCPeerConnection {
    static instances: MockRTCPeerConnection[] = [];

    createdDataChannels: MockRTCDataChannel[] = [];
    signalingState = 'stable';
    onicecandidate: any = null;
    ondatachannel: any = null;
    localDescription: any = null;
    remoteDescription: any = null;

    constructor(public config: any) {
        MockRTCPeerConnection.instances.push(this);
    }

    createDataChannel(label: string) {
        const dc = new MockRTCDataChannel(label);
        this.createdDataChannels.push(dc);
        return dc;
    }

    createOffer() {
        return Promise.resolve({ type: 'offer', sdp: 'mock-offer-sdp' });
    }

    createAnswer() {
        return Promise.resolve({ type: 'answer', sdp: 'mock-answer-sdp' });
    }

    setLocalDescription(desc: any) {
        this.localDescription = desc;
        this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
        return Promise.resolve();
    }

    setRemoteDescription(desc: any) {
        this.remoteDescription = desc;
        this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
        return Promise.resolve();
    }

    addIceCandidate(candidate: any) {
        return Promise.resolve();
    }

    close = vi.fn();

    // Helpers
    simulateIce(candidate: any) {
        this.onicecandidate?.({ candidate });
    }
}

vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection);
vi.stubGlobal('RTCSessionDescription', MockRTCSessionDescription);
vi.stubGlobal('RTCIceCandidate', MockRTCIceCandidate);

describe('ConnectionManager', () => {
    let cm: ConnectionManager;
    const config = { iceServers: [] };

    beforeEach(() => {
        MockRTCPeerConnection.instances = [];
        cm = new ConnectionManager(config);
    });

    it('initiates connection correctly', async () => {
        const onSignal = vi.fn();
        cm.setListeners({ onSignal });

        await cm.initiateConnection('peer-1');

        expect(MockRTCPeerConnection.instances.length).toBe(1);
        const pc = MockRTCPeerConnection.instances[0];

        // Ensure DC created
        // How to inspect DC created by PC? 
        // My MockRTCPeerConnection doesn't store created DCs visibly, but logic flow ensures it.
        // We can check localDescription
        expect(pc.localDescription.type).toBe('offer');
        expect(onSignal).toHaveBeenCalledWith('peer-1', { type: 'offer', sdp: 'mock-offer-sdp' });
    });

    it('handles incoming offer', async () => {
        const onSignal = vi.fn();
        cm.setListeners({ onSignal });

        await cm.handleOffer('peer-2', 'remote-offer-sdp');

        expect(MockRTCPeerConnection.instances.length).toBe(1);
        const pc = MockRTCPeerConnection.instances[0];

        expect(pc.remoteDescription.sdp).toBe('remote-offer-sdp');
        expect(pc.localDescription.type).toBe('answer');
        expect(onSignal).toHaveBeenCalledWith('peer-2', { type: 'answer', sdp: 'mock-answer-sdp' });
    });

    it('handles incoming answer', async () => {
        // First initiate to set state
        await cm.initiateConnection('peer-1');
        const pc = MockRTCPeerConnection.instances[0];

        await cm.handleAnswer('peer-1', 'remote-answer-sdp');

        expect(pc.remoteDescription.sdp).toBe('remote-answer-sdp');
        expect(pc.signalingState).toBe('stable');
    });

    it('handles ICE candidates', async () => {
        await cm.initiateConnection('peer-1');
        const pc = MockRTCPeerConnection.instances[0];
        // Ensure remote description is set so it doesn't buffer
        pc.remoteDescription = { type: 'answer', sdp: 'sdp' };

        const spy = vi.spyOn(pc, 'addIceCandidate');

        await cm.handleCandidate('peer-1', { candidate: 'cand', sdpMid: '0', sdpMLineIndex: 0 });

        expect(spy).toHaveBeenCalled();
    });

    it('buffers candidates until remote description is set', async () => {
        await cm.initiateConnection('peer-1');
        const pc = MockRTCPeerConnection.instances[0];
        const spyAdd = vi.spyOn(pc, 'addIceCandidate');

        // Simulate state where remote description is not set yet
        pc.remoteDescription = null; // Mock property

        const cand = { candidate: 'cand', sdpMid: '0', sdpMLineIndex: 0 };
        await cm.handleCandidate('peer-1', cand);

        // Should NOT have called addIceCandidate yet
        expect(spyAdd).not.toHaveBeenCalled();

        // Now handle answer (which sets remote description)
        await cm.handleAnswer('peer-1', 'sdp-answer');

        // Should now flush buffer
        // Note: addIceCandidate called with RTCIceCandidate instance
        expect(spyAdd).toHaveBeenCalledWith(expect.any(MockRTCIceCandidate));
        // Verify content
        const arg = spyAdd.mock.calls[0][0]; // This is the MockRTCIceCandidate
        expect(arg.candidate).toBe(cand.candidate);
    });

    it('emits local ICE candidates via signal', async () => {
        const onSignal = vi.fn();
        cm.setListeners({ onSignal });

        await cm.initiateConnection('peer-1');
        const pc = MockRTCPeerConnection.instances[0];

        pc.simulateIce({ candidate: 'local-cand', sdpMid: '0', sdpMLineIndex: 0 });

        expect(onSignal).toHaveBeenCalledWith('peer-1', expect.objectContaining({
            type: 'candidate',
            candidate: expect.objectContaining({ candidate: 'local-cand' })
        }));
    });

    it('manages DataChannel lifecycle', async () => {
        const onPeerJoin = vi.fn();
        const onPeerDisconnect = vi.fn();
        const onMessage = vi.fn();
        cm.setListeners({ onPeerJoin, onPeerDisconnect, onMessage });

        // Simulate incoming connection (passive side) which receives a DataChannel
        await cm.handleOffer('peer-2', 'offer');
        const pc = MockRTCPeerConnection.instances[0];

        // Simulate remote creating DC
        const mockDc = new MockRTCDataChannel('mesh');
        pc.ondatachannel({ channel: mockDc });

        // DC opens
        mockDc.open();
        expect(onPeerJoin).toHaveBeenCalledWith('peer-2');
        expect(cm.isDirect('peer-2')).toBe(true);
        expect(cm.getPeerIds()).toContain('peer-2');

        // Message received
        const data = new ArrayBuffer(8);
        mockDc.receive(data);
        expect(onMessage).toHaveBeenCalledWith('peer-2', data);

        // DC closes
        mockDc.onclose();
        expect(onPeerDisconnect).toHaveBeenCalledWith('peer-2');
        expect(cm.isDirect('peer-2')).toBe(false);
    });

    it('broadcasts to open channels', async () => {
        // Setup peer 1 (Initiator)
        await cm.initiateConnection('peer-1');
        const pc1 = MockRTCPeerConnection.instances[0];
        const dc1 = pc1.createdDataChannels[0];
        dc1.open();

        const data = new Uint8Array([1, 2, 3]);
        cm.broadcast(data);

        expect(dc1.send).toHaveBeenCalled();
        expect(new Uint8Array(dc1.send.mock.calls[0][0])).toEqual(data);
    });

    it('sends to specific peer if open', async () => {
        await cm.initiateConnection('peer-1');
        const pc1 = MockRTCPeerConnection.instances[0];
        const dc1 = pc1.createdDataChannels[0];
        dc1.open();

        const data = new Uint8Array([9]);
        cm.sendToPeer('peer-1', data);

        expect(dc1.send).toHaveBeenCalled();
    });

    it('handles glare by rolling back', async () => {
        // Setup state: we are creating an offer (local)
        await cm.initiateConnection('peer-1');
        const pc = MockRTCPeerConnection.instances[0];
        // signalingState is 'have-local-offer'

        const spyRollback = vi.spyOn(pc, 'setLocalDescription');

        // Incoming offer implies glare
        await cm.handleOffer('peer-1', 'remote-offer-sdp');

        expect(spyRollback).toHaveBeenCalledWith({ type: 'rollback' });
        expect(pc.remoteDescription.sdp).toBe('remote-offer-sdp');
    });

    it('closeAll closes all peer connections', async () => {
        await cm.initiateConnection('peer-1');
        await cm.initiateConnection('peer-2');

        expect(MockRTCPeerConnection.instances.length).toBe(2);

        cm.closeAll();

        expect(MockRTCPeerConnection.instances[0].close).toHaveBeenCalled();
        expect(MockRTCPeerConnection.instances[1].close).toHaveBeenCalled();
    });

    it('handles DataChannel error gracefully', async () => {
        const onPeerDisconnect = vi.fn();
        cm.setListeners({ onPeerDisconnect });

        await cm.handleOffer('peer-2', 'offer');
        const pc = MockRTCPeerConnection.instances[0];

        // Simulate remote creating DC
        const mockDc = new MockRTCDataChannel('mesh');
        pc.ondatachannel({ channel: mockDc });

        // Trigger error
        mockDc.onerror?.(new Event('error'));

        // Should not crash
    });

    it('handles peer disconnect handler throwing', async () => {
        const badHandler = vi.fn(() => { throw new Error('Handler crash'); });
        cm.setListeners({ onPeerDisconnect: badHandler });

        await cm.handleOffer('peer-2', 'offer');
        const pc = MockRTCPeerConnection.instances[0];

        const mockDc = new MockRTCDataChannel('mesh');
        pc.ondatachannel({ channel: mockDc });
        mockDc.open();

        // Close throws in handler, but should not crash manager
        expect(() => mockDc.onclose()).not.toThrow();
    });

    it('handles sendToPeer with closed channel', async () => {
        // Don't create any connection
        const data = new Uint8Array([1, 2, 3]);

        // Should not throw
        expect(() => cm.sendToPeer('non-existent-peer', data)).not.toThrow();
    });

    it('receives non-ArrayBuffer data without crashing', async () => {
        const onMessage = vi.fn();
        cm.setListeners({ onMessage });

        await cm.handleOffer('peer-2', 'offer');
        const pc = MockRTCPeerConnection.instances[0];

        const mockDc = new MockRTCDataChannel('mesh');
        pc.ondatachannel({ channel: mockDc });
        mockDc.open();

        // Send string instead of ArrayBuffer
        mockDc.onmessage?.({ data: 'not an arraybuffer' });

        // Should not call onMessage because it's not an ArrayBuffer
        expect(onMessage).not.toHaveBeenCalled();
    });
});
