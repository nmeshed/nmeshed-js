import { EventEmitter } from '../utils/EventEmitter';

/**
 * P2P Mocks with "Magic Linking" capabilities.
 * Allows simulating a perfect P2P mesh in Node.js without WebRTC bindings.
 */

export class MockLinkedRTCPeerConnection {
    public iceConnectionState: 'new' | 'checking' | 'connected' | 'completed' | 'failed' | 'disconnected' | 'closed' = 'new';
    public signalingState: 'stable' | 'have-local-offer' | 'have-remote-offer' | 'closed' = 'stable';

    // Magic Link
    public remotePeer: MockLinkedRTCPeerConnection | null = null;
    public dataChannels: Set<MockLinkedRTCDataChannel> = new Set();
    public ondatachannel: ((event: any) => void) | null = null;
    public onicecandidate: ((event: any) => void) | null = null;

    // Config
    public iceServers: any;

    constructor(config: any) {
        this.iceServers = config?.iceServers;
    }

    // --- WebRTC API ---

    createDataChannel(label: string, _options?: any): MockLinkedRTCDataChannel {
        const dc = new MockLinkedRTCDataChannel(label, this);
        this.dataChannels.add(dc);
        this.tryConnectDataChannel(dc);
        return dc;
    }

    private tryConnectDataChannel(dc: MockLinkedRTCDataChannel) {
        // Late Linking logic: If linked, connect immediately. 
        // If not, retry when link() is called.
        if (this.remotePeer) {
            // Async simulation of negotiation
            setTimeout(() => {
                if (!this.remotePeer) return;

                // Check if already linked from other side to avoid double-init?
                // Actually, DataChannels are bidirectional but initiated by one side.
                // The other side receives 'ondatachannel'.
                if (dc.readyState === 'open') return;

                // Create the "remote side" of this channel
                const remoteDC = new MockLinkedRTCDataChannel(dc.label, this.remotePeer);
                // Link them
                dc.link(remoteDC);
                remoteDC.link(dc);

                // Open both
                dc.simulateOpen();
                remoteDC.simulateOpen();

                // Notify remote peer
                if (this.remotePeer.ondatachannel) {
                    this.remotePeer.ondatachannel({ channel: remoteDC });
                }
            }, 10);
        }
    }

    async createOffer() { return { type: 'offer', sdp: 'mock-linked-offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'mock-linked-answer' }; }
    async setLocalDescription(_desc: any) { }
    async setRemoteDescription(_desc: any) { }
    async addIceCandidate(_candidate: any) {
        // In a real flow, we'd exchange candidates. 
        // Here, link() ensures connectivity.
    }
    close() {
        this.iceConnectionState = 'closed';
        this.signalingState = 'closed';
        this.dataChannels.forEach(dc => dc.close());
    }

    // --- Magic API ---

    /**
     * Virtually plugs the cable between this PC and another.
     */
    link(other: MockLinkedRTCPeerConnection) {
        if (this.remotePeer === other) return; // Already linked

        this.remotePeer = other;
        other.remotePeer = this;
        this.iceConnectionState = 'connected';
        other.iceConnectionState = 'connected';

        // Retry pending channels now that we are linked
        this.dataChannels.forEach(dc => this.tryConnectDataChannel(dc));
        other.dataChannels.forEach(dc => other.tryConnectDataChannel(dc));
    }
}

export class MockLinkedRTCDataChannel extends EventEmitter<{
    open: [];
    message: [any];
    close: [];
    error: [Error];
}> {
    public readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
    public onopen: (() => void) | null = null;
    public onmessage: ((event: any) => void) | null = null;
    public onclose: (() => void) | null = null;
    public onerror: ((event: any) => void) | null = null;
    public binaryType = 'arraybuffer';

    private remoteDC: MockLinkedRTCDataChannel | null = null;

    constructor(public label: string, public pc: MockLinkedRTCPeerConnection) {
        super();
    }

    link(other: MockLinkedRTCDataChannel) {
        this.remoteDC = other;
    }

    simulateOpen() {
        if (this.readyState !== 'open') {
            this.readyState = 'open';
            this.onopen?.();
            this.emit('open');
        }
    }

    static totalMessagesSent = 0;

    send(data: any) {
        if (this.readyState !== 'open') {
            // throw new Error('DataChannel not open');
            return; // Be permissive in mocks
        }
        MockLinkedRTCDataChannel.totalMessagesSent++;
        if (this.remoteDC) {
            const payload = data instanceof Uint8Array ? data : new Uint8Array(data);
            // Defensive copy for safety in tests
            const copy = new Uint8Array(payload);

            // Trigger onmessage on remote
            if (this.remoteDC.onmessage) {
                // RTCMessageEvent structure
                this.remoteDC.onmessage({ data: copy.buffer } as any);
            }
            this.remoteDC.emit('message', copy.buffer);
        }
    }

    close() {
        this.readyState = 'closed';
        this.onclose?.();
        this.emit('close');
    }
}
