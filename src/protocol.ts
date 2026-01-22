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
    Encrypted = 8,
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
const OP_IS_ENCRYPTED = 7;

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
const WP_ENCRYPTED = 9;

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

// =============================================================================
// Encoder
// =============================================================================

/** 
 * Encode a standard Operation (Set/Delete).
 * 
 * Uses strict Manual Binary Encoding for parity with Rust Core `protocol.rs`.
 * WirePacket.payload = [Binary Op Blob].
 * 
 * Binary Op Format:
 * [UUID(16)] [KeyLen(4)] [KeyBytes] [HLC(16)] [ValLen(4)] [ValBytes] [DepsLen(4)] [Dep1Len(4)] [Dep1Bytes]...
 */
export function encodeOp(key: string, payload: Uint8Array, timestamp?: bigint, isEncrypted = false, actorId?: string, deps: string[] = []): Uint8Array {
    const builder = new Builder(256);

    // 1. Construct Manual Binary Op Blob
    const keyBytes = new TextEncoder().encode(key);
    const valBytes = payload;

    // UUID (16) - Mocking for now, ideally derived from Workspace
    const uuidBytes = new Uint8Array(16); // Zeros for now in this light SDK

    // HLC (16 bytes LE)
    const hlcBytes = new Uint8Array(16);
    const ts = timestamp || 0n;
    const view = new DataView(hlcBytes.buffer);
    view.setBigUint64(0, ts & 0xFFFFFFFFFFFFFFFFn, true); // Low 64
    view.setBigUint64(8, ts >> 64n, true);               // High 64

    // Deps pre-calculation
    const depsEncoded = deps.map(d => new TextEncoder().encode(d));
    const depsLengthSize = 4;
    const depsContentSize = depsEncoded.reduce((acc, d) => acc + 4 + d.length, 0);

    // Calculate size
    const totalSize = 16 + 4 + keyBytes.length + 16 + 4 + valBytes.length + depsLengthSize + depsContentSize;
    const buf = new Uint8Array(totalSize);
    let offset = 0;

    // Write UUID
    buf.set(uuidBytes, offset); offset += 16;

    // Write Key
    new DataView(buf.buffer).setUint32(offset, keyBytes.length, true); offset += 4;
    buf.set(keyBytes, offset); offset += keyBytes.length;

    // Write HLC
    buf.set(hlcBytes, offset); offset += 16;

    // Write Value
    new DataView(buf.buffer).setUint32(offset, valBytes.length, true); offset += 4;
    buf.set(valBytes, offset); offset += valBytes.length;

    // Write Deps
    new DataView(buf.buffer).setUint32(offset, deps.length, true); offset += 4;
    for (const depBytes of depsEncoded) {
        new DataView(buf.buffer).setUint32(offset, depBytes.length, true); offset += 4;
        buf.set(depBytes, offset); offset += depBytes.length;
    }

    // 2. Wrap in WirePacket Flatbuffer
    // We strictly put the binary blob into `WP_PAYLOAD`
    const payloadOffset = builder.createByteVector(buf);

    builder.startObject(8);
    builder.addFieldInt8(WP_MSG_TYPE, MsgType.Op, 0);
    builder.addFieldOffset(WP_PAYLOAD, payloadOffset, 0);
    // Legacy/Redundant fields unused by Rust in manual mode
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

/**
 * Encode an Opaque Encrypted Blob (Liability Shield).
 * 
 * @param payload - The pre-encrypted bytes.
 */
export function encodeEncrypted(payload: Uint8Array): Uint8Array {
    const builder = new Builder(payload.length + 32);
    const dataOffset = builder.createByteVector(payload);

    builder.startObject(10);
    builder.addFieldInt8(WP_MSG_TYPE, MsgType.Encrypted, 0);
    builder.addFieldOffset(WP_ENCRYPTED, dataOffset, 0);
    builder.addFieldFloat64(WP_TIMESTAMP, Date.now(), 0);
    const packet = builder.endObject();

    builder.finish(packet);
    return builder.asUint8Array().slice();
}

// =============================================================================
// Decoder
// =============================================================================

export interface DecodedMessage {
    type: MsgType;
    key?: string;
    payload?: Uint8Array;
    expectedValue?: Uint8Array | null; // For CAS
    timestamp?: bigint; // Server time or Op timestamp
    isEncrypted?: boolean;
    actorId?: string;
    serverTime?: number;    // Legacy Float64 timestamp from envelope
    deps?: string[];
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
        const serverTime = readFieldFloat64(buf, rootOffset, WP_TIMESTAMP, 0);

        if (msgType === MsgType.Unknown) return null;

        const baseMsg: DecodedMessage = { type: msgType as MsgType, serverTime };

        if (msgType === MsgType.Op) {
            // Updated: Decode from Payload Blob (Manual Binary)
            const payload = readFieldBytes(buf, rootOffset, WP_PAYLOAD);
            if (!payload || payload.length < 16 + 4 + 8 + 4) {
                console.warn("Invalid binary op payload");
                return null;
            }

            // Manual Decode
            // Format: [UUID(16)] [KeyLen(4)] [Key] [HLC(16)] [ValLen(4)] [Val]
            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            let offset = 0;

            // Skip UUID (16)
            offset += 16;

            // Key
            const keyLen = view.getUint32(offset, true); offset += 4;
            const keyBytes = payload.subarray(offset, offset + keyLen);
            const key = new TextDecoder().decode(keyBytes); offset += keyLen;

            // HLC (16 bytes)
            const low = view.getBigUint64(offset, true);
            const high = view.getBigUint64(offset + 8, true);
            const hlc = (high << 64n) | low;
            offset += 16;

            // Value
            const valLen = view.getUint32(offset, true); offset += 4;
            const valBytes = payload.slice(offset, offset + valLen); // Clone slice for safety
            offset += valLen;

            // Deps
            const deps: string[] = [];
            if (offset < payload.byteLength) {
                const depsCount = view.getUint32(offset, true); offset += 4;
                for (let i = 0; i < depsCount; i++) {
                    const dLen = view.getUint32(offset, true); offset += 4;
                    const dBytes = payload.subarray(offset, offset + dLen);
                    deps.push(new TextDecoder().decode(dBytes));
                    offset += dLen;
                }
            }

            return {
                ...baseMsg,
                key,
                payload: valBytes,
                timestamp: hlc,
                deps,
                // ActorId is implicitly in NodeID inside HLC now
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
            const casTs = readFieldInt64(buf, casOffset, CAS_TIMESTAMP, BigInt(0));
            const actorId = readFieldString(buf, casOffset, CAS_ACTOR);

            // Note: We map `payload` to `newValue` for generic compatibility
            return {
                ...baseMsg,
                key: key || '',
                payload: newValue || new Uint8Array(),
                expectedValue: expected,
                timestamp: casTs || BigInt(baseMsg.serverTime || 0),
                actorId: actorId || undefined
            };
        } else if (msgType === MsgType.Encrypted) {
            const payload = readFieldBytes(buf, rootOffset, WP_ENCRYPTED);
            return {
                ...baseMsg,
                payload: payload || new Uint8Array()
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
