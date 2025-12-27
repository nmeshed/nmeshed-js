/**
 * MessageRouter Tests
 * 
 * Tests for the Single Parsing Gateway that transforms raw WirePacket bytes
 * into typed IncomingMessage discriminated unions.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MessageRouter, IncomingMessage, OpMessage, SyncMessage, InitMessage, SignalMessage } from './MessageRouter';
import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';
import { Op } from '../schema/nmeshed/op';
import { SyncPacket } from '../schema/nmeshed/sync-packet';
import { StateVectorEntry } from '../schema/nmeshed/state-vector-entry';
import { encodeValue } from '../codec';

// Helper: Create WirePacket with MsgType.Op
function createOpPacket(key: string, value: Uint8Array, timestamp?: bigint): Uint8Array {
    const builder = new flatbuffers.Builder(1024);

    const keyOffset = builder.createString(key);
    const valueOffset = Op.createValueVector(builder, value);
    const wsOffset = builder.createString('test-ws');

    Op.startOp(builder);
    Op.addWorkspaceId(builder, wsOffset);
    Op.addKey(builder, keyOffset);
    Op.addValue(builder, valueOffset);
    if (timestamp !== undefined) {
        Op.addTimestamp(builder, timestamp);
    }
    const opOffset = Op.endOp(builder);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Op);
    WirePacket.addOp(builder, opOffset);
    const packetOffset = WirePacket.endWirePacket(builder);

    builder.finish(packetOffset);
    return builder.asUint8Array();
}

// Helper: Create WirePacket with MsgType.Op but no value (delete operation)
function createDeleteOpPacket(key: string): Uint8Array {
    const builder = new flatbuffers.Builder(512);

    const keyOffset = builder.createString(key);
    const wsOffset = builder.createString('test-ws');

    Op.startOp(builder);
    Op.addWorkspaceId(builder, wsOffset);
    Op.addKey(builder, keyOffset);
    // No value = delete
    const opOffset = Op.endOp(builder);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Op);
    WirePacket.addOp(builder, opOffset);
    const packetOffset = WirePacket.endWirePacket(builder);

    builder.finish(packetOffset);
    return builder.asUint8Array();
}

// Helper: Create WirePacket with MsgType.Sync containing snapshot
function createSyncPacketWithSnapshot(snapshotData: Uint8Array): Uint8Array {
    const builder = new flatbuffers.Builder(1024);

    const snapOffset = SyncPacket.createSnapshotVector(builder, snapshotData);
    SyncPacket.startSyncPacket(builder);
    SyncPacket.addSnapshot(builder, snapOffset);
    const syncOffset = SyncPacket.endSyncPacket(builder);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Sync);
    WirePacket.addSync(builder, syncOffset);
    const packetOffset = WirePacket.endWirePacket(builder);

    builder.finish(packetOffset);
    return builder.asUint8Array();
}

// Helper: Create WirePacket with MsgType.Sync containing stateVector and ackSeq
function createSyncPacketWithStateVector(entries: { peerId: string, seq: bigint }[], ackSeq?: bigint): Uint8Array {
    const builder = new flatbuffers.Builder(1024);

    // Create state vector entries
    const entryOffsets: number[] = [];
    for (const entry of entries) {
        const peerIdOffset = builder.createString(entry.peerId);
        StateVectorEntry.startStateVectorEntry(builder);
        StateVectorEntry.addPeerId(builder, peerIdOffset);
        StateVectorEntry.addSeq(builder, entry.seq);
        entryOffsets.push(StateVectorEntry.endStateVectorEntry(builder));
    }
    const svOffset = SyncPacket.createStateVectorVector(builder, entryOffsets);

    SyncPacket.startSyncPacket(builder);
    SyncPacket.addStateVector(builder, svOffset);
    if (ackSeq !== undefined) {
        SyncPacket.addAckSeq(builder, ackSeq);
    }
    const syncOffset = SyncPacket.endSyncPacket(builder);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Sync);
    WirePacket.addSync(builder, syncOffset);
    const packetOffset = WirePacket.endWirePacket(builder);

    builder.finish(packetOffset);
    return builder.asUint8Array();
}

// Helper: Create WirePacket with MsgType.Sync and payload (fallback path)
function createSyncPayloadPacket(payload: Uint8Array): Uint8Array {
    const builder = new flatbuffers.Builder(512);

    const payloadOffset = WirePacket.createPayloadVector(builder, payload);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Sync);
    WirePacket.addPayload(builder, payloadOffset);
    const packetOffset = WirePacket.endWirePacket(builder);

    builder.finish(packetOffset);
    return builder.asUint8Array();
}

// Helper: Create WirePacket with MsgType.Signal
function createSignalPacket(payload: Uint8Array): Uint8Array {
    const builder = new flatbuffers.Builder(512);

    const payloadOffset = WirePacket.createPayloadVector(builder, payload);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Signal);
    WirePacket.addPayload(builder, payloadOffset);
    const packetOffset = WirePacket.endWirePacket(builder);

    builder.finish(packetOffset);
    return builder.asUint8Array();
}

describe('MessageRouter', () => {
    let router: MessageRouter;

    beforeEach(() => {
        router = new MessageRouter(true); // debug mode for coverage
    });

    describe('parse() - Op messages', () => {
        it('parses MsgType.Op with key and value', () => {
            const value = encodeValue({ test: 'data' });
            const packet = createOpPacket('my-key', value, 12345n);

            const result = router.parse(packet);

            expect(result).not.toBeNull();
            expect(result!.type).toBe('op');
            const opMsg = result as OpMessage;
            expect(opMsg.key).toBe('my-key');
            expect(opMsg.value).toBeInstanceOf(Uint8Array);
            expect(opMsg.timestamp).toBe(12345n);
        });

        it('parses MsgType.Op without timestamp', () => {
            const value = new Uint8Array([1, 2, 3]);
            const packet = createOpPacket('key2', value);

            const result = router.parse(packet);

            expect(result).not.toBeNull();
            const opMsg = result as OpMessage;
            expect(opMsg.key).toBe('key2');
            expect(opMsg.timestamp).toBeUndefined();
        });

        it('parses MsgType.Op with null value (delete)', () => {
            const packet = createDeleteOpPacket('delete-key');

            const result = router.parse(packet);

            expect(result).not.toBeNull();
            const opMsg = result as OpMessage;
            expect(opMsg.key).toBe('delete-key');
            expect(opMsg.value).toBeNull();
        });
    });

    describe('parse() - Sync messages', () => {
        it('parses MsgType.Sync with snapshot', () => {
            const snapshot = encodeValue({ state: 'initial' });
            const packet = createSyncPacketWithSnapshot(snapshot);

            const result = router.parse(packet);

            expect(result).not.toBeNull();
            expect(result!.type).toBe('sync');
            const syncMsg = result as SyncMessage;
            expect(syncMsg.snapshot).toBeInstanceOf(Uint8Array);
            expect(syncMsg.snapshot!.length).toBeGreaterThan(0);
        });

        it('parses MsgType.Sync with stateVector', () => {
            const entries = [
                { peerId: 'peer-1', seq: 100n },
                { peerId: 'peer-2', seq: 200n },
            ];
            const packet = createSyncPacketWithStateVector(entries);

            const result = router.parse(packet);

            expect(result).not.toBeNull();
            expect(result!.type).toBe('sync');
            const syncMsg = result as SyncMessage;
            expect(syncMsg.stateVector).toBeInstanceOf(Map);
            expect(syncMsg.stateVector!.size).toBe(2);
            expect(syncMsg.stateVector!.get('peer-1')).toBe(100n);
            expect(syncMsg.stateVector!.get('peer-2')).toBe(200n);
        });

        it('parses MsgType.Sync with ackSeq', () => {
            const entries = [{ peerId: 'peer-1', seq: 50n }];
            const packet = createSyncPacketWithStateVector(entries, 999n);

            const result = router.parse(packet);

            expect(result).not.toBeNull();
            const syncMsg = result as SyncMessage;
            expect(syncMsg.ackSeq).toBe(999n);
        });

        it('parses MsgType.Sync with payload fallback (non-SyncPacket data)', () => {
            // When payload is not a valid SyncPacket, the behavior depends on FlatBuffers parsing
            // FlatBuffers is lenient and may parse junk as an empty struct
            const payload = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
            const packet = createSyncPayloadPacket(payload);

            const result = router.parse(packet);

            // Should still return a sync message, possibly with undefined fields
            expect(result).not.toBeNull();
            expect(result!.type).toBe('sync');
        });
    });

    describe('parse() - Signal messages', () => {
        it('parses MsgType.Signal with payload', () => {
            const payload = new Uint8Array([1, 2, 3, 4, 5]);
            const packet = createSignalPacket(payload);

            const result = router.parse(packet);

            expect(result).not.toBeNull();
            expect(result!.type).toBe('signal');
            const signalMsg = result as SignalMessage;
            expect(signalMsg.payload).toBeInstanceOf(Uint8Array);
        });
    });

    describe('parse() - Edge cases', () => {
        it('returns null for empty bytes', () => {
            const result = router.parse(new Uint8Array(0));
            expect(result).toBeNull();
        });

        it('returns null for null/undefined input', () => {
            expect(router.parse(null as any)).toBeNull();
            expect(router.parse(undefined as any)).toBeNull();
        });

        it('returns null for malformed data', () => {
            const junk = new Uint8Array([0xFF, 0xFE, 0xFD, 0xFC]);
            const result = router.parse(junk);
            expect(result).toBeNull();
        });

        it('handles unknown MsgType gracefully', () => {
            // Create a packet with an invalid MsgType by manipulating bytes
            const builder = new flatbuffers.Builder(256);
            WirePacket.startWirePacket(builder);
            WirePacket.addMsgType(builder, 99 as MsgType); // Invalid type
            const packetOffset = WirePacket.endWirePacket(builder);
            builder.finish(packetOffset);

            const result = router.parse(builder.asUint8Array());
            expect(result).toBeNull();
        });
    });

    describe('Static factory methods', () => {
        it('createOp creates valid OpMessage', () => {
            const value = new Uint8Array([1, 2, 3]);
            const msg = MessageRouter.createOp('test-key', value, 123n);

            expect(msg.type).toBe('op');
            expect(msg.key).toBe('test-key');
            expect(msg.value).toBe(value);
            expect(msg.timestamp).toBe(123n);
        });

        it('createOp with null value', () => {
            const msg = MessageRouter.createOp('delete-key', null);

            expect(msg.type).toBe('op');
            expect(msg.value).toBeNull();
            expect(msg.timestamp).toBeUndefined();
        });

        it('createInit creates valid InitMessage', () => {
            const data = { foo: 'bar', count: 42 };
            const msg = MessageRouter.createInit(data);

            expect(msg.type).toBe('init');
            expect(msg.data).toEqual(data);
        });

        it('createSignal creates valid SignalMessage', () => {
            const payload = { cursor: { x: 10, y: 20 } };
            const msg = MessageRouter.createSignal(payload, 'user-123');

            expect(msg.type).toBe('signal');
            expect(msg.payload).toEqual(payload);
            expect(msg.from).toBe('user-123');
        });

        it('createSignal without from', () => {
            const payload = new Uint8Array([1, 2, 3]);
            const msg = MessageRouter.createSignal(payload);

            expect(msg.type).toBe('signal');
            expect(msg.from).toBeUndefined();
        });
    });

    describe('Debug mode', () => {
        it('router with debug=false does not throw', () => {
            const quietRouter = new MessageRouter(false);
            const junk = new Uint8Array([0xFF, 0xFE]);

            expect(() => quietRouter.parse(junk)).not.toThrow();
        });
    });
});
