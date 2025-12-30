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
