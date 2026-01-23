/**
 * @module Protocol
 * @description
 * The Protocol Layer manages the serialization and deserialization of messages between Client and Server.
 * 
 * ## Design Philosophy
 * - **Compactness**: We use Flatbuffers (Zero-Copy) for the envelope and MsgPack for the payload.
 * - **Efficiency**: Schema-driven parsing via generated accessors.
 * 
 * ## Message Structure (WirePacket)
 * Uses the `nmeshed.ts` generated code.
 */

import { Builder, ByteBuffer } from 'flatbuffers';
import { encode, decode } from '@msgpack/msgpack';
import * as FBS from './schema/nmeshed';
import { Hlc } from './schema/nmeshed/hlc';

// =============================================================================
// Message Types
// =============================================================================

// Re-export MsgType from generated code for convenience
export const MsgType = FBS.MsgType;
export type MsgType = FBS.MsgType;

// =============================================================================
// Value Encoding (MsgPack)
// =============================================================================

export function encodeValue(value: unknown): Uint8Array {
    return encode(value);
}

export function decodeValue<T = unknown>(data: Uint8Array): T {
    return decode(data) as T;
}

// =============================================================================
// Encoder (Satori: Zero-Arithmetic)
// =============================================================================

/** 
 * Encode a standard Operation (Set/Delete).
 * 
 * Uses strict FlatBuffers Schema (Op Table).
 */
export function encodeOp(key: string, payload: Uint8Array, timestamp?: bigint, isEncrypted = false, actorId?: string, deps: string[] = []): Uint8Array {
    const builder = new Builder(256);

    // 1. Prepare Strings/Vectors
    const keyOffset = builder.createString(key);
    const valVector = builder.createByteVector(payload);
    const actorOffset = actorId ? builder.createString(actorId) : 0;
    const wsOffset = builder.createString("");

    // 2. Encode HLC (Timestamp)
    const ts = timestamp || BigInt(Date.now());
    const lower = ts & 0xFFFFFFFFFFFFFFFFn;
    const upper = ts >> 64n;

    FBS.Op.startOp(builder);

    // HACK: FlatBuffers JS Builder define inline structs logic strictly.
    // fieldStruct requires the struct to be at the current offset.
    // We must write the struct bytes HERE, inside the table construction.
    // However, createHlc calls builder.prep(), which throws if isNested is true.
    // We momentarily disable the check to write the struct inline.

    // @ts-ignore
    builder.isNested = false;
    const hlcOffset = Hlc.createHlc(builder, upper, lower);
    // @ts-ignore
    builder.isNested = true;

    FBS.Op.addTimestamp(builder, hlcOffset);

    FBS.Op.addKey(builder, keyOffset);
    FBS.Op.addValue(builder, valVector);
    if (actorOffset) FBS.Op.addActorId(builder, actorOffset);

    FBS.Op.addIsDelete(builder, false);
    FBS.Op.addSeq(builder, 0n); // Default seq
    FBS.Op.addIsEncrypted(builder, isEncrypted);

    const opOffset = FBS.Op.endOp(builder);

    // 3. Wrap in WirePacket
    FBS.WirePacket.startWirePacket(builder);
    FBS.WirePacket.addMsgType(builder, FBS.MsgType.Op);
    FBS.WirePacket.addOp(builder, opOffset);
    FBS.WirePacket.addTimestamp(builder, Date.now());

    const packetOffset = FBS.WirePacket.endWirePacket(builder);
    builder.finish(packetOffset);

    return builder.asUint8Array();
}

/** Encode Init/Snapshot */
export function encodeInit(snapshot: Uint8Array, serverTime = 0): Uint8Array {
    const builder = new Builder(1024);
    const dataOffset = builder.createByteVector(snapshot);

    FBS.Snapshot.startSnapshot(builder);
    FBS.Snapshot.addData(builder, dataOffset);
    FBS.Snapshot.addSchemaVersion(builder, 2);
    const snapOffset = FBS.Snapshot.endSnapshot(builder);

    FBS.WirePacket.startWirePacket(builder);
    FBS.WirePacket.addMsgType(builder, FBS.MsgType.Init);
    FBS.WirePacket.addSnapshot(builder, snapOffset);
    if (serverTime > 0) FBS.WirePacket.addTimestamp(builder, serverTime);

    const packet = FBS.WirePacket.endWirePacket(builder);
    builder.finish(packet);
    return builder.asUint8Array();
}

/** Encode Ping */
export function encodePing(): Uint8Array {
    const builder = new Builder(32);
    FBS.WirePacket.startWirePacket(builder);
    FBS.WirePacket.addMsgType(builder, FBS.MsgType.Ping);
    const packet = FBS.WirePacket.endWirePacket(builder);
    builder.finish(packet);
    return builder.asUint8Array();
}

