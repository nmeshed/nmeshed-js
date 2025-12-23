/**
 * @file types.ts
 * @brief TypeScript type definitions for mesh signaling and connections.
 *
 * Defines discriminated union types for all signal messages exchanged
 * during WebRTC connection establishment, plus mesh configuration types.
 */

// ============================================
//           SIGNAL TYPES
// ============================================

export type SignalType = 'join' | 'offer' | 'answer' | 'candidate' | 'relay';

/** Structured error codes for MeshClient and ConnectionManager */
export enum MeshErrorCode {
    SIGNALING_FAILED = 'MESH_ERR_SIGNALING',
    P2P_HANDSHAKE_FAILED = 'MESH_ERR_P2P',
    RELAY_TIMEOUT = 'MESH_ERR_RELAY_TIMEOUT',
    TOPOLOGY_DEGRADED = 'MESH_ERR_TOPOLOGY',
    WASM_INIT_FAILED = 'MESH_ERR_WASM',
}

export interface BaseSignal {
    type: SignalType;
}

export interface JoinSignal extends BaseSignal {
    type: 'join';
    workspaceId: string;
}

export interface OfferSignal extends BaseSignal {
    type: 'offer';
    sdp: string;
}

export interface AnswerSignal extends BaseSignal {
    type: 'answer';
    sdp: string;
}

export interface CandidateSignal extends BaseSignal {
    type: 'candidate';
    candidate: RTCIceCandidateInit;
}

export interface RelaySignal extends BaseSignal {
    type: 'relay';
    data: Uint8Array;
}

export type SignalMessage = JoinSignal | OfferSignal | AnswerSignal | CandidateSignal | RelaySignal;

export interface SignalEnvelope {
    from: string;
    signal: SignalMessage;
}

// ============================================
//           MESH CLIENT TYPES
// ============================================

export type MeshTopology = 'star' | 'mesh' | 'hybrid';

/**
 * Unified lifecycle state machine for the MeshClient.
 * Coordinates WASM initialization, signaling connection, and authoritative sync.
 */
export type MeshLifecycleState =
    | 'IDLE'
    | 'INITIALIZING' // Loading WASM module
    | 'CONNECTING'   // Establishing WebSocket signaling
    | 'HANDSHAKING'  // WebSocket open, awaiting authoritative 'init' message
    | 'SYNCING'      // 'init' received, applying persistent history/state
    | 'ACTIVE'       // Fully synchronized and ready for interaction
    | 'RECONNECTING' // Re-establishing signaling after loss
    | 'DISCONNECTED' // Intentionally closed
    | 'ERROR';       // Critical failure


export interface MeshClientConfig {
    /** Unique workspace/room identifier */
    workspaceId: string;

    /** Authentication token */
    token?: string;

    /** Dynamic authentication token provider (refreshes expired tokens) */
    tokenProvider?: () => Promise<string>;

    /** Signaling server URL (defaults to wss://api.nmeshed.com) */
    serverUrl?: string;

    /** Network topology mode */
    topology?: MeshTopology;

    /** Enable debug logging */
    debug?: boolean;

    /** ICE servers for WebRTC (defaults to Google STUN) */
    iceServers?: RTCIceServer[];

    /** Maximum peers before auto-downgrading to star topology (default: 30) */
    maxPeersForMesh?: number;

    /** Interval for connection quality metrics updates in ms (default: 10000) */
    metricsInterval?: number;
}

export interface ResolvedMeshConfig extends Omit<Required<MeshClientConfig>, 'iceServers' | 'token' | 'tokenProvider' | 'maxPeersForMesh' | 'metricsInterval'> {
    token?: string;
    tokenProvider?: () => Promise<string>;
    iceServers: RTCIceServer[];
    maxPeersForMesh: number;
    metricsInterval: number;
}

/** Individual peer connection quality metrics */
export interface MeshPeerMetrics {
    peerId: string;
    rtt: number; // -1 if unknown or timeout
    status: 'relay' | 'p2p';
}

/** Aggregated mesh metrics */
export interface MeshMetrics {
    peers: MeshPeerMetrics[];
    effectiveTopology: MeshTopology;
    totalPeers: number;
}

// ============================================
//           EVENT TYPES
// ============================================

export type MeshEventType =
    | 'connect'
    | 'disconnect'
    | 'peerJoin'
    | 'peerDisconnect'
    | 'message'
    | 'error'
    | 'lifecycleStateChange'
    | 'peerStatus'
    | 'authorityMessage'
    | 'init'
    | 'ephemeral'
    | 'topologyChange'
    | 'metricsUpdate';

export interface MeshEventMap {
    connect: () => void;
    disconnect: () => void;
    peerJoin: (peerId: string) => void;
    peerDisconnect: (peerId: string) => void;
    message: (peerId: string, data: ArrayBuffer) => void;
    error: (error: Error) => void;
    lifecycleStateChange: (state: MeshLifecycleState) => void;
    peerStatus: (peerId: string, status: 'relay' | 'p2p') => void;

    // Connection quality metrics
    metricsUpdate: (metrics: MeshMetrics) => void;

    // Server Authority Messages (Sync/Persistence)
    authorityMessage: (data: Uint8Array) => void;

    // Authoritative Init Message (UUID resolution + History)
    init: (data: any) => void;

    // Ephemeral
    ephemeral: (payload: any) => void;

    // Topology change (mesh -> star fallback)
    topologyChange: (topology: MeshTopology, reason: string) => void;
}

// ============================================
//           CHAOS & DIAGNOSTICS
// ============================================

/**
 * Configuration for network simulation (Chaos Mode).
 */
export interface ChaosOptions {
    /** Artificial latency in ms added to all outgoing messages */
    latency?: number;
    /** Random jitter in ms added to latency */
    jitter?: number;
    /** Percentage probability of dropping a packet (0-100) */
    packetLoss?: number;
}
