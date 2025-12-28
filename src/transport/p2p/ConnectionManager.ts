/**
 * @file ConnectionManager.ts
 * @brief WebRTC peer connection and data channel lifecycle manager.
 *
 * Encapsulates the complexity of WebRTC connection establishment, including:
 * - RTCPeerConnection creation and ICE candidate exchange
 * - DataChannel setup and message routing
 * - Glare handling (simultaneous offers)
 * - Peer cleanup and disconnection
 */

import type { SignalMessage } from './types';
import { logger } from '../../utils/Logger';

export interface ConnectionEvents {
    onSignal: (to: string, signal: SignalMessage) => void;
    onMessage: (peerId: string, data: ArrayBuffer) => void;
    onPeerJoin: (peerId: string) => void;
    onPeerDisconnect: (peerId: string) => void;
    onError: (peerId: string, err: Error) => void;
}

export interface ConnectionManagerConfig {
    iceServers: RTCIceServer[];
}

/**
 * Manages WebRTC peer connections and data channels.
 */
export class ConnectionManager {
    private peers: Map<string, RTCPeerConnection> = new Map();
    private dataChannels: Map<string, RTCDataChannel> = new Map();
    private pendingCandidates: Map<string, RTCIceCandidateInit[]> = new Map();
    private listeners: Partial<ConnectionEvents> = {};
    private config: ConnectionManagerConfig;
    private debug: boolean;
    private logger = logger;

    constructor(config: ConnectionManagerConfig, debug: boolean = false) {
        this.config = config;
        this.debug = debug;
        this.logger = logger.child(this.debug ? 'P2P:DEBUG' : 'P2P');
        if (this.debug) this.logger.setLogLevel(0); // DEBUG
    }

    public setListeners(listeners: Partial<ConnectionEvents>) {
        this.listeners = listeners;
    }

    public hasPeer(peerId: string): boolean {
        return this.peers.has(peerId);
    }

    public getPeerIds(): string[] {
        return Array.from(this.peers.keys());
    }

    /**
     * Checks if a peer has a direct, open P2P channel.
     */
    public isDirect(peerId: string): boolean {
        const dc = this.dataChannels.get(peerId);
        return dc !== undefined && dc.readyState === 'open';
    }

    /**
     * Broadcasts binary data to all connected peers.
     */
    public broadcast(data: ArrayBuffer | Uint8Array) {
        const buffer = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        let sentCount = 0;
        this.dataChannels.forEach((dc, peerId) => {
            if (dc.readyState === 'open') {
                try {
                    // Use the specific slice/buffer to ensure we send the right bytes
                    const toSend = buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength
                        ? buffer.buffer
                        : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
                    dc.send(toSend as any);
                    sentCount++;
                } catch (e) {
                    logger.error(`Failed to send to ${peerId}`, e);
                }
            }
        });
        if (sentCount > 0) {
            this.logger.info(`[P2P] Broadcasted ${buffer.byteLength} bytes to ${sentCount} peers`);
        } else {
            this.logger.warn(`[P2P] Broadcast attempt with 0 open channels (Total DCs: ${this.dataChannels.size})`);
        }
    }

    /**
     * Sends binary data to a specific peer.
     */
    public sendToPeer(peerId: string, data: ArrayBuffer | Uint8Array) {
        const dc = this.dataChannels.get(peerId);
        if (dc && dc.readyState === 'open') {
            const buffer = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
            dc.send(buffer as unknown as ArrayBuffer);
        } else {
            logger.warn(`Cannot send to ${peerId} - DC not open`);
        }
    }

    /**
     * Initiates a P2P connection with a peer.
     */
    public async initiateConnection(peerId: string) {
        if (this.peers.has(peerId)) return;

        const pc = this.createPeerConnection(peerId);
        const dc = pc.createDataChannel('mesh');
        this.setupDataChannel(peerId, dc);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.listeners.onSignal?.(peerId, { type: 'offer', sdp: offer.sdp! });
    }

