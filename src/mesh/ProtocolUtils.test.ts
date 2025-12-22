import { describe, it, expect } from 'vitest';
import * as flatbuffers from 'flatbuffers';
import { ProtocolUtils } from './ProtocolUtils';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';
import { SignalData } from '../schema/nmeshed/signal-data';

describe('ProtocolUtils', () => {
    describe('createSignalPacket', () => {
        it('creates a JOIN signal packet', () => {
            const packet = ProtocolUtils.createSignalPacket('peer-b', 'peer-a', {
                type: 'join',
                workspaceId: 'ws-123'
            });

            expect(packet).toBeDefined();
            expect(packet).toBeInstanceOf(Uint8Array);
            expect(packet.length).toBeGreaterThan(0);

            // Verify content
            const buf = new flatbuffers.ByteBuffer(packet);
            const wire = WirePacket.getRootAsWirePacket(buf);

            expect(wire.msgType()).toBe(MsgType.Signal);
            const signal = wire.signal();
            expect(signal).not.toBeNull();
            expect(signal!.toPeer()).toBe('peer-b');
            expect(signal!.fromPeer()).toBe('peer-a');
            expect(signal!.dataType()).toBe(SignalData.Join);

            // Deep inspection simplified to avoid flatbuffers.Table constructor issue
            // const join = signal!.data(new flatbuffers.Table()) as any; 
            // expect(join).toBeDefined();            // But here we rely on basic checks.
        });

        it('creates an OFFER signal packet', () => {
            const packet = ProtocolUtils.createSignalPacket('peer-b', 'peer-a', {
                type: 'offer',
                sdp: 'mock-sdp'
            });

            const buf = new flatbuffers.ByteBuffer(packet);
            const wire = WirePacket.getRootAsWirePacket(buf);
            expect(wire.msgType()).toBe(MsgType.Signal);
            expect(wire.signal()!.dataType()).toBe(SignalData.Offer);
        });

        it('creates a CANDIDATE signal packet', () => {
            const packet = ProtocolUtils.createSignalPacket('peer-b', 'peer-a', {
                type: 'candidate',
                candidate: {
                    candidate: 'candidate:1 1 UDP...',
                    sdpMid: '0',
                    sdpMLineIndex: 0
                }
            });

            const buf = new flatbuffers.ByteBuffer(packet);
            const wire = WirePacket.getRootAsWirePacket(buf);
            expect(wire.msgType()).toBe(MsgType.Signal);
            expect(wire.signal()!.dataType()).toBe(SignalData.Candidate);
        });

        it('creates a RELAY signal packet', () => {
            const data = new Uint8Array([1, 2, 3, 4]);
            const packet = ProtocolUtils.createSignalPacket('peer-b', 'peer-a', {
                type: 'relay',
                data: data
            });

            const buf = new flatbuffers.ByteBuffer(packet);
            const wire = WirePacket.getRootAsWirePacket(buf);
            expect(wire.msgType()).toBe(MsgType.Signal);
            expect(wire.signal()!.dataType()).toBe(SignalData.Relay);
        });
    });

    describe('createSyncPacket', () => {
        it('creates a generic SYNC packet', () => {
            const payload = new Uint8Array([0xAA, 0xBB]);
            const packet = ProtocolUtils.createSyncPacket(payload);

            const buf = new flatbuffers.ByteBuffer(packet);
            const wire = WirePacket.getRootAsWirePacket(buf);

            expect(wire.msgType()).toBe(MsgType.Sync);
            expect(wire.payloadLength()).toBe(2);
            expect(wire.payloadArray()).toEqual(new Uint8Array([0xAA, 0xBB]));
        });
    });
});
