/**
 * @file mesh/index.ts
 * @brief Mesh module exports for P2P networking.
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
 * mesh.broadcast(gameState);
 * ```
 */

export { MeshClient } from './MeshClient';
export { SignalingClient } from './SignalingClient';
export { ConnectionManager } from './ConnectionManager';

export type {
    // Mesh types
    MeshClientConfig,
    MeshLifecycleState,
    MeshTopology,
    MeshEventMap,

    // Signal types
    SignalType,
    SignalMessage,
    SignalEnvelope,
    JoinSignal,
    OfferSignal,
    AnswerSignal,
    CandidateSignal,
} from './types';
