/**
 * @file WireFactory.test.ts
 * @brief Tests for WireFactory FlatBuffer packet creation.
 */

import { describe, it, expect } from 'vitest';
import { WireFactory } from './WireFactory';
import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';

describe('WireFactory', () => {
    describe('createOpPacket', () => {
        it('creates a valid Op WirePacket with key, value, and timestamp', () => {
            const key = 'test:key';
            const value = new Uint8Array([1, 2, 3, 4]);
            const timestamp = BigInt(Date.now());

            const packet = WireFactory.createOpPacket(key, value, timestamp);

            expect(packet).toBeInstanceOf(Uint8Array);
            expect(packet.length).toBeGreaterThan(0);

            // Parse and verify structure
            const buf = new flatbuffers.ByteBuffer(packet);
            const parsed = WirePacket.getRootAsWirePacket(buf);

            expect(parsed.msgType()).toBe(MsgType.Op);
            expect(parsed.op()?.key()).toBe(key);
            expect(parsed.op()?.timestamp()).toBe(timestamp);

            // Verify value bytes
            const parsedValue = parsed.op()?.valueArray();
            expect(parsedValue).toEqual(value);
        });

        it('creates Op packet with workspaceId when provided', () => {
            const key = 'test:key';
            const value = new Uint8Array([5, 6, 7]);
            const timestamp = BigInt(1234567890);
            const workspaceId = 'workspace-123';

            const packet = WireFactory.createOpPacket(key, value, timestamp, workspaceId);

            const buf = new flatbuffers.ByteBuffer(packet);
            const parsed = WirePacket.getRootAsWirePacket(buf);

            expect(parsed.op()?.workspaceId()).toBe(workspaceId);
        });

        it('handles empty value', () => {
            const packet = WireFactory.createOpPacket('key', new Uint8Array(0), BigInt(0));

            const buf = new flatbuffers.ByteBuffer(packet);
            const parsed = WirePacket.getRootAsWirePacket(buf);

            expect(parsed.msgType()).toBe(MsgType.Op);
            expect(parsed.op()?.valueLength()).toBe(0);
        });
    });

    describe('createSyncPacket', () => {
        it('creates a valid Sync WirePacket with payload', () => {
            const payload = new Uint8Array([10, 20, 30, 40, 50]);

            const packet = WireFactory.createSyncPacket(payload);

            expect(packet).toBeInstanceOf(Uint8Array);
            expect(packet.length).toBeGreaterThan(0);

            // Parse and verify structure
            const buf = new flatbuffers.ByteBuffer(packet);
            const parsed = WirePacket.getRootAsWirePacket(buf);

            expect(parsed.msgType()).toBe(MsgType.Sync);
            expect(parsed.payloadArray()).toEqual(payload);
        });

        it('handles empty payload', () => {
            const packet = WireFactory.createSyncPacket(new Uint8Array(0));

            const buf = new flatbuffers.ByteBuffer(packet);
            const parsed = WirePacket.getRootAsWirePacket(buf);

            expect(parsed.msgType()).toBe(MsgType.Sync);
            expect(parsed.payloadLength()).toBe(0);
        });

        it('handles large payload', () => {
            const largePayload = new Uint8Array(10000).fill(42);

            const packet = WireFactory.createSyncPacket(largePayload);

            const buf = new flatbuffers.ByteBuffer(packet);
            const parsed = WirePacket.getRootAsWirePacket(buf);

            expect(parsed.payloadLength()).toBe(10000);
        });
    });

    describe('createSignalPacket', () => {
        it('creates a valid Signal WirePacket with payload', () => {
            const payload = new Uint8Array([100, 200, 255]);

            const packet = WireFactory.createSignalPacket(payload);

            expect(packet).toBeInstanceOf(Uint8Array);
            expect(packet.length).toBeGreaterThan(0);

            // Parse and verify structure
            const buf = new flatbuffers.ByteBuffer(packet);
            const parsed = WirePacket.getRootAsWirePacket(buf);

            expect(parsed.msgType()).toBe(MsgType.Signal);
            expect(parsed.payloadArray()).toEqual(payload);
        });

        it('handles empty signal payload', () => {
            const packet = WireFactory.createSignalPacket(new Uint8Array(0));

            const buf = new flatbuffers.ByteBuffer(packet);
            const parsed = WirePacket.getRootAsWirePacket(buf);

            expect(parsed.msgType()).toBe(MsgType.Signal);
            expect(parsed.payloadLength()).toBe(0);
        });
    });
});