/** Encode Pong */
export function encodePong(serverTime: number): Uint8Array {
    const builder = new Builder(32);
    FBS.WirePacket.startWirePacket(builder);
    FBS.WirePacket.addMsgType(builder, FBS.MsgType.Pong);
    FBS.WirePacket.addTimestamp(builder, serverTime);
    const packet = FBS.WirePacket.endWirePacket(builder);
    builder.finish(packet);
    return builder.asUint8Array();
}

/** Encode Encrypted Packet */
export function encodeEncrypted(payload: Uint8Array): Uint8Array {
    const builder = new Builder(256 + payload.length);
    const payloadOffset = builder.createByteVector(payload);

    FBS.WirePacket.startWirePacket(builder);
    FBS.WirePacket.addMsgType(builder, FBS.MsgType.Encrypted);
    FBS.WirePacket.addEncryptedPayload(builder, payloadOffset);

    const packet = FBS.WirePacket.endWirePacket(builder);
    builder.finish(packet);
    return builder.asUint8Array();
}

/** Encode CAS */
export function encodeCAS(key: string, expected: Uint8Array | null, newValue: Uint8Array, actorId: string): Uint8Array {
    const builder = new Builder(256);

    const keyOffset = builder.createString(key);
    const newOffset = builder.createByteVector(newValue);
    const expOffset = expected ? builder.createByteVector(expected) : 0;
    const actorOffset = builder.createString(actorId);

    FBS.CompareAndSwap.startCompareAndSwap(builder);
    FBS.CompareAndSwap.addKey(builder, keyOffset);
    FBS.CompareAndSwap.addNewValue(builder, newOffset);
    if (expOffset) FBS.CompareAndSwap.addExpectedValue(builder, expOffset);
    FBS.CompareAndSwap.addActorId(builder, actorOffset);

    // CAS Timestamp
    // FBS.CompareAndSwap.addTimestamp(builder, ...);

    const casOffset = FBS.CompareAndSwap.endCompareAndSwap(builder);

    FBS.WirePacket.startWirePacket(builder);
    FBS.WirePacket.addMsgType(builder, FBS.MsgType.CompareAndSwap);
    FBS.WirePacket.addCas(builder, casOffset);

    const packet = FBS.WirePacket.endWirePacket(builder);
    builder.finish(packet);
    return builder.asUint8Array();
}

// Snapshot helpers (MsgPack wrappers for consistency)
export const encodeSnapshot = encodeValue;
export const decodeSnapshot = decodeValue;

// Decoder
export interface DecodedMessage {
    type: FBS.MsgType;
    key?: string;
    payload?: Uint8Array;
    expectedValue?: Uint8Array | null;
    timestamp?: bigint;
    isEncrypted?: boolean;
    actorId?: string;
    serverTime?: number;
    deps?: string[];
}

export function decodeMessage(data: Uint8Array): DecodedMessage | null {
    try {
        const buf = new ByteBuffer(data);
        const packet = FBS.WirePacket.getRootAsWirePacket(buf);

        const type = packet.msgType();
        if (type === FBS.MsgType.Unknown) return null;

        const baseMsg: DecodedMessage = { type, serverTime: packet.timestamp() };

        switch (type) {
            case FBS.MsgType.Op: {
                const op = packet.op();
                if (!op) return null;

                const key = op.key();
                const valArray = op.valueArray();

                // Timestamp (HLC)
                const hlc = op.timestamp();
                const ts = hlc ? ((hlc.upper() << 64n) | hlc.lower()) : 0n;

                return {
                    ...baseMsg,
                    key: key || undefined,
                    payload: valArray || new Uint8Array(),
                    timestamp: ts,
                    actorId: op.actorId() || undefined,
                    isEncrypted: op.isEncrypted()
                };
            }
            case FBS.MsgType.Init: {
                const snap = packet.snapshot();
                if (snap) {
                    const data = snap.dataArray();
                    return { ...baseMsg, payload: data || new Uint8Array() };
                }
                const payload = packet.payloadArray();
                return { ...baseMsg, payload: payload || new Uint8Array() };
            }
            case FBS.MsgType.CompareAndSwap: {
                const cas = packet.cas();
                if (!cas) return null;
                return {
                    ...baseMsg,
                    key: cas.key() || undefined,
                    payload: cas.newValueArray() || new Uint8Array(),
                    expectedValue: cas.expectedValueArray(),
                    actorId: cas.actorId() || undefined,
                };
            }
            case FBS.MsgType.Encrypted: {
                const payload = packet.encryptedPayloadArray();
                return { ...baseMsg, payload: payload || new Uint8Array() };
            }
            // Ping/Pong/Signal/etc
            default:
                return baseMsg;
        }
    } catch (e) {
        // console.error('[Protocol] Decode Error', e);
        return null;
    }
}
