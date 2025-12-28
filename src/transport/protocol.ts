/**
 * @file protocol.ts
 * @brief Unified Binary Wire Protocol Definition
 *
 * # Protocol Design Philosophy
 * 
 * nMeshed has unified all high-frequency and control communication into a single 
 * FlatBuffer-based wire format. This ensures zero-perceived latency and 
 * maximum performance across all SDKs and the platform.
 * 
 * ## WirePacket (Unified Binary)
 * All messages are wrapped in a `WirePacket` FlatBuffer, which supports:
 * - **OP**: CRDT deltas (Hot Path)
 * - **SYNC**: Ephemeral data (cursors, typing, high-frequency broadcasts)
 * - **SIGNAL**: P2P/WebRTC signaling
 * 
 * ## Developer Experience
 * While the wire protocol is binary, the SDK handles the encoding/decoding 
 * automatically. Developers work with standard JS objects.
 */

/**
 * Unified Protocol OpCodes
 * Matches nmeshed.MsgType in FlatBuffer schema.
 */
export enum OpCode {
    /** Unknown/Invalid */
    UNKNOWN = 0x00,
    /** Engine Operation (CRDT Delta) */
    OP = 0x01,
    /** Ephemeral Sync (Cursors, Broadcasts) */
    SYNC = 0x02,
    /** Full Document Snapshot (Bootstrap) */
    INIT = 0x04,
}

/**
 * Common Protocol Constants
 */
export const CONSTANTS = {
    /** Max length for a SyncedMap namespace string */
    MAX_NAMESPACE_LEN: 255,
    /** Max length for a SyncedMap key string */
    MAX_KEY_LEN: 255,
};
