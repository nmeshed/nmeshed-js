
import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { Signal } from '../schema/nmeshed/signal';
import { MsgType } from '../schema/nmeshed/msg-type';
import { SignalData } from '../schema/nmeshed/signal-data';
import { Join } from '../schema/nmeshed/join';
import { Offer } from '../schema/nmeshed/offer';
import { Answer } from '../schema/nmeshed/answer';
import { Candidate } from '../schema/nmeshed/candidate';
import { SignalMessage } from './types';

export class ProtocolUtils {
    private static builder = new flatbuffers.Builder(4096);

    public static createSignalPacket(to: string, from: string, signal: SignalMessage): Uint8Array {
        const builder = this.builder;
        builder.clear();

        const toOffset = builder.createString(to);
        const fromOffset = builder.createString(from);

        let dataType = SignalData.NONE;
        let dataOffset = 0;

        switch (signal.type) {
            case 'join':
                const wId = builder.createString(signal.workspaceId);
                Join.startJoin(builder);
                Join.addWorkspaceId(builder, wId);
                dataOffset = Join.endJoin(builder);
                dataType = SignalData.Join;
                break;
            case 'offer':
                const sdpOffer = builder.createString(signal.sdp);
                Offer.startOffer(builder);
                Offer.addSdp(builder, sdpOffer);
                dataOffset = Offer.endOffer(builder);
                dataType = SignalData.Offer;
                break;
            case 'answer':
                const sdpAnswer = builder.createString(signal.sdp);
                Answer.startAnswer(builder);
                Answer.addSdp(builder, sdpAnswer);
                dataOffset = Answer.endAnswer(builder);
                dataType = SignalData.Answer;
                break;
            case 'candidate':
                const candStr = builder.createString(signal.candidate.candidate);
                const midStr = builder.createString(signal.candidate.sdpMid || '');
                Candidate.startCandidate(builder);
                Candidate.addCandidate(builder, candStr);
                Candidate.addSdpMid(builder, midStr);
                Candidate.addSdpMLineIndex(builder, signal.candidate.sdpMLineIndex || 0);
                dataOffset = Candidate.endCandidate(builder);
                dataType = SignalData.Candidate;
                break;
        }

        Signal.startSignal(builder);
        Signal.addToPeer(builder, toOffset);
        Signal.addFromPeer(builder, fromOffset);
        Signal.addDataType(builder, dataType);
        Signal.addData(builder, dataOffset);
        const signalOffset = Signal.endSignal(builder);

        WirePacket.startWirePacket(builder);
        WirePacket.addMsgType(builder, MsgType.Signal);
        WirePacket.addSignal(builder, signalOffset);
        const wire = WirePacket.endWirePacket(builder);

        builder.finish(wire);
        return builder.asUint8Array();
    }

    public static createSyncPacket(payload: Uint8Array): Uint8Array {
        const builder = this.builder;
        builder.clear();

        const payloadOffset = WirePacket.createPayloadVector(builder, payload);

        WirePacket.startWirePacket(builder);
        WirePacket.addMsgType(builder, MsgType.Sync);
        WirePacket.addPayload(builder, payloadOffset);
        const wire = WirePacket.endWirePacket(builder);

        builder.finish(wire);
        return builder.asUint8Array();
    }
}
