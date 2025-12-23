
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
    MeshLifecycleState,
    MeshEventMap,
    SignalEnvelope,
    OfferSignal,
    AnswerSignal,
    CandidateSignal,
    ChaosOptions,
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
    private state: MeshLifecycleState = 'IDLE';
    private myId: string;
    private peerStatus: Map<string, 'relay' | 'p2p'> = new Map();

    private syncTimeout: ReturnType<typeof setTimeout> | null = null;
    private chaos: ChaosOptions | null = null;
    private pendingPings: Map<string, (rtt: number) => void> = new Map();

    // Event listeners
    private eventListeners: Map<keyof MeshEventMap, Set<(...args: any[]) => void>> = new Map();

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
     * @param wasmInit - Optional async function to initialize WASM before connecting.
     */
    public async connect(wasmInit?: () => Promise<void>): Promise<void> {
        if (this.state !== 'IDLE' && this.state !== 'DISCONNECTED' && this.state !== 'ERROR') {
            return;
        }

        if (wasmInit) {
            this.setState('INITIALIZING');
            try {
                await wasmInit();
            } catch (e) {
                logger.error('WASM Initialization failed', e);
                this.setState('ERROR');
                this.emit('error', e instanceof Error ? e : new Error(String(e)));
                return;
            }
        }

        this.setState('CONNECTING');
        this.signaling.connect();
    }

    /**
     * Disconnects from the mesh network.
     */
    public disconnect(): void {
        this.connections.closeAll();
        this.signaling.close();
        this.setState('DISCONNECTED');
        this.emit('disconnect');
    }

    /**
     * Broadcasts binary data to all connected peers.
     * Uses Hybrid Routing: P2P for peers with open DataChannels, Relay for others.
     * Note: No-op if sync state is not ACTIVE (prevents empty snapshots before hydration).
     */
    public broadcast(data: ArrayBuffer | Uint8Array): void {
        this.withChaos(() => {
            if (!this.canSend()) {
                logger.mesh('Broadcast blocked - state is ' + this.state);
                return;
            }

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
        });
    }

    /**
     * Sends binary data to a specific peer.
     * Uses Hybrid Routing: Prioritizes P2P (WebRTC) if the DataChannel is open,
     * otherwise falls back to WebSocket Relay to ensure delivery.
     * Note: No-op if sync state is not ACTIVE (prevents empty snapshots before hydration).
     */
    public sendToPeer(peerId: string, data: ArrayBuffer | Uint8Array): void {
        this.withChaos(() => {
            if (!this.canSend()) {
                logger.mesh('SendToPeer blocked - state is ' + this.state);
                return;
            }

            const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
            const status = this.peerStatus.get(peerId);

            // Routing Decision: If P2P is active and verified, use it.
            // Otherwise, use the reliable Relay path.
            if (status === 'p2p' && this.connections.isDirect(peerId)) {
                this.connections.sendToPeer(peerId, data);
            } else {
                this.signaling.sendSignal(peerId, { type: 'relay', data: u8 });
            }
        });
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
     * Broadcasts cursor position to all peers via ephemeral messaging.
     * Convenience method that uses the standard nMeshed cursor protocol.
     *
     * @param x - X coordinate
     * @param y - Y coordinate
     */
    public sendCursor(x: number, y: number): void {
        this.sendEphemeral({
            type: '__cursor__',
            namespace: 'cursor',
            userId: this.myId,
            x: Math.round(x),
            y: Math.round(y),
            timestamp: Date.now(),
        });
    }

    /**
     * Measures Round-Trip Time (RTT) to a specific peer.
     * @param peerId - The ID of the peer to ping
     * @returns Promise resolving to the RTT in milliseconds
     */
    public async ping(peerId: string): Promise<number> {
        return new Promise((resolve) => {
            const requestId = Math.random().toString(36).substring(2, 11);
            const start = performance.now();

            const timer = setTimeout(() => {
                this.pendingPings.delete(requestId);
                resolve(-1); // Timeout
            }, 5000);

            this.pendingPings.set(requestId, (rtt) => {
                clearTimeout(timer);
                resolve(rtt);
            });

            this.sendEphemeral({
                type: '__ping__',
                requestId,
                from: this.myId,
                timestamp: start,
            }, peerId);
        });
    }

    /**
     * Enables artificial network conditions for testing.
     * @param options - Chaos configuration
     */
    public simulateNetwork(options: ChaosOptions | null): void {
        this.chaos = options;
        if (options) {
            logger.warn('Network Chaos Mode ENABLED:', options);
        } else {
            logger.mesh('Network Chaos Mode DISABLED');
        }
    }

    private withChaos(fn: () => void): void {
        if (!this.chaos) {
            fn();
            return;
        }

        // 1. Packet Loss
        if (this.chaos.packetLoss && Math.random() * 100 < this.chaos.packetLoss) {
            logger.mesh('Chaos: Packet dropped');
            return;
        }

        // 2. Latency + Jitter
        let delay = this.chaos.latency || 0;
        if (this.chaos.jitter) {
            delay += (Math.random() * 2 - 1) * this.chaos.jitter;
        }

        if (delay > 0) {
            setTimeout(fn, delay);
        } else {
            fn();
        }
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
    public getStatus(): MeshLifecycleState {
        return this.state;
    }

    /**
     * Gets this client's unique ID.
     */
    public getId(): string {
        return this.myId;
    }

    /**
     * Gets the current sync state.
     */
    public getState(): MeshLifecycleState {
        return this.state;
    }

    public canSend(): boolean {
        return this.state === 'ACTIVE';
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
                this.setState('HANDSHAKING');
                this.emit('connect');
                // Start sync timeout - if no init received in 5s, assume we are the authority
                this.syncTimeout = setTimeout(() => {
                    if (this.state !== 'ACTIVE') {
                        logger.mesh('Sync timeout - transitioning to ACTIVE');
                        this.setState('ACTIVE');
                    }
                }, 5000);
            },
            onDisconnect: () => {
                if (this.state !== 'DISCONNECTED') {
                    this.setState('RECONNECTING');
                }
            },
            onSignal: (envelope) => this.handleSignal(envelope),
            onPresence: (userId, status, meshId) => this.handlePresence(userId, status, meshId),
            onError: (err) => {
                this.setState('ERROR');
                this.emit('error', err);
            },
            onServerMessage: (data) => {
                // Transition to ACTIVE on authoritative server message
                if (this.state !== 'ACTIVE') {
                    this.setState('ACTIVE');
                }
                this.emit('authorityMessage', data);
            },
            onInit: (data) => {
                const actualPayload = data.payload || data;
                const resolvedId = actualPayload.workspace_id || actualPayload.workspaceId;

                if (resolvedId && resolvedId.length === 36 && this.config.workspaceId !== resolvedId) {
                    logger.mesh(`Authoritative UUID resolved: ${resolvedId}`);
                    this.config.workspaceId = resolvedId;
                }

                // Transition HANDSHAKING -> SYNCING -> ACTIVE
                this.setState('SYNCING');
                this.emit('init', actualPayload);
                this.setState('ACTIVE');
            },
            onEphemeral: (payload) => {
                // Internal diagnostic handlers
                if (payload.type === '__ping__') {
                    this.sendEphemeral({
                        type: '__pong__',
                        requestId: payload.requestId,
                        from: this.myId,
                        timestamp: payload.timestamp,
                    }, payload.from);
                    return;
                }

                if (payload.type === '__pong__') {
                    const handler = this.pendingPings.get(payload.requestId);
                    if (handler) {
                        const rtt = performance.now() - payload.timestamp;
                        this.pendingPings.delete(payload.requestId);
                        handler(rtt);
                    }
                    return;
                }

                this.emit('ephemeral', payload);
            },
        });

        // Connection events
        this.connections.setListeners({
            onSignal: (to, signal) => this.signaling.sendSignal(to, signal),
            onMessage: (peerId, data) => {
                // Transition to ACTIVE on first P2P message (peer has state)
                if (this.state === 'HANDSHAKING' || this.state === 'CONNECTING') {
                    this.setState('ACTIVE');
                }
                this.emit('message', peerId, data);
            },
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
        if (!envelope || !envelope.from || !envelope.signal) return;
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
            case 'relay': {
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

    private setState(newState: MeshLifecycleState): void {
        if (this.state !== newState) {
            logger.mesh(`Lifecycle: ${this.state} -> ${newState}`);
            this.state = newState;
            this.emit('lifecycleStateChange', newState);

            // Clear timeout once we reach ACTIVE
            if (newState === 'ACTIVE' && this.syncTimeout) {
                clearTimeout(this.syncTimeout);
                this.syncTimeout = null;
            }
        }
    }

    private emit<K extends keyof MeshEventMap>(event: K, ...args: Parameters<MeshEventMap[K]>): void {
        const listeners = this.eventListeners.get(event);
        if (listeners) {
            for (const handler of listeners) {
                try {
                    (handler as (...args: any[]) => void)(...args);
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
        this.setState('DISCONNECTED');
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
