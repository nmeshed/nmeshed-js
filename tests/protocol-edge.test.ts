
import { describe, it, expect, vi } from 'vitest';
import { decodeMessage, encodeOp, MsgType } from '../src/protocol';
import { Builder } from 'flatbuffers';
import * as FBS from '../src/schema/nmeshed';

describe('Protocol Edge Cases', () => {
    it('should return null for malformed/garbage data', () => {
        const garbage = new Uint8Array([0xFF, 0x00, 0xAA]);
        const result = decodeMessage(garbage);
        expect(result).toBeNull();
    });

    it('should return null for Unknown message type', () => {
        const builder = new Builder(64);
        FBS.WirePacket.startWirePacket(builder);
        FBS.WirePacket.addMsgType(builder, FBS.MsgType.Unknown);
        const packet = FBS.WirePacket.endWirePacket(builder);
        builder.finish(packet);
        const data = builder.asUint8Array();

        const result = decodeMessage(data);
        expect(result).toBeNull();
    });

    it('should handle timestamp explicit types in encodeOp', () => {
        // Test number (cast for TS check, though runtime might handle if signature allows number | bigint, but signature is strict)
        // Check src/protocol.ts definition: timestamp?: bigint. 
        // We want to test if it handles 'number' passed at runtime or via any-cast? 
        // Implementation: typeof timestamp === 'number' IS handled. 
        // So we suppress TS error to test runtime resilience.
        // @ts-ignore
        const op1 = encodeOp('k', new Uint8Array(), 123);
        const dec1 = decodeMessage(op1);
        expect(dec1?.timestamp).toBe(123n);

        // Test bigint
        const op2 = encodeOp('k', new Uint8Array(), 123n);
        const dec2 = decodeMessage(op2);
        expect(dec2?.timestamp).toBe(123n);

        // Test default (Date.now)
        const start = Date.now();
        const op3 = encodeOp('k', new Uint8Array());
        const dec3 = decodeMessage(op3);
        // HLC logic in protocol defaults to current time if undefined
        // It might be slightly larger due to HLC logical shift, but upper bits match
        expect(Number(dec3?.timestamp! >> 64n) || Number(dec3?.timestamp!)).toBeGreaterThanOrEqual(start);
    });

    it('should handle missing payload in Init message', () => {
        const builder = new Builder(64);
        FBS.WirePacket.startWirePacket(builder);
        FBS.WirePacket.addMsgType(builder, FBS.MsgType.Init);
        // No payload added
        const packet = FBS.WirePacket.endWirePacket(builder);
        builder.finish(packet);
        const data = builder.asUint8Array();

        const result = decodeMessage(data);
        expect(result?.type).toBe(MsgType.Init);
        expect(result?.payload).toBeDefined(); // Should default to empty Uint8Array
        expect(result?.payload?.length).toBe(0);
    });
});
