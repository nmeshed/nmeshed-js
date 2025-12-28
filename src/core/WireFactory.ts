/**
 * WireFactory: The gateway between Local State and Network Flow.
 * 
 * It ensures every byte leaving the system is "Whole"—containing 
 * the key, the essence (value), and the temporal marker (timestamp).
 * 
 * This is the only place where FlatBuffer serialization complexity lives,
 * leaving the rest of the engine serene.
 */
import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { Op } from '../schema/nmeshed/op';
import { MsgType } from '../schema/nmeshed/msg-type';

export const WireFactory = {
    /**
     * Creates a complete WirePacket containing an Op with timestamp.
     * 
     * @param key - The key being modified
     * @param value - The encoded value bytes (from codec or WASM)
     * @param timestamp - The timestamp in microseconds (BigInt)
     * @param workspaceId - Optional workspace ID (defaults to empty)
     * @returns A complete FlatBuffer WirePacket ready for network transmission
     */
    createOpPacket(
        key: string,
        value: Uint8Array,
        timestamp: bigint,
        workspaceId: string = ''
    ): Uint8Array {
        const builder = new flatbuffers.Builder(1024);

        // Create string offsets first (FlatBuffers requirement)
        const keyOffset = builder.createString(key);
        const wsOffset = builder.createString(workspaceId);
        const valueOffset = Op.createValueVector(builder, value);

        // Build Op table
        Op.startOp(builder);
        Op.addWorkspaceId(builder, wsOffset);
        Op.addKey(builder, keyOffset);
        Op.addTimestamp(builder, timestamp);
        Op.addValue(builder, valueOffset);
        const opOffset = Op.endOp(builder);

        // Wrap in WirePacket envelope
        WirePacket.startWirePacket(builder);
        WirePacket.addMsgType(builder, MsgType.Op);
        WirePacket.addOp(builder, opOffset);
        const packetOffset = WirePacket.endWirePacket(builder);

        builder.finish(packetOffset);
        return builder.asUint8Array();
    },

    /**
     * Creates a Sync WirePacket with payload.
     * 
     * @param payload - The sync payload bytes
     * @returns A complete FlatBuffer WirePacket for sync
     */
    createSyncPacket(payload: Uint8Array): Uint8Array {
        const builder = new flatbuffers.Builder(1024);

        const payloadOffset = WirePacket.createPayloadVector(builder, payload);

        WirePacket.startWirePacket(builder);
        WirePacket.addMsgType(builder, MsgType.Sync);
        WirePacket.addPayload(builder, payloadOffset);
        const packetOffset = WirePacket.endWirePacket(builder);

        builder.finish(packetOffset);
        return builder.asUint8Array();
    },

    /**
     * Creates a Signal WirePacket for ephemeral messages.
     * 
     * @param payload - The signal payload bytes
     * @returns A complete FlatBuffer WirePacket for signals
     */
    createSignalPacket(payload: Uint8Array): Uint8Array {
        const builder = new flatbuffers.Builder(1024);

        const payloadOffset = WirePacket.createPayloadVector(builder, payload);

        WirePacket.startWirePacket(builder);
        WirePacket.addMsgType(builder, MsgType.Signal);
        WirePacket.addPayload(builder, payloadOffset);
        const packetOffset = WirePacket.endWirePacket(builder);

        builder.finish(packetOffset);
        return builder.asUint8Array();
    }
};
