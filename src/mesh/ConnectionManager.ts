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
import { logger } from '../utils/Logger';

export interface ConnectionEvents {
    onSignal: (to: string, signal: SignalMessage) => void;
    onMessage: (peerId: string, data: ArrayBuffer) => void;
    onPeerJoin: (peerId: string) => void;
    onPeerDisconnect: (peerId: string) => void;
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
    private listeners: Partial<ConnectionEvents> = {};
    private config: ConnectionManagerConfig;

    constructor(config: ConnectionManagerConfig) {
        this.config = config;
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
     * Broadcasts binary data to all connected peers.
     */
    public broadcast(data: ArrayBuffer | Uint8Array) {
        const buffer = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        this.dataChannels.forEach(dc => {
            if (dc.readyState === 'open') {
                dc.send(buffer as unknown as ArrayBuffer);
            }
        });
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
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.listeners.onSignal?.(from, { type: 'answer', sdp: answer.sdp! });
        } catch (err) {
            logger.error('Offer Error', err);
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
            } else {
                logger.warn(`Ignored answer in state: ${pc.signalingState}`);
            }
        } catch (err) {
            logger.error('Answer Error', err);
        }
    }

    /**
     * Handles an incoming ICE candidate from a peer.
     */
    public async handleCandidate(from: string, candidate: RTCIceCandidateInit) {
        const pc = this.peers.get(from);
        if (!pc) return;
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            logger.warn('Candidate Error', e);
        }
    }

    /**
     * Closes all peer connections gracefully.
     */
    public closeAll() {
        for (const peerId of this.peers.keys()) {
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

        const onOpen = () => {
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
                if (e.data instanceof ArrayBuffer) {
                    this.listeners.onMessage?.(peerId, e.data);
                }
            } catch (fatal) {
                logger.error(`Critical DataChannel Error (Peer ${peerId})`, fatal);
            }
        };

        dc.onclose = () => {
            logger.conn(`DataChannel Closed with ${peerId}`);
            this.cleanupPeer(peerId);
        };

        dc.onerror = (e) => {
            logger.error(`DataChannel Error with ${peerId}:`, e);
        };

        this.dataChannels.set(peerId, dc);
    }

    private cleanupPeer(peerId: string) {
        const pc = this.peers.get(peerId);
        if (pc) {
            pc.close();
            this.peers.delete(peerId);
        }
        this.dataChannels.delete(peerId);

        try {
            this.listeners.onPeerDisconnect?.(peerId);
        } catch (e) {
            logger.error(`Error in onPeerDisconnect for ${peerId}:`, e);
        }
    }
}
