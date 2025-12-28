import { EventEmitter } from '../utils/EventEmitter';
import { Transport, TransportEvents, TransportStatus } from './Transport';
import { SignalingClient } from './p2p/SignalingClient';
import { ConnectionManager } from './p2p/ConnectionManager';
import { SignalEnvelope, OfferSignal, AnswerSignal, CandidateSignal } from './p2p/types';
import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';
import { Op } from '../schema/nmeshed/op';
import { SyncPacket } from '../schema/nmeshed/sync-packet';
import { logger } from '../utils/Logger';

/**
 * P2P Transport implementation using WebRTC Mesh.
 * Absorbs the logic previously in MeshClient.
 */
export class P2PTransport extends EventEmitter<TransportEvents> implements Transport {
    private signaling: SignalingClient;
    private connections: ConnectionManager;
    private status: TransportStatus = 'DISCONNECTED';
    private myId: string;
    private peerStatus: Map<string, 'relay' | 'p2p'> = new Map();
    private syncTimeout: ReturnType<typeof setTimeout> | null = null;
    private latency = 0;
    private packetLoss = 0;
    private pingResolvers: Map<string, (latency: number) => void> = new Map();
    private pingStarts: Map<string, number> = new Map();
    private metrics = {
        relayedBytes: 0,
        broadcastedBytes: 0,
        totalOps: 0
    };

