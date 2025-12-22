
/**
 * @file MeshClient.ts
 * @brief High-level P2P mesh client for real-time multiplayer applications.
 *
 * Provides a simple, event-driven API for building P2P mesh networks.
 * Handles signaling, connection management, and peer coordination.
 *
 * @example
 * ```typescript
 * import { MeshClient } from 'nmeshed/mesh';
 *
 * const mesh = new MeshClient({
 *     workspaceId: 'game-room-1',
 *     token: 'jwt-token',
 * });
 *
 * await mesh.connect();
 *
 * mesh.on('peerJoin', (peerId) => {
 *     console.log(`${peerId} joined the mesh`);
 * });
 *
 * mesh.on('message', (peerId, data) => {
 *     // Handle incoming binary data from peer
 * });
 *
 * mesh.broadcast(myGameState);
 * ```
 */

import { SignalingClient } from './SignalingClient';
import { ConnectionManager } from './ConnectionManager';
import type {
    MeshClientConfig,
    ResolvedMeshConfig,
    MeshConnectionStatus,
    MeshEventMap,
    SignalEnvelope,
    OfferSignal,
    AnswerSignal,
    CandidateSignal,
} from './types';
import { logger } from '../utils/Logger';

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: Omit<ResolvedMeshConfig, 'workspaceId' | 'token' | 'tokenProvider'> = {
    serverUrl: 'wss://api.nmeshed.com/v1/sync',
    topology: 'mesh',
    debug: false,
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

/**
 * High-level P2P mesh client.
 */
export class MeshClient {
    private config: ResolvedMeshConfig;
    private signaling: SignalingClient;
    private connections: ConnectionManager;
    private status: MeshConnectionStatus = 'IDLE';
    private myId: string;
    private peerStatus: Map<string, 'relay' | 'p2p'> = new Map();

    // Event listeners
    private eventListeners: Map<keyof MeshEventMap, Set<Function>> = new Map();

    constructor(config: MeshClientConfig) {
        if (!config.workspaceId || (!config.token && !config.tokenProvider)) {
            throw new Error('MeshClient requires workspaceId and either token or tokenProvider');
        }

        this.config = {
            ...DEFAULT_CONFIG,
            ...config,
            iceServers: config.iceServers || DEFAULT_CONFIG.iceServers,
        } as ResolvedMeshConfig;

        if (this.config.debug) {
            logger.enableDebug();
        }

        this.myId = this.generateId();

        // Initialize signaling client
        // Ensure we don't double up the workspace ID if it's already in the serverUrl
        const baseUrl = this.config.serverUrl.endsWith(this.config.workspaceId)
            ? this.config.serverUrl
            : `${this.config.serverUrl}/${encodeURIComponent(this.config.workspaceId)}`;

        this.signaling = new SignalingClient({
            url: baseUrl,
            token: this.config.token,
            tokenProvider: this.config.tokenProvider,
            workspaceId: this.config.workspaceId,
            myId: this.myId,
        });

        // Initialize connection manager
        this.connections = new ConnectionManager({
            iceServers: this.config.iceServers,
        });

        this.setupListeners();
    }

    /**
     * Updates the authentication token.
     */
    public updateToken(token: string): void {
        this.config.token = token;
        this.signaling.updateToken(token);
    }

    /**
     * Connects to the mesh network.
     */
    public async connect(): Promise<void> {
        if (this.status === 'CONNECTED' || this.status === 'CONNECTING') {
            return;
        }

        this.setStatus('CONNECTING');
        this.signaling.connect();
    }

    /**
     * Disconnects from the mesh network.
     */
    public disconnect(): void {
        this.connections.closeAll();
        this.signaling.close();
        this.setStatus('DISCONNECTED');
        this.emit('disconnect');
    }

    /**
     * Broadcasts binary data to all connected peers.
     * Uses Hybrid Routing: P2P for peers with open DataChannels, Relay for others.
     */
    public broadcast(data: ArrayBuffer | Uint8Array): void {
        const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : data;

        // 1. Send via Relay (WebSocket) to everyone not yet on P2P
        // We also send to "server" if we want authority processing
        this.peerStatus.forEach((status, peerId) => {
            if (status !== 'p2p') {
                this.signaling.sendSignal(peerId, { type: 'relay', data: u8 });
            }
        });

        // 2. Send via P2P (DataChannel)
        this.connections.broadcast(data);
    }

    /**
     * Sends binary data to a specific peer.
     * Uses Hybrid Routing: Prioritizes P2P (WebRTC) if the DataChannel is open,
     * otherwise falls back to WebSocket Relay to ensure delivery.
     */
    public sendToPeer(peerId: string, data: ArrayBuffer | Uint8Array): void {
        const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        const status = this.peerStatus.get(peerId);

        // Routing Decision: If P2P is active and verified, use it.
        // Otherwise, use the reliable Relay path.
        if (status === 'p2p' && this.connections.isDirect(peerId)) {
            this.connections.sendToPeer(peerId, data);
        } else {
            this.signaling.sendSignal(peerId, { type: 'relay', data: u8 });
        }
    }

    /**
     * Sends binary data to the central authority (Server).
     */
    public sendToAuthority(data: Uint8Array): void {
        this.signaling.sendSync(data);
    }

    /**
     * Sends ephemeral JSON data (cursors, typing indicators) to server and peers.
     * Note: Server handles broadcasting this to other peers if configured.
     */
    public sendEphemeral(payload: any, to?: string): void {
        this.signaling.sendEphemeral(payload, to);
    }

    /**
     * Gets the list of connected peer IDs.
     */
    public getPeers(): string[] {
        return this.connections.getPeerIds();
    }

    /**
     * Gets the current connection status.
     */
    public getStatus(): MeshConnectionStatus {
        return this.status;
    }

    /**
     * Gets this client's unique ID.
     */
    public getId(): string {
        return this.myId;
    }

    /**
     * Subscribes to mesh events.
     */
    public on<K extends keyof MeshEventMap>(event: K, handler: MeshEventMap[K]): () => void {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, new Set());
        }
        this.eventListeners.get(event)!.add(handler);

        // Return unsubscribe function
        return () => {
            this.eventListeners.get(event)?.delete(handler);
        };
    }

    /**
     * Removes an event listener.
     */
    public off<K extends keyof MeshEventMap>(event: K, handler: MeshEventMap[K]): void {
        this.eventListeners.get(event)?.delete(handler);
    }

    private setupListeners(): void {
        // Signaling events
        this.signaling.setListeners({
            onConnect: () => {
                this.setStatus('CONNECTED');
                this.emit('connect');
            },
            onDisconnect: () => {
                if (this.status !== 'DISCONNECTED') {
                    this.setStatus('RECONNECTING');
                }
            },
            onSignal: (envelope) => this.handleSignal(envelope),
            onPresence: (userId, status, meshId) => this.handlePresence(userId, status, meshId),
            onError: (err) => this.emit('error', err),
            onServerMessage: (data) => this.emit('authorityMessage', data),
            onInit: (data) => this.emit('init', data),
            onEphemeral: (payload) => this.emit('ephemeral', payload),
        });

        // Connection events
        this.connections.setListeners({
            onSignal: (to, signal) => this.signaling.sendSignal(to, signal),
            onMessage: (peerId, data) => this.emit('message', peerId, data),
            onPeerJoin: (peerId) => {
                this.peerStatus.set(peerId, 'p2p');
                this.emit('peerStatus', peerId, 'p2p');
                this.emit('peerJoin', peerId);
            },
            onPeerDisconnect: (peerId) => {
                this.peerStatus.delete(peerId);
                this.emit('peerDisconnect', peerId);
            },
        });
    }

    private handleSignal(envelope: SignalEnvelope): void {
        const { from, signal } = envelope;
        if (from === this.myId) return;

        logger.mesh(`Signal from ${from}: ${signal.type}`);

        switch (signal.type) {
            case 'join':
                // New peer announced, initiate connection
                if (this.config.topology !== 'star') {
                    this.connections.initiateConnection(from);
                }
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
            case 'relay':
                // Incoming relayed P2P message
                // Safety: Convert to ArrayBuffer correctly (respecting view offsets if any)
                const arrayBuffer = (signal as any).data.buffer.slice(
                    (signal as any).data.byteOffset,
                    (signal as any).data.byteOffset + (signal as any).data.byteLength
                );
                this.emit('message', from, arrayBuffer);
                break;
        }
    }

    private handlePresence(userId: string, status: string, meshId?: string): void {
        logger.mesh(`Presence: ${userId} (${meshId}) is ${status}`);

        const peerId = meshId || userId;
        if (peerId !== this.myId) {
            if (status === 'online') {
                // Initialize as Relay
                if (!this.peerStatus.has(peerId)) {
                    this.peerStatus.set(peerId, 'relay');
                    this.emit('peerStatus', peerId, 'relay');
                    this.emit('peerJoin', peerId); // Trigger join immediately via Relay
                }

                // Deterministic connection initiation to avoid glare
                if (this.myId > peerId && this.config.topology !== 'star') {
                    this.connections.initiateConnection(peerId);
                }
            } else if (status === 'offline') {
                this.peerStatus.delete(peerId);
                this.emit('peerDisconnect', peerId);
            }
        }
    }

    private setStatus(newStatus: MeshConnectionStatus): void {
        if (this.status !== newStatus) {
            logger.mesh(`Status: ${this.status} -> ${newStatus}`);
            this.status = newStatus;
            this.emit('statusChange', newStatus);
        }
    }

    private emit<K extends keyof MeshEventMap>(event: K, ...args: Parameters<MeshEventMap[K]>): void {
        const listeners = this.eventListeners.get(event);
        if (listeners) {
            for (const handler of listeners) {
                try {
                    (handler as Function)(...args);
                } catch (e) {
                    logger.error(`Error in ${event} handler:`, e);
                }
            }
        }
    }

    /**
     * Permanently destroys the MeshClient, closing all connections and removing listeners.
     */
    public destroy(): void {
        this.setStatus('DISCONNECTED');
        this.connections.closeAll();
        this.signaling.close();
        this.eventListeners.clear();
        this.peerStatus.clear();
        logger.mesh('MeshClient destroyed.');
    }

    private generateId(): string {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        return 'mesh-' + Math.random().toString(36).substring(2, 11);
    }
}
