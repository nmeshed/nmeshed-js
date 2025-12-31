/**
 * NMeshed v2 - Protocol Layer
 * 
 * The Essence of Data: Bytes are precious.
 * This module wraps Flatbuffers serialization with a clean interface.
 */

import * as flatbuffers from 'flatbuffers';
import type { WireOp } from './types';

// =============================================================================
// Message Types (matching server protocol)
// =============================================================================

// =============================================================================
// Message Types (matching server protocol)
// =============================================================================

export enum MsgType {
    Unknown = 0,
    Op = 1,
    Sync = 2,
    Signal = 3,
    Init = 4,
}

// =============================================================================
// Schema Field IDs (inferred from Rust generated code)
// =============================================================================

// WirePacket Table
const WP_MSG_TYPE = 0;
const WP_OP = 1;
const WP_PAYLOAD = 2;

// Op Table
// 0: workspace_id
const OP_KEY = 1;
// 2: timestamp
const OP_VALUE = 3;
// 4: actor_id
// 5: seq
// 6: is_delete

// =============================================================================
// Encoder
// =============================================================================

/** Encode an operation for wire transfer */
export function encodeOp(key: string, payload: Uint8Array): Uint8Array {
    const builder = new flatbuffers.Builder(256);

    // 1. Create Op Table Strings/Vectors
    const keyOffset = builder.createString(key);
    const valueOffset = builder.createByteVector(payload);

    // 2. Build Op Table
    builder.startObject(7); // Op has 7 fields max
    builder.addFieldOffset(OP_KEY, keyOffset, 0);
    builder.addFieldOffset(OP_VALUE, valueOffset, 0);
    const opOffset = builder.endObject();

    // 3. Build WirePacket Table
    builder.startObject(3); // WirePacket has 3 main fields we use
    builder.addFieldInt8(WP_MSG_TYPE, MsgType.Op, 0);
    builder.addFieldOffset(WP_OP, opOffset, 0);
    const packet = builder.endObject();

    builder.finish(packet);
    return builder.asUint8Array().slice();
}

/** Encode an initialization message (snapshot) */
export function encodeInit(snapshot: Uint8Array): Uint8Array {
    const builder = new flatbuffers.Builder(1024);

    // 1. Create Payload Vector
    const payloadOffset = builder.createByteVector(snapshot);

    // 2. Build WirePacket Table
    builder.startObject(3);
    builder.addFieldInt8(WP_MSG_TYPE, MsgType.Init, 0);
    builder.addFieldOffset(WP_PAYLOAD, payloadOffset, 0);
    const packet = builder.endObject();

    builder.finish(packet);
    return builder.asUint8Array().slice();
}

import { encode, decode } from '@msgpack/msgpack';

// =============================================================================
// Value Encoding (MsgPack)
// =============================================================================

/** Encode a value as MsgPack bytes (Zero-Copy, Compact) */
export function encodeValue(value: unknown): Uint8Array {
    return encode(value);
}

/** Decode a MsgPack value from bytes */
export function decodeValue<T = unknown>(data: Uint8Array): T {
    return decode(data) as T;
}

// =============================================================================
// Decoder
// =============================================================================

interface DecodedMessage {
    type: MsgType;
    key?: string;
    payload?: Uint8Array;
}

/** Decode a wire message */
export function decodeMessage(data: Uint8Array): DecodedMessage | null {
    try {
        const buf = new flatbuffers.ByteBuffer(data);

        // Read Root Table (WirePacket)
        // Standard Flatbuffer read: Root offset is at 0
        const rootOffset = buf.readInt32(buf.position()) + buf.position();

        // Helper to read field INT8 at index 0 (WP_MSG_TYPE)
        const msgType = readFieldInt8(buf, rootOffset, WP_MSG_TYPE, MsgType.Unknown);

        if (msgType === MsgType.Unknown) return null;

        if (msgType === MsgType.Op) {
            // Read Op Table (Field 1)
            const opOffset = readFieldTable(buf, rootOffset, WP_OP);
            if (!opOffset) return null;

            // Read Key (Op Field 1)
            const key = readFieldString(buf, opOffset, OP_KEY);
            // Read Value (Op Field 3)
            const payload = readFieldBytes(buf, opOffset, OP_VALUE);

            return { type: MsgType.Op, key: key || '', payload: payload || new Uint8Array() };
        } else if (msgType === MsgType.Init) {
            // Read Payload (Field 2)
            const payload = readFieldBytes(buf, rootOffset, WP_PAYLOAD);
            return { type: MsgType.Init, payload: payload || new Uint8Array() };
        }

        return { type: msgType as MsgType };
    } catch (e) {
        console.error('Decode error', e);
        return null;
    }
}

// Minimal Flatbuffer Readers (Manual VTable Lookup)
function readFieldInt8(buf: flatbuffers.ByteBuffer, tablePos: number, fieldIndex: number, defaultValue: number): number {
    const vtableOffset = tablePos - buf.readInt32(tablePos);
    // VTable logic: vtable is at tablePos - relative_offset
    const vtable = tablePos - buf.readInt32(tablePos);
    const offset = buf.readInt16(vtable + 4 + fieldIndex * 2);

    if (offset === 0) return defaultValue;
    return buf.readInt8(tablePos + offset);
}

function readFieldTable(buf: flatbuffers.ByteBuffer, tablePos: number, fieldIndex: number): number | null {
    const vtable = tablePos - buf.readInt32(tablePos);
    const offset = buf.readInt16(vtable + 4 + fieldIndex * 2);
    if (offset === 0) return null;
    return tablePos + offset + buf.readInt32(tablePos + offset);
}

function readFieldString(buf: flatbuffers.ByteBuffer, tablePos: number, fieldIndex: number): string | null {
    const vtable = tablePos - buf.readInt32(tablePos);
    const offset = buf.readInt16(vtable + 4 + fieldIndex * 2);
    if (offset === 0) return null;

    const stringOffset = tablePos + offset + buf.readInt32(tablePos + offset);
    const len = buf.readInt32(stringOffset);
    const start = stringOffset + 4;
    return new TextDecoder().decode(buf.bytes().subarray(start, start + len));
}

function readFieldBytes(buf: flatbuffers.ByteBuffer, tablePos: number, fieldIndex: number): Uint8Array | null {
    const vtable = tablePos - buf.readInt32(tablePos);
    const offset = buf.readInt16(vtable + 4 + fieldIndex * 2);
    if (offset === 0) return null;

    const vectorOffset = tablePos + offset + buf.readInt32(tablePos + offset);
    const len = buf.readInt32(vectorOffset);
    const start = vectorOffset + 4;
    return buf.bytes().slice(start, start + len);
}

// =============================================================================
// Snapshot Encoding
// =============================================================================

/** Encode a state snapshot for initial sync */
export function encodeSnapshot(state: Record<string, unknown>): Uint8Array {
    return encodeValue(state);
}

/** Decode a state snapshot */
export function decodeSnapshot(data: Uint8Array): Record<string, unknown> {
    return decodeValue<Record<string, unknown>>(data);
}
