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

export type MeshConnectionStatus =
    | 'IDLE'
    | 'CONNECTING'
    | 'CONNECTED'
    | 'RECONNECTING'
    | 'DISCONNECTED'
    | 'ERROR';

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
}

export interface ResolvedMeshConfig extends Omit<Required<MeshClientConfig>, 'iceServers' | 'token' | 'tokenProvider'> {
    token?: string;
    tokenProvider?: () => Promise<string>;
    iceServers: RTCIceServer[];
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
    | 'statusChange'
    | 'peerStatus'
    | 'authorityMessage'
    | 'init'
    | 'ephemeral';

export interface MeshEventMap {
    connect: () => void;
    disconnect: () => void;
    peerJoin: (peerId: string) => void;
    peerDisconnect: (peerId: string) => void;
    message: (peerId: string, data: ArrayBuffer) => void;
    error: (error: Error) => void;
    statusChange: (status: MeshConnectionStatus) => void;
    peerStatus: (peerId: string, status: 'relay' | 'p2p') => void;

    // Server Authority Messages (Sync/Persistence)
    authorityMessage: (data: Uint8Array) => void;

    // Legacy Init Message
    init: (data: any) => void;

    // Ephemeral
    ephemeral: (payload: any) => void;
}
