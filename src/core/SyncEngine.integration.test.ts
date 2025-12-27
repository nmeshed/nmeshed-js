/**
 * SyncEngine Integration Tests
 * 
 * These tests construct real FlatBuffer WirePacket binaries to exercise
 * the full message processing pipeline in SyncEngine.applyRawMessage().
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncEngine } from './SyncEngine';
import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';
import { Op } from '../schema/nmeshed/op';
import { SyncPacket } from '../schema/nmeshed/sync-packet';
import { encodeValue } from '../codec';

// Mock WASM core with realistic behavior
vi.mock('../wasm/nmeshed_core', () => {
    class MockCore {
        state: Record<string, Uint8Array> = {};

        apply_local_op = vi.fn((key: string, value: Uint8Array, _ts: bigint) => {
            this.state[key] = value;
            return new Uint8Array([1, 2, 3, key.charCodeAt(0)]);
        });
        merge_remote_delta = vi.fn((delta: Uint8Array) => {
            return { key: 'merged-key', value: delta };
        });
        get_state = vi.fn(() => this.state);
        get_value = vi.fn((key: string) => this.state[key] || null);
    }
    return {
        default: vi.fn(),
        NMeshedClientCore: MockCore
    };
});

// Mock persistence
vi.mock('../persistence', () => ({
    loadQueue: vi.fn().mockResolvedValue([]),
    saveQueue: vi.fn().mockResolvedValue(undefined),
}));

// Helper: Create a WirePacket with MsgType.Op
function createOpPacket(key: string, value: unknown): Uint8Array {
    const builder = new flatbuffers.Builder(1024);

    const keyOffset = builder.createString(key);
    const valueBytes = encodeValue(value);
    const valueOffset = Op.createValueVector(builder, valueBytes);
    const wsOffset = builder.createString('test-ws');

    Op.startOp(builder);
    Op.addWorkspaceId(builder, wsOffset);
    Op.addKey(builder, keyOffset);
    Op.addValue(builder, valueOffset);
    Op.addTimestamp(builder, BigInt(Date.now()));
    const opOffset = Op.endOp(builder);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Op);
    WirePacket.addOp(builder, opOffset);
    const packetOffset = WirePacket.endWirePacket(builder);

    builder.finish(packetOffset);
    return builder.asUint8Array();
}

// Helper: Create a WirePacket with MsgType.Sync (with payload)
function createSyncPayloadPacket(payload: Uint8Array): Uint8Array {
    const builder = new flatbuffers.Builder(1024);

    const payloadOffset = WirePacket.createPayloadVector(builder, payload);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Sync);
    WirePacket.addPayload(builder, payloadOffset);
    const packetOffset = WirePacket.endWirePacket(builder);

    builder.finish(packetOffset);
    return builder.asUint8Array();
}

// Helper: Create a WirePacket with MsgType.Sync (with SyncPacket snapshot)
function createSyncSnapshotPacket(snapshotData: Uint8Array): Uint8Array {
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

// Helper: Create a WirePacket with MsgType.Signal (ephemeral)
function createSignalPayloadPacket(payload: Uint8Array): Uint8Array {
    const builder = new flatbuffers.Builder(1024);

    const payloadOffset = WirePacket.createPayloadVector(builder, payload);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Signal);
    WirePacket.addPayload(builder, payloadOffset);
    const packetOffset = WirePacket.endWirePacket(builder);

    builder.finish(packetOffset);
    return builder.asUint8Array();
}

describe('SyncEngine Integration Tests', () => {
    let engine: SyncEngine;

    beforeEach(async () => {
        engine = new SyncEngine('integration-test', 'crdt', 100, false);
        await engine.boot();
    });

    describe('applyRawMessage with real WirePackets', () => {

        it('processes MsgType.Op and emits op event', () => {
            const spy = vi.fn();
            engine.on('op', spy);

            const packet = createOpPacket('integ-key', 'integ-value');
            engine.applyRawMessage(packet);

            expect(spy).toHaveBeenCalled();
            // The key should be 'integ-key'
            const call = spy.mock.calls[0];
            expect(call[0]).toBe('integ-key');
        });

        it('processes MsgType.Op with null value as delete', () => {
            const spy = vi.fn();
            engine.on('op', spy);

            // Create an Op packet with empty value (delete)
            const builder = new flatbuffers.Builder(512);
            const keyOffset = builder.createString('delete-key');
            const wsOffset = builder.createString('test-ws');

            Op.startOp(builder);
            Op.addWorkspaceId(builder, wsOffset);
            Op.addKey(builder, keyOffset);
            // No value = delete
            Op.addTimestamp(builder, BigInt(Date.now()));
            const opOffset = Op.endOp(builder);

            WirePacket.startWirePacket(builder);
            WirePacket.addMsgType(builder, MsgType.Op);
            WirePacket.addOp(builder, opOffset);
            const packetOffset = WirePacket.endWirePacket(builder);
            builder.finish(packetOffset);

            engine.applyRawMessage(builder.asUint8Array());

            expect(spy).toHaveBeenCalledWith('delete-key', null, false);
        });

        it('processes MsgType.Sync with SyncPacket snapshot', () => {
            const snapshotData = encodeValue({ syncKey: 'syncValue' });
            const packet = createSyncSnapshotPacket(snapshotData);

            // Should not throw
            engine.applyRawMessage(packet);
        });

        it('processes MsgType.Sync with payload fallback', () => {
            const payload = encodeValue({ payloadKey: 'payloadValue' });
            const packet = createSyncPayloadPacket(payload);

            // Should not throw, uses payload fallback path
            engine.applyRawMessage(packet);
        });

        it('processes MsgType.Signal and emits ephemeral', () => {
            const spy = vi.fn();
            engine.on('ephemeral', spy);

            const payload = encodeValue({ ephemeralData: 123 });
            const packet = createSignalPayloadPacket(payload);

            engine.applyRawMessage(packet);

            expect(spy).toHaveBeenCalled();
        });

        it('falls back to applyRemoteDelta on parse error', () => {
            // Invalid packet - not a valid FlatBuffer
            const junkData = new Uint8Array([255, 254, 253, 0, 1, 2]);

            // Should not throw, falls back gracefully
            engine.applyRawMessage(junkData);
        });

        it('handles unknown MsgType gracefully', () => {
            // Create packet with invalid MsgType
            const builder = new flatbuffers.Builder(256);

            WirePacket.startWirePacket(builder);
            WirePacket.addMsgType(builder, 99 as any); // Unknown type
            const packetOffset = WirePacket.endWirePacket(builder);
            builder.finish(packetOffset);

            // Should not throw, logs warning
            engine.applyRawMessage(builder.asUint8Array());
        });
    });

    describe('handleBinarySync with real SyncPackets', () => {

        it('processes snapshot from SyncPacket', () => {
            const snapshotData = encodeValue({ snapKey: 'snapVal' });
            const packet = createSyncSnapshotPacket(snapshotData);

            engine.handleBinarySync(packet);
            // Should process without error
        });
    });

    describe('round-trip: set -> encode -> decode', () => {

        it('set produces delta that can be decoded', () => {
            const delta = engine.set('round-trip-key', { nested: { value: 42 } });

            expect(delta).toBeInstanceOf(Uint8Array);
            expect(delta.length).toBeGreaterThan(0);

            // The value should be retrievable
            expect(engine.get('round-trip-key')).toEqual({ nested: { value: 42 } });
        });
    });
});
