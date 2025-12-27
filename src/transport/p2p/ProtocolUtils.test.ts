import { describe, it, expect } from 'vitest';
import { ProtocolUtils } from './ProtocolUtils';
import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../../schema/nmeshed/wire-packet';
import { MsgType } from '../../schema/nmeshed/msg-type';
import { SignalData } from '../../schema/nmeshed/signal-data';
import { Join } from '../../schema/nmeshed/join';
import { Offer } from '../../schema/nmeshed/offer';
import { Answer } from '../../schema/nmeshed/answer';
import { Candidate } from '../../schema/nmeshed/candidate';
import { Relay } from '../../schema/nmeshed/relay';
import { SignalMessage } from './types';

describe('ProtocolUtils', () => {

    // Helpers to unwind the flatbuffer for verification
    const readWirePacket = (bytes: Uint8Array) => {
        const buf = new flatbuffers.ByteBuffer(bytes);
        return WirePacket.getRootAsWirePacket(buf);
    };

    it('createSignalPacket constructs Join signal correctly', () => {
        const joinMsg: SignalMessage = { type: 'join', workspaceId: 'ws-123' };
        const bytes = ProtocolUtils.createSignalPacket('server', 'peer1', joinMsg);

        const wire = readWirePacket(bytes);
        expect(wire.msgType()).toBe(MsgType.Signal);

        const signal = wire.signal();
        expect(signal).not.toBeNull();
        expect(signal!.toPeer()).toBe('server');
        expect(signal!.fromPeer()).toBe('peer1');
        expect(signal!.dataType()).toBe(SignalData.Join);

        const join = signal!.data(new Join());
        expect(join).not.toBeNull();
        expect(join!.workspaceId()).toBe('ws-123');
    });

    it('createSignalPacket constructs Offer signal correctly', () => {
        const offerMsg: SignalMessage = { type: 'offer', sdp: 'sdp-offer-content' };
        const bytes = ProtocolUtils.createSignalPacket('peer2', 'peer1', offerMsg);

        const wire = readWirePacket(bytes);
        expect(wire.msgType()).toBe(MsgType.Signal);

        const signal = wire.signal();
        expect(signal!.dataType()).toBe(SignalData.Offer);

        const offer = signal!.data(new Offer());
        expect(offer!.sdp()).toBe('sdp-offer-content');
    });

    it('createSignalPacket constructs Answer signal correctly', () => {
        const answerMsg: SignalMessage = { type: 'answer', sdp: 'sdp-answer-content' };
        const bytes = ProtocolUtils.createSignalPacket('peer1', 'peer2', answerMsg);

        const wire = readWirePacket(bytes);
        const signal = wire.signal();
        expect(signal!.dataType()).toBe(SignalData.Answer);

        const answer = signal!.data(new Answer());
        expect(answer!.sdp()).toBe('sdp-answer-content');
    });

    it('createSignalPacket constructs Candidate signal correctly', () => {
        const candMsg: SignalMessage = {
            type: 'candidate',
            candidate: { candidate: 'candidate:1', sdpMid: 'audio', sdpMLineIndex: 0 }
        };
        const bytes = ProtocolUtils.createSignalPacket('peer2', 'peer1', candMsg);

        const wire = readWirePacket(bytes);
        const signal = wire.signal();
        expect(signal!.dataType()).toBe(SignalData.Candidate);

        const cand = signal!.data(new Candidate());
        expect(cand!.candidate()).toBe('candidate:1');
        expect(cand!.sdpMid()).toBe('audio');
        expect(cand!.sdpMLineIndex()).toBe(0);
    });

    it('createSignalPacket constructs Relay signal correctly', () => {
        const relayMsg: SignalMessage = { type: 'relay', data: new Uint8Array([1, 2, 3]) };
        const bytes = ProtocolUtils.createSignalPacket('peer2', 'peer1', relayMsg);

        const wire = readWirePacket(bytes);
        const signal = wire.signal();
        expect(signal!.dataType()).toBe(SignalData.Relay);

        const relay = signal!.data(new Relay());
        const dataArr = relay!.dataArray();
        expect(dataArr).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('createSyncPacket constructs generic payload packet correctly', () => {
        const payload = new Uint8Array([10, 20, 30]);
        const bytes = ProtocolUtils.createSyncPacket(payload);

        const wire = readWirePacket(bytes);
        expect(wire.msgType()).toBe(MsgType.Sync);

        // Generic sync packet uses direct payload field
        const p = wire.payloadArray();
        expect(p).toEqual(payload);
    });

    it('createStateSyncPacket constructs SyncPacket with StateVector', () => {
        const sv = new Map<string, bigint>();
        sv.set('peerA', BigInt(100));
        sv.set('peerB', BigInt(200));

        const bytes = ProtocolUtils.createStateSyncPacket({ stateVector: sv });
        const wire = readWirePacket(bytes);
        expect(wire.msgType()).toBe(MsgType.Sync);

        const sync = wire.sync();
        expect(sync).not.toBeNull();
        expect(sync!.stateVectorLength()).toBe(2);

        // Check entries (order not guaranteed by map iteration usually, but small enough)
        // Accessing flatbuffer vector in loop
        const entries: any[] = [];
        for (let i = 0; i < sync!.stateVectorLength(); i++) {
            entries.push(sync!.stateVector(i));
        }

        const peerA = entries.find(e => e.peerId() === 'peerA');
        expect(peerA).toBeDefined();
        expect(peerA.seq()).toBe(BigInt(100));
    });

    it('createStateSyncPacket constructs SyncPacket with Snapshot', () => {
        const snapshot = new Uint8Array([9, 8, 7]);
        const bytes = ProtocolUtils.createStateSyncPacket({ snapshot });
        const wire = readWirePacket(bytes);

        const sync = wire.sync();
        expect(sync!.snapshotArray()).toEqual(snapshot);
    });

    it('createStateSyncPacket constructs SyncPacket with AckSeq', () => {
        const bytes = ProtocolUtils.createStateSyncPacket({ ackSeq: BigInt(999) });
        const wire = readWirePacket(bytes);
        const sync = wire.sync();
        expect(sync!.ackSeq()).toBe(BigInt(999));
    });
});
