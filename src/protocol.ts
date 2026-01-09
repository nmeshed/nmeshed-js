/**
 * @module Protocol
 * @description
 * The Protocol Layer manages the serialization and deserialization of messages between Client and Server.
 * 
 * ## Design Philosophy
 * - **Compactness**: We use Flatbuffers (Zero-Copy) for the envelope and MsgPack for the payload.
 * - **Efficiency**: Parsing headers does not require decoding the entire payload.
 * 
 * ## Message Structure (WirePacket)
 * 
 * ```
 * +-------------------+
 * | MsgType (1 Byte)  |
 * +-------------------+
 * | ... Fields ...    |
 * +-------------------+
 * | Payload (MsgPack) |
 * +-------------------+
 * ```
 */

import { Builder, ByteBuffer } from 'flatbuffers';
import type { WireOp } from './types';
import { encode, decode } from '@msgpack/msgpack';

// =============================================================================
// Message Types (matching server protocol)
// =============================================================================

export enum MsgType {
    Unknown = 0,
    Op = 1,
    Sync = 2,
    Signal = 3,
    Init = 4,
    Ping = 5,
    Pong = 6,
    CompareAndSwap = 7,
}

// =============================================================================
// Schema Field IDs (inferred from Rust generated code)
// =============================================================================

// WirePacket Table
const WP_MSG_TYPE = 0;
const WP_OP = 1;
const WP_PAYLOAD = 2;
const WP_TIMESTAMP = 3; // New field for server time (Float64 for JS compatibility)

// Op Table (matches protocol.fbs order)
const OP_WORKSPACE_ID = 0;
const OP_KEY = 1;
const OP_TIMESTAMP = 2; // timestamp:long is field 2
const OP_VALUE = 3;
const OP_ACTOR_ID = 4;
const OP_SEQ = 5;
const OP_IS_DELETE = 6;

// Init/Snapshot Table
const WP_SNAPSHOT = 7;
const SNAP_DATA = 0;
const SNAP_SCHEMA_VERSION = 2;

// CAS Table
const CAS_KEY = 0;
const CAS_EXPECTED = 1;
const CAS_NEW = 2;
const CAS_ACTOR = 3;
const CAS_TIMESTAMP = 4;

const WP_CAS = 8;

// =============================================================================
// Value Encoding (MsgPack)
// =============================================================================

/** 
 * Encode a value as MsgPack bytes.
 * 
 * @param value - The JavaScript value to encode.
 * @returns Uint8Array suitable for network transmission.
 */
export function encodeValue(value: unknown): Uint8Array {
    return encode(value);
}

/** 
 * Decode a MsgPack value from bytes.
 * 
 * @param data - The raw bytes.
 * @returns The decoded JavaScript value.
 */
export function decodeValue<T = unknown>(data: Uint8Array): T {
    return decode(data) as T;
}

// -----------------------------------------------------------------------------
// CAS Helper
// -----------------------------------------------------------------------------

/**
 * Encodes a Compare-And-Swap operation into a Flatbuffer WirePacket.
 * 
 * @param key - The key to operate on.
 * @param expected - The expected existing value (encoded) or null.
 * @param newValue - The new value (encoded).
 * @param actorId - The ID of the client performing the operation.
 */
export function encodeCAS(
    key: string,
    expected: Uint8Array | null,
    newValue: Uint8Array,
    actorId: string
): Uint8Array {
    const builder = new Builder(256);

    const keyOffset = builder.createString(key);
    const newValueOffset = builder.createByteVector(newValue);
    let expectedOffset = 0;
    if (expected) {
        expectedOffset = builder.createByteVector(expected);
    }
    const actorOffset = builder.createString(actorId);

    // Build CAS Table
    builder.startObject(5);
    builder.addFieldOffset(CAS_KEY, keyOffset, 0);
    if (expected) {
        builder.addFieldOffset(CAS_EXPECTED, expectedOffset, 0);
    }
    builder.addFieldOffset(CAS_NEW, newValueOffset, 0);
    builder.addFieldOffset(CAS_ACTOR, actorOffset, 0);
    // Use generic addInt64 logic or simulated Int64 for Flatbuffers in JS
    // Use BigInt for timestamp (modern JS/Flatbuffers)
    const now = BigInt(Date.now());
    builder.addFieldInt64(CAS_TIMESTAMP, now, BigInt(0));

    const casOffset = builder.endObject();

    // Build WirePacket Table
    builder.startObject(9);
    builder.addFieldInt8(WP_MSG_TYPE, MsgType.CompareAndSwap, 0);
    builder.addFieldOffset(WP_CAS, casOffset, 0);
    const packet = builder.endObject();

    builder.finish(packet);
    return builder.asUint8Array();
}
// =============================================================================
// Encoder
// =============================================================================

