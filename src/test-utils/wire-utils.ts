import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';
import { encodeValue } from '../codec';
import { WireFactory } from '../core/WireFactory';

/**
 * Utility to pack parameters into a binary WirePacket for testing.
 * Delegates to production WireFactory where possible to ensure parity.
 */
export function packOp(key: string, value: any, timestamp: number = Date.now()): Uint8Array {
    const valBytes = value instanceof Uint8Array ? value : encodeValue(value);
    return WireFactory.createOpPacket(key, valBytes, BigInt(timestamp));
}

export function packInit(data: Record<string, any> | Uint8Array = new Uint8Array(0)): Uint8Array {
    const builder = new flatbuffers.Builder(1024);

    // Convert data to Uint8Array if needed (mock empty snapshot)
    const snapshotBytes = (data instanceof Uint8Array) ? data : new Uint8Array(0);

    const payloadOffset = WirePacket.createPayloadVector(builder, snapshotBytes);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Init);
    WirePacket.addPayload(builder, payloadOffset);
    const packetOffset = WirePacket.endWirePacket(builder);

    builder.finish(packetOffset);
    return builder.asUint8Array();
}

export function packSync(snapshot?: Uint8Array): Uint8Array {
    return WireFactory.createSyncPacket(snapshot || new Uint8Array(0));
}

/**
 * Packs an ephemeral signal as it would arrive from the relay.
 */
export function packSignal(payload: Uint8Array, senderId: string = 'system'): Uint8Array {
    const senderBytes = new TextEncoder().encode(senderId);
    const totalLen = 4 + senderBytes.length + 4 + payload.length;
    const packet = new Uint8Array(1 + 4 + totalLen);
    const view = new DataView(packet.buffer);

    view.setUint8(0, 0x04); // MsgType::Signal
    view.setUint32(1, totalLen, true);

    let offset = 5;
    view.setUint32(offset, senderBytes.length, true);
    offset += 4;
    packet.set(senderBytes, offset);
    offset += senderBytes.length;

    view.setUint32(offset, payload.length, true);
    offset += 4;
    packet.set(payload, offset);

    return packet;
}

/**
 * Packs a presence Join/Leave event.
 */
export function packPresence(userId: string, isJoin: boolean = true): Uint8Array {
    const userBytes = new TextEncoder().encode(userId);
    const payloadLen = 16 + 4 + userBytes.length + 1;
    const packet = new Uint8Array(1 + 4 + payloadLen);
    const view = new DataView(packet.buffer);

    view.setUint8(0, 0x03); // MsgType::Presence
    view.setUint32(1, payloadLen, true);

    let offset = 5;
    // Skip Workspace ID (16 bytes)
    offset += 16;

    view.setUint32(offset, userBytes.length, true);
    offset += 4;
    packet.set(userBytes, offset);
    offset += userBytes.length;

    packet[offset] = isJoin ? 0 : 1;

    return packet;
}
