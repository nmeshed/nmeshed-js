/**
 * NMeshed v2 - Protocol Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
    encodeOp,
    encodeValue,
    decodeMessage,
    decodeValue,
    encodeSnapshot,
    decodeSnapshot,
    MsgType,
} from '../src/protocol';
import * as flatbuffers from 'flatbuffers';

describe('Protocol', () => {
    describe('encodeValue / decodeValue', () => {
        it('should encode and decode strings', () => {
            const value = 'hello world';
            const encoded = encodeValue(value);
            const decoded = decodeValue<string>(encoded);
            expect(decoded).toBe(value);
        });

        // ... existing value tests are fine as they use JSON ...
    });

    describe('encodeOp', () => {
        it('should produce a valid Flatbuffer', () => {
            const payload = encodeValue('test');
            const result = encodeOp('mykey', payload);

            // Basic Flatbuffer validation implies first 4 bytes imply offset
            expect(result).toBeInstanceOf(Uint8Array);
            expect(result.length).toBeGreaterThan(0);
        });

        it('should ROUND TRIP through decodeMessage', () => {
            const key = 'test-key';
            const value = { temp: 98.6 };
            const payload = encodeValue(value);

            // Encode
            const wireBytes = encodeOp(key, payload);

            // Decode
            const msg = decodeMessage(wireBytes);

            expect(msg).not.toBeNull();
            expect(msg?.type).toBe(MsgType.Op);
            expect(msg?.key).toBe(key);

            const decodedVal = decodeValue(msg!.payload!);
            expect(decodedVal).toEqual(value);
        });
    });

    describe('decodeMessage', () => {
        it('should handle invalid data gracefully', () => {
            const result = decodeMessage(new Uint8Array([1, 2, 3])); // Random noise
            expect(result).toBeNull();
        });
    });

    describe('MsgType enum', () => {
        it('should have correct SERVER-ALIGNED values', () => {
            // These MUST match the Rust Server Enums exactly
            // or the connection will fail/hang.
            expect(MsgType.Unknown).toBe(0);
            expect(MsgType.Op).toBe(1);
            expect(MsgType.Sync).toBe(2);
            expect(MsgType.Signal).toBe(3);
            expect(MsgType.Init).toBe(4);
        });
    });
});