/** 
 * Encode a standard Operation (Set/Delete).
 * 
 * @param key - The key.
 * @param payload - The encoded value.
 * @param timestamp - Optional timestamp (if re-broadcasting).
 */
export function encodeOp(key: string, payload: Uint8Array, timestamp?: number): Uint8Array {
    const builder = new Builder(256);

    // 1. Create Op Table Strings/Vectors
    const keyOffset = builder.createString(key);
    const valueOffset = builder.createByteVector(payload);

    // 2. Build Op Table
    builder.startObject(7); // Op has 7 fields max
    builder.addFieldOffset(OP_KEY, keyOffset, 0);
    builder.addFieldOffset(OP_VALUE, valueOffset, 0);
    if (timestamp && timestamp > 0) {
        // Use generic addInt64 logic or simulated Int64 for Flatbuffers in JS
        // Use BigInt for timestamp (modern JS/Flatbuffers)
        const ts = BigInt(timestamp);
        builder.addFieldInt64(OP_TIMESTAMP, ts, BigInt(0));
    }
    const opOffset = builder.endObject();

    // 3. Build WirePacket Table
    builder.startObject(8); // WirePacket has 8 main fields now
    builder.addFieldInt8(WP_MSG_TYPE, MsgType.Op, 0);
    builder.addFieldOffset(WP_OP, opOffset, 0);
    const packet = builder.endObject();

    builder.finish(packet);
    return builder.asUint8Array().slice();
}

/** 
 * Encode an Init/Snapshot message.
 */
export function encodeInit(snapshot: Uint8Array, serverTime = 0): Uint8Array {
    const builder = new Builder(1024);

    // 1. Create Data Vector
    const dataOffset = builder.createByteVector(snapshot);

    // 2. Build Snapshot Table
    builder.startObject(4);
    builder.addFieldOffset(SNAP_DATA, dataOffset, 0);
    builder.addFieldInt32(SNAP_SCHEMA_VERSION, 2, 0);
    const snapOffset = builder.endObject();

    // 3. Build WirePacket Table
    builder.startObject(8);
    builder.addFieldInt8(WP_MSG_TYPE, MsgType.Init, 0);
    builder.addFieldOffset(WP_SNAPSHOT, snapOffset, 0);
    if (serverTime > 0) {
        builder.addFieldFloat64(WP_TIMESTAMP, serverTime, 0);
    }
    const packet = builder.endObject();

    builder.finish(packet);
    return builder.asUint8Array().slice();
}

/** Encode a Ping message */
export function encodePing(): Uint8Array {
    const builder = new Builder(32);
    builder.startObject(8);
    builder.addFieldInt8(WP_MSG_TYPE, MsgType.Ping, 0);
    const packet = builder.endObject();
    builder.finish(packet);
    return builder.asUint8Array().slice();
}

/** Encode a Pong message with server time */
export function encodePong(serverTime: number): Uint8Array {
    const builder = new Builder(32);
    builder.startObject(8);
    builder.addFieldInt8(WP_MSG_TYPE, MsgType.Pong, 0);
    builder.addFieldFloat64(WP_TIMESTAMP, serverTime, 0);
    const packet = builder.endObject();
    builder.finish(packet);
    return builder.asUint8Array().slice();
}

/** Encode a state snapshot map helper */
export function encodeSnapshot(state: Record<string, unknown>): Uint8Array {
    return encodeValue(state);
}

/** Decode a state snapshot map helper */
export function decodeSnapshot(data: Uint8Array): Record<string, unknown> {
    return decodeValue<Record<string, unknown>>(data);
}

// =============================================================================
// Decoder
// =============================================================================

export interface DecodedMessage {
    type: MsgType;
    key?: string;
    payload?: Uint8Array;
    expectedValue?: Uint8Array | null; // For CAS
    timestamp?: number; // Server time or Op timestamp
}

/** 
 * Decodes a raw byte array into a structured message.
 * 
 * @param data - The raw bytes from the WebSocket.
 * @returns The decoded message or null if invalid.
 */