    constructor(config: { userId?: string, serverUrl?: string, workspaceId: string, token?: string, tokenProvider?: () => Promise<string>, iceServers?: RTCIceServer[], debug?: boolean, aggressiveRelay?: boolean }) {
        super();
        this.myId = config.userId || this.generateId();

        // Ensure we don't double up the workspace ID if it's already in the serverUrl
        const serverUrl = config.serverUrl || 'ws://localhost:8080';
        const baseUrl = serverUrl.endsWith(config.workspaceId)
            ? serverUrl
            : `${serverUrl.replace(/\/$/, '')}/${encodeURIComponent(config.workspaceId)}`;

        this.signaling = new SignalingClient({
            url: baseUrl,
            token: config.token,
            tokenProvider: config.tokenProvider,
            workspaceId: config.workspaceId,
            myId: this.myId,
            debug: config.debug
        });

        this.connections = new ConnectionManager({
            iceServers: config.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }],
        }, config.debug);

        this.setupInternalListeners();
    }

    public async connect(heads?: string[]): Promise<void> {
        if (this.status === 'CONNECTED' || this.status === 'CONNECTING') return;

        this.setStatus('CONNECTING');
        try {
            this.signaling.connect(heads);
            // The status will transition to CONNECTED via onConnect listener
        } catch (err) {
            this.emit('error', err instanceof Error ? err : new Error(String(err)));
            this.setStatus('ERROR');
            throw err;
        }
    }

    public disconnect(): void {
        this.connections.closeAll();
        this.signaling.close();
        if (this.syncTimeout) {
            clearTimeout(this.syncTimeout);
            this.syncTimeout = null;
        }
        this.setStatus('DISCONNECTED');
    }

    public getStatus(): TransportStatus {
        return this.status;
    }

    public send(data: Uint8Array): void {
        // Wrap raw CRDT delta into a WirePacket [MsgType.Op] before broadcasting
        const builder = new flatbuffers.Builder(1024);
        const valOffset = Op.createValueVector(builder, data);
        const workspaceOffset = builder.createString('');
        const keyOffset = builder.createString('');

        Op.startOp(builder);
        Op.addWorkspaceId(builder, workspaceOffset);
        Op.addKey(builder, keyOffset);
        Op.addTimestamp(builder, BigInt(Date.now()));
        Op.addValue(builder, valOffset);
        const opOffset = Op.endOp(builder);

        WirePacket.startWirePacket(builder);
        WirePacket.addMsgType(builder, MsgType.Op);
        WirePacket.addOp(builder, opOffset);
        const packetOffset = WirePacket.endWirePacket(builder);
        builder.finish(packetOffset);

        this.broadcast(builder.asUint8Array());
    }

    public broadcast(data: Uint8Array | ArrayBuffer): void {
        this.metrics.totalOps++;
        const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : data;

        if (this.packetLoss > 0 && Math.random() < this.packetLoss) {
            return;
        }

        const task = () => {
            // HYBRID-FIRST: Default to server relay with P2P as cost-saving optimization
            const useAggressive = (this as any).config?.aggressiveRelay ?? true;
            // 1. Send via Relay (WebSocket)
            this.peerStatus.forEach((status, peerId) => {
                if (status !== 'p2p' || useAggressive) {
                    this.signaling.sendSignal(peerId, { type: 'relay', data: u8 });
                    this.metrics.relayedBytes += u8.byteLength;
                }
            });

            // 2. Send via P2P (DataChannel)
            this.connections.broadcast(u8);
            const p2pPeerCount = Array.from(this.peerStatus.values()).filter(s => s === 'p2p').length;
            this.metrics.broadcastedBytes += u8.byteLength * p2pPeerCount;
        };

        if (this.latency > 0) {
            setTimeout(task, this.latency);
        } else {
            task();
        }

        const isDebug = (this as any).config?.debug;
        if (isDebug) {
            const peers = Array.from(this.peerStatus.keys());
            logger.debug(`[P2PTransport] broadcast: ${u8.byteLength} bytes to ${peers.length} targets: ${peers.join(',')}`);
        }

        // P2P "Self-ACK": Since there's no central server to confirm,
        // we acknowledge the transmission immediately to clear the client's queue.
        this.emit('ack', 1);
    }

    public sendEphemeral(payload: any, to?: string): void {
        if (this.packetLoss > 0 && Math.random() < this.packetLoss) {
            return;
        }

        if (this.latency > 0) {
            setTimeout(() => this.signaling.sendEphemeral(payload, to), this.latency);
        } else {
            this.signaling.sendEphemeral(payload, to);
        }
    }

    public simulateLatency(ms: number): void {
        this.latency = ms;
    }

    public simulatePacketLoss(rate: number): void {
        this.packetLoss = rate;
    }

    public getPeers(): string[] {
        return Array.from(this.peerStatus.keys());
    }

    public getMetrics() {
        return { ...this.metrics, latency: this.latency };
    }

    public async ping(peerId: string): Promise<number> {
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(2, 11);
            const start = performance.now();

            const timeout = setTimeout(() => {
                this.pingResolvers.delete(requestId);
                this.pingStarts.delete(requestId);
                reject(new Error('Ping timeout'));
            }, 5000);

            this.pingStarts.set(requestId, start);

            this.pingResolvers.set(requestId, (latency) => {
                clearTimeout(timeout);
                resolve(latency);
            });

            this.sendEphemeral({
                type: '__ping__',
                requestId,
                from: this.myId,
                timestamp: Date.now()
            }, peerId);
        });
    }

    private setStatus(s: TransportStatus): void {
        if (this.status !== s) {
            this.status = s;
            this.emit('status', s);
        }
    }

    private setupInternalListeners(): void {
        this.signaling.setListeners({
            onConnect: () => {
                this.setStatus('CONNECTED');
                // Start sync timeout - if no init received in 5s, we might be the first
                this.syncTimeout = setTimeout(() => {
                    // Transition to active-like state if needed
                }, 5000);
            },
            onDisconnect: () => {
                this.setStatus('DISCONNECTED');
            },
            onSignal: (envelope: SignalEnvelope) => this.handleSignal(envelope),
            onPresence: (userId: string, status: string, meshId?: string) => this.handlePresence(userId, status, meshId),
            onError: (err: Error) => {
                this.setStatus('ERROR');
                this.emit('error', err);
            },
            onInit: (sync: SyncPacket) => {
                // Emit as 'message' to follow unified binary pipeline
                this.emit('message', sync.bb!.bytes());
            },
            onServerMessage: (data: Uint8Array) => {
                this.handleRawMessage(data);
            },
            onEphemeral: (payload: any, from?: string) => {
                if (payload && payload.type === '__ping__') {
                    this.sendEphemeral({
                        type: '__pong__',
                        requestId: payload.requestId,
                        from: this.myId,
                        timestamp: Date.now()
                    }, from);
                    return;
                }
                if (payload && payload.type === '__pong__') {
                    const resolver = this.pingResolvers.get(payload.requestId);
                    if (resolver) {
                        const latency = performance.now() - (this.pingStarts.get(payload.requestId) || 0);
                        this.pingResolvers.delete(payload.requestId);
                        this.pingStarts.delete(payload.requestId);
                        resolver(latency || 0);
                    }
                }
                this.emit('ephemeral', payload, from);
            },
        });

        this.connections.setListeners({
            onSignal: (to: string, signal: any) => this.signaling.sendSignal(to, signal),
            onMessage: (_peerId: string, data: Uint8Array | ArrayBuffer) => {
                this.handleRawMessage(new Uint8Array(data));
            },
            onPeerJoin: (peerId: string) => {
                this.peerStatus.set(peerId, 'p2p');
                this.emit('peerJoin', peerId);
            },
            onPeerDisconnect: (peerId: string) => {
                this.peerStatus.set(peerId, 'relay');
                this.emit('peerDisconnect', peerId);
            },
            onError: (_peerId: string, err: Error) => {
                this.emit('error', err);
            }
        });
    }

    private handleSignal(envelope: SignalEnvelope): void {
        if (!envelope || !envelope.from || !envelope.signal) return;
        const { from, signal } = envelope;
        if (from === this.myId) return;

        switch (signal.type) {
            case 'join':
                this.connections.initiateConnection(from);
                break;
            case 'offer':
                this.connections.handleOffer(from, (signal as OfferSignal).sdp);
                break;
            case 'answer':
                this.connections.handleAnswer(from, (signal as AnswerSignal).sdp);
                break;
            case 'candidate':
                this.connections.handleCandidate(from, (signal as CandidateSignal).candidate);
                break;
            case 'relay': {
                const data = (signal as any).data;
                if (data) this.handleRawMessage(new Uint8Array(data));
                break;
            }
        }
    }

    /**
     * Handle raw message from P2P peers or relay.
     * 
     * Following the "Dumb Pipe" principle: Transport moves bytes, SyncEngine parses them.
     * All WirePacket parsing is handled by MessageRouter in SyncEngine.
     */
    private handleRawMessage(data: Uint8Array): void {
        const isRelay = (this as any).signaling?.connected;
        logger.debug(`[P2PTransport] handleRawMessage: ${data.byteLength} bytes (Relay=${isRelay})`);
        this.emit('message', data);
    }

    private handlePresence(userId: string, status: string, meshId?: string): void {
        const peerId = meshId || userId;
        if (peerId !== this.myId) {
            if (status === 'online') {
                if (!this.peerStatus.has(peerId)) {
                    this.peerStatus.set(peerId, 'relay');
                    this.emit('peerJoin', peerId);
                }
                // Deterministic connection initiation
                if (this.myId > peerId) {
                    this.connections.initiateConnection(peerId);
                }
            } else if (status === 'offline') {
                this.peerStatus.delete(peerId);
                this.emit('peerDisconnect', peerId);
            }
        }
    }

    private generateId(): string {
        return 'p2p-' + Math.random().toString(36).substring(2, 11);
    }
}
