import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';
import { Op } from '../schema/nmeshed/op';
import { SyncPacket } from '../schema/nmeshed/sync-packet';
import { Signal } from '../schema/nmeshed/signal';
import { encodeValue } from '../codec';

/**
 * Utility to pack parameters into a binary WirePacket for testing.
 */
export function packOp(key: string, value: any, timestamp: number = Date.now()): Uint8Array {
    const builder = new flatbuffers.Builder(1024);

    const keyOffset = builder.createString(key);
    const valBytes = value instanceof Uint8Array ? value : encodeValue(value);
    const valOffset = Op.createValueVector(builder, valBytes);

    Op.startOp(builder);
    Op.addKey(builder, keyOffset);
    Op.addValue(builder, valOffset);
    Op.addTimestamp(builder, BigInt(timestamp));
    const opOffset = Op.endOp(builder);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Op);
    WirePacket.addOp(builder, opOffset);
    const packetOffset = WirePacket.endWirePacket(builder);

    builder.finish(packetOffset);
    return builder.asUint8Array();
}

export function packInit(data: Record<string, any>): Uint8Array {
    // Legacy init is JSON, but for "strict" tests we might want to pack it into a Signal
    // or just send the JSON string if the transport still supports it for 'init' type.
    // However, the router doesn't parse 'init' from binary.
    // SyncEngine.handleInitSnapshot takes a Record.
    // Let's assume 'init' comes as JSON-in-string from transport for now,
    // as signaling usually stays JSON.
    return new TextEncoder().encode(JSON.stringify({ type: 'init', payload: data }));
}

export function packSync(snapshot?: Uint8Array): Uint8Array {
    const builder = new flatbuffers.Builder(1024);

    let snapshotOffset = 0;
    if (snapshot) {
        snapshotOffset = SyncPacket.createSnapshotVector(builder, snapshot);
    }

    SyncPacket.startSyncPacket(builder);
    if (snapshot) SyncPacket.addSnapshot(builder, snapshotOffset);
    const syncOffset = SyncPacket.endSyncPacket(builder);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Sync);
    WirePacket.addSync(builder, syncOffset);
    const packetOffset = WirePacket.endWirePacket(builder);

    builder.finish(packetOffset);
    return builder.asUint8Array();
}