export function decodeMessage(data: Uint8Array): DecodedMessage | null {
    try {
        const buf = new ByteBuffer(data);

        // Read Root Table (WirePacket)
        const rootOffset = buf.readInt32(buf.position()) + buf.position();

        const msgType = readFieldInt8(buf, rootOffset, WP_MSG_TYPE, MsgType.Unknown);
        const timestamp = readFieldFloat64(buf, rootOffset, WP_TIMESTAMP, 0);

        if (msgType === MsgType.Unknown) return null;

        const baseMsg: DecodedMessage = { type: msgType as MsgType };
        if (timestamp > 0) baseMsg.timestamp = timestamp;

        if (msgType === MsgType.Op) {
            const opOffset = readFieldTable(buf, rootOffset, WP_OP);
            if (!opOffset) return null;
            const key = readFieldString(buf, opOffset, OP_KEY);
            const payload = readFieldBytes(buf, opOffset, OP_VALUE);
            // Read timestamp from OP table (Int64)
            const opTs = readFieldInt64(buf, opOffset, OP_TIMESTAMP, BigInt(0));
            // Convert back to number for JS compatibility (safe for next few thousand years)
            const finalTs = Number(opTs) || timestamp;  // Fallback to server sync time if 0

            return {
                ...baseMsg,
                key: key || '',
                payload: payload || new Uint8Array(),
                timestamp: finalTs
            };
        } else if (msgType === MsgType.Init) {
            const snapOffset = readFieldTable(buf, rootOffset, WP_SNAPSHOT);
            if (snapOffset) {
                const payload = readFieldBytes(buf, snapOffset, SNAP_DATA);
                return { ...baseMsg, payload: payload || new Uint8Array() };
            } else {
                const payload = readFieldBytes(buf, rootOffset, WP_PAYLOAD);
                return { ...baseMsg, payload: payload || new Uint8Array() };
            }
        } else if (msgType === MsgType.CompareAndSwap) {
            // Updated to support Strict CAS
            const casOffset = readFieldTable(buf, rootOffset, WP_CAS);
            if (!casOffset) return null;

            const key = readFieldString(buf, casOffset, CAS_KEY);
            const expected = readFieldBytes(buf, casOffset, CAS_EXPECTED);
            const newValue = readFieldBytes(buf, casOffset, CAS_NEW);

            // Note: We map `payload` to `newValue` for generic compatibility
            return {
                ...baseMsg,
                key: key || '',
                payload: newValue || new Uint8Array(),
                expectedValue: expected
            };
        }

        return baseMsg;
    } catch (e) {
        console.error('Decode error', e);
        return null;
    }
}

// =============================================================================
// Minimal Flatbuffer Readers (Manual VTable Lookup)
// =============================================================================

function readFieldFloat64(buf: ByteBuffer, tablePos: number, fieldIndex: number, defaultValue: number): number {
    const vtable = tablePos - buf.readInt32(tablePos);
    const offset = buf.readInt16(vtable + 4 + fieldIndex * 2);
    if (offset === 0) return defaultValue;
    return buf.readFloat64(tablePos + offset);
}

function readFieldInt8(buf: ByteBuffer, tablePos: number, fieldIndex: number, defaultValue: number): number {
    const vtable = tablePos - buf.readInt32(tablePos);
    const offset = buf.readInt16(vtable + 4 + fieldIndex * 2);
    if (offset === 0) return defaultValue;
    return buf.readInt8(tablePos + offset);
}

function readFieldTable(buf: ByteBuffer, tablePos: number, fieldIndex: number): number | null {
    const vtable = tablePos - buf.readInt32(tablePos);
    const offset = buf.readInt16(vtable + 4 + fieldIndex * 2);
    if (offset === 0) return null;
    return tablePos + offset + buf.readInt32(tablePos + offset);
}

function readFieldString(buf: ByteBuffer, tablePos: number, fieldIndex: number): string | null {
    const vtable = tablePos - buf.readInt32(tablePos);
    const offset = buf.readInt16(vtable + 4 + fieldIndex * 2);
    if (offset === 0) return null;

    const stringOffset = tablePos + offset + buf.readInt32(tablePos + offset);
    const len = buf.readInt32(stringOffset);
    const start = stringOffset + 4;
    return new TextDecoder().decode(buf.bytes().subarray(start, start + len));
}

function readFieldBytes(buf: ByteBuffer, tablePos: number, fieldIndex: number): Uint8Array | null {
    const vtable = tablePos - buf.readInt32(tablePos);
    const offset = buf.readInt16(vtable + 4 + fieldIndex * 2);
    if (offset === 0) return null;

    const vectorOffset = tablePos + offset + buf.readInt32(tablePos + offset);
    const len = buf.readInt32(vectorOffset);
    const start = vectorOffset + 4;
    return buf.bytes().slice(start, start + len);
}

function readFieldInt64(buf: ByteBuffer, tablePos: number, fieldIndex: number, defaultValue: bigint): bigint {
    const vtable = tablePos - buf.readInt32(tablePos);
    const offset = buf.readInt16(vtable + 4 + fieldIndex * 2);
    if (offset === 0) return defaultValue;
    return buf.readInt64(tablePos + offset);
}