    /**
     * Handles an incoming offer from a peer.
     */
    public async handleOffer(from: string, sdp: string) {
        let pc = this.peers.get(from);
        if (!pc) pc = this.createPeerConnection(from);

        try {
            if (pc.signalingState !== 'stable') {
                // Handle glare (simultaneous offers)
                await Promise.all([
                    pc.setLocalDescription({ type: 'rollback' }),
                    pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }))
                ]);
            } else {
                await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
            }
            // Flush pending candidates
            await this.flushCandidates(from, pc);

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.listeners.onSignal?.(from, { type: 'answer', sdp: answer.sdp! });
        } catch (err) {
            logger.error('Offer Error', err);
            this.listeners.onError?.(from, err instanceof Error ? err : new Error(String(err)));
        }
    }

    /**
     * Handles an incoming answer from a peer.
     */
    public async handleAnswer(from: string, sdp: string) {
        const pc = this.peers.get(from);
        if (!pc) {
            logger.warn(`Received answer from ${from} but no connection exists`);
            return;
        }
        try {
            if (pc.signalingState === 'have-local-offer' || pc.signalingState === 'have-local-pranswer') {
                await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
                await this.flushCandidates(from, pc);
            } else {
                logger.warn(`Ignored answer in state: ${pc.signalingState}`);
            }
        } catch (err) {
            logger.error('Answer Error', err);
            this.listeners.onError?.(from, err instanceof Error ? err : new Error(String(err)));
        }
    }

    /**
     * Handles an incoming ICE candidate from a peer.
     */
    public async handleCandidate(from: string, candidate: RTCIceCandidateInit) {
        const pc = this.peers.get(from);
        if (!pc) return;

        if (!pc.remoteDescription) {
            // Queue candidate
            if (!this.pendingCandidates.has(from)) {
                this.pendingCandidates.set(from, []);
            }
            this.pendingCandidates.get(from)!.push(candidate);
            logger.conn(`Queued candidate from ${from} (no remote description)`);
            return;
        }

        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            logger.warn('Candidate Error', e);
        }
    }

    private async flushCandidates(peerId: string, pc: RTCPeerConnection) {
        const queue = this.pendingCandidates.get(peerId);
        if (queue && queue.length > 0) {
            logger.conn(`Flushing ${queue.length} candidates for ${peerId}`);
            for (const cand of queue) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(cand));
                } catch (e) {
                    logger.warn('Candidate Flush Error', e);
                }
            }
            this.pendingCandidates.delete(peerId);
        }
    }

    /**
     * Closes all peer connections gracefully.
     */
    public closeAll() {
        for (const peerId of Array.from(this.peers.keys())) {
            this.cleanupPeer(peerId);
        }
    }

    private createPeerConnection(peerId: string): RTCPeerConnection {
        const pc = new RTCPeerConnection({
            iceServers: this.config.iceServers
        });

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this.listeners.onSignal?.(peerId, { type: 'candidate', candidate: e.candidate });
            }
        };

        pc.ondatachannel = (e) => {
            logger.conn(`Received DataChannel from ${peerId}`);
            this.setupDataChannel(peerId, e.channel);
        };

        this.peers.set(peerId, pc);
        return pc;
    }

    private setupDataChannel(peerId: string, dc: RTCDataChannel) {
        dc.binaryType = 'arraybuffer';

        let joinTriggered = false;
        const onOpen = () => {
            if (joinTriggered) return;
            joinTriggered = true;
            logger.conn(`DataChannel Open with ${peerId}`);
            try {
                this.listeners.onPeerJoin?.(peerId);
            } catch (e) {
                logger.error(`Error in onPeerJoin for ${peerId}:`, e);
            }
        };

        dc.onopen = onOpen;
        if (dc.readyState === 'open') {
            onOpen();
        }

        dc.onmessage = (e) => {
            try {
                // node-datachannel / wrtc might return Buffer or ArrayBuffer
                let data: Uint8Array;
                if (e.data instanceof ArrayBuffer) {
                    data = new Uint8Array(e.data);
                } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(e.data)) {
                    data = new Uint8Array(e.data);
                } else if (e.data instanceof Uint8Array) {
                    data = e.data;
                } else if (e.data && typeof e.data === 'object' && ('byteLength' in e.data || 'length' in e.data)) {
                    // Fallback for Node.js Buffer / strange polyfill types
                    data = new Uint8Array(e.data);
                } else {
                    this.logger.warn(`Unknown data type received from ${peerId}:`, typeof e.data, e.data?.constructor?.name);
                    return;
                }

                this.logger.info(`[P2P] Received ${data.byteLength} bytes from ${peerId}`);
                this.listeners.onMessage?.(peerId, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
            } catch (fatal) {
                this.logger.error(`Critical DataChannel Error (Peer ${peerId})`, fatal);
            }
        };

        dc.onclose = () => {
            logger.conn(`DataChannel Closed with ${peerId}`);
            this.cleanupPeer(peerId);
        };

        dc.onerror = (e) => {
            logger.error(`DataChannel Error with ${peerId}:`, e);
            this.listeners.onError?.(peerId, new Error(`DataChannel Error: ${JSON.stringify(e)}`));
        };

        this.dataChannels.set(peerId, dc);
    }

    private cleanupPeer(peerId: string) {
        let removed = false;

        const pc = this.peers.get(peerId);
        if (pc) {
            this.peers.delete(peerId); // Remove first to prevent recursion
            try {
                pc.close();
            } catch (e) { /* ignore */ }
            removed = true;
        }

        if (this.dataChannels.has(peerId)) {
            this.dataChannels.delete(peerId);
            removed = true;
        }

        if (removed) {
            try {
                this.listeners.onPeerDisconnect?.(peerId);
            } catch (e) {
                logger.error(`Error in onPeerDisconnect for ${peerId}:`, e);
            }
        }
    }
}
