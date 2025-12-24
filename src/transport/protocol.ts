/**
 * @file protocol.ts
 * @brief Binary Wire Protocol Definition
 *
 * # Protocol Design Philosophy
 * 
 * The nMeshed SDK uses a hybrid protocol designed for both performance and debugability:
 * 
 * ## Binary Protocol (Production/Benchmark Mode)
 * High-frequency, latency-sensitive operations use binary framing with OpCodes:
 * - **ENGINE (0x01)**: CRDT deltas - the "hot path" for real-time sync
 * - **EPHEMERAL (0x02)**: Cursors, presence broadcasts, SyncedMap updates
 * - **DIRECT (0x04)**: Targeted P2P messages
 * 
 * Binary is used because:
 * - Zero-copy on the hot path (no serialization overhead)
 * - Frame-perfect timing for games (< 16ms)
 * - Efficient for high-frequency updates (60+ ops/sec)
 * 
 * ## JSON Protocol (Debug/Control Mode)
 * Low-frequency control messages use JSON for human readability:
 * - **init**: Initial state sync on connection
 * - **presence**: User join/leave notifications
 * - **error**: Server error messages
 * 
 * JSON is used because:
 * - Human-readable in browser DevTools Network tab
 * - Easy debugging without Flatbuffers tooling
 * - Happens once per connection (not performance-critical)
 * 
 * ## Debug Mode (`debugProtocol: true`)
 * When enabled, ALL messages use JSON format for full visibility during development.
 * Use this when debugging protocol issues; disable for benchmarks and production.
 */

/**
 * Binary Wire Protocol OpCodes
 * 
 * Byte 0 of every binary packet determines the payload type.
 * See module documentation above for when to use binary vs JSON.
 */
export enum OpCode {
    /** 
     * Engine Operation (CRDT Delta).
     * Format: [0x01][Raw Binary Delta]
     * 
     * Hot path for real-time sync. Use for:
     * - CRDT operations (set, delete, merge)
     * - High-frequency state updates
     */
    ENGINE = 0x01,

    /**
     * Ephemeral Message (Cursors, Broadcasts).
     * Format: [0x02][Raw Binary Payload]
     * 
     * Use for:
     * - Cursor position updates
     * - SyncedMap broadcasts
     * - Any high-frequency non-persisted data
     */
    EPHEMERAL = 0x02,

    /**
     * System/Control Message.
     * Format: [0x03][JSON String]
     * 
     * Use for:
     * - Presence updates (low-frequency)
     * - Auth/handshake (once per connection)
     * - Error responses
     * 
     * Note: Payload is JSON for debugability.
     */
    SYSTEM = 0x03,

    /**
     * Direct Message (Targeted P2P).
     * Format: [0x04][TargetLen(1)][TargetString][Raw Binary Payload]
     * 
     * Use for:
     * - Peer-to-peer messages
     * - Targeted SyncedMap snapshots
     */
    DIRECT = 0x04,
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
