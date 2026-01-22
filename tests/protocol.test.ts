/**
 * NMeshed v2 - Protocol Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    encodeOp,
    encodeValue,
    decodeMessage,
    decodeValue,
    encodeSnapshot,
    decodeSnapshot,
    encodeInit,
    encodePing,
    encodePong,
    encodeCAS,
    encodeEncrypted,
    MsgType,
} from '../src/protocol';
import * as flatbuffers from 'flatbuffers';

describe('Protocol', () => {
    beforeEach(() => {
        vi.spyOn(console, 'error').mockImplementation(() => { }); // Suppress decode errors
    });

    describe('encodeValue / decodeValue', () => {
        it('should encode and decode strings', () => {
            const value = 'hello world';
            const encoded = encodeValue(value);
            const decoded = decodeValue<string>(encoded);
            expect(decoded).toBe(value);
        });

        it('should encode and decode numbers', () => {
            expect(decodeValue(encodeValue(42))).toBe(42);
            expect(decodeValue(encodeValue(3.14159))).toBeCloseTo(3.14159);
            expect(decodeValue(encodeValue(-100))).toBe(-100);
        });

        it('should encode and decode booleans', () => {
            expect(decodeValue(encodeValue(true))).toBe(true);
            expect(decodeValue(encodeValue(false))).toBe(false);
        });

        it('should encode and decode null', () => {
            expect(decodeValue(encodeValue(null))).toBe(null);
        });

        it('should encode and decode objects', () => {
            const obj = { nested: { deep: true }, arr: [1, 2, 3] };
            expect(decodeValue(encodeValue(obj))).toEqual(obj);
        });

        it('should encode and decode arrays', () => {
            const arr = [1, 'two', { three: 3 }, null];
            expect(decodeValue(encodeValue(arr))).toEqual(arr);
        });
    });

    describe('encodeOp', () => {
        it('should produce a valid Flatbuffer', () => {
            const payload = encodeValue('test');
            const result = encodeOp('mykey', payload);

            expect(result).toBeInstanceOf(Uint8Array);
            expect(result.length).toBeGreaterThan(0);
        });

        it('should ROUND TRIP through decodeMessage', () => {
            const key = 'test-key';
            const value = { temp: 98.6 };
            const payload = encodeValue(value);

            const wireBytes = encodeOp(key, payload);
            const msg = decodeMessage(wireBytes);

            expect(msg).not.toBeNull();
            expect(msg?.type).toBe(MsgType.Op);
            expect(msg?.key).toBe(key);

            const decodedVal = decodeValue(msg!.payload!);
            expect(decodedVal).toEqual(value);
        });

        it('should correctly ROUND TRIP timestamp through Flatbuffers', () => {
            const key = 'metrics-key';
            const value = { step: 42, active_agents: 500 };
            const payload = encodeValue(value);
            const expectedTimestamp = 1767950000000;

            const wireBytes = encodeOp(key, payload, expectedTimestamp);
            const msg = decodeMessage(wireBytes);

            expect(msg).not.toBeNull();
            expect(msg?.type).toBe(MsgType.Op);
            expect(msg?.key).toBe(key);

            expect(msg?.timestamp).toBeDefined();
            expect(msg!.timestamp).toBeGreaterThan(0);
            expect(msg!.timestamp).toBeLessThan(2000000000000);
            expect(Math.abs(msg!.timestamp! - expectedTimestamp)).toBeLessThan(1000);
        });

        it('should ROUND TRIP all Op fields correctly (field index regression test)', () => {
            const testCases = [
                { key: 'simple', value: 'string-value', ts: 1000000000000 },
                { key: 'with.dots.in.key', value: { nested: { deeply: true } }, ts: 1500000000000 },
                { key: 'unicode-キー', value: ['array', 'of', 'values'], ts: 1767950000000 },
                { key: 'empty-object', value: {}, ts: Date.now() },
                { key: 'null-value', value: null, ts: Date.now() - 1000 },
                { key: 'number-value', value: 42.5, ts: 1234567890123 },
                { key: 'boolean-false', value: false, ts: 9999999999999 },
                { key: 'large-timestamp', value: 'test', ts: 1900000000000 },
            ];

            for (const tc of testCases) {
                const payload = encodeValue(tc.value);
                const wireBytes = encodeOp(tc.key, payload, tc.ts);
                const msg = decodeMessage(wireBytes);

                expect(msg, `Failed for key: ${tc.key}`).not.toBeNull();
                expect(msg?.type, `Wrong type for key: ${tc.key}`).toBe(MsgType.Op);
                expect(msg?.key, `Key mismatch for: ${tc.key}`).toBe(tc.key);

                const decodedValue = decodeValue(msg!.payload!);
                expect(decodedValue, `Value mismatch for key: ${tc.key}`).toEqual(tc.value);

                expect(msg?.timestamp, `Timestamp missing for key: ${tc.key}`).toBeDefined();
                expect(Math.abs(msg!.timestamp! - tc.ts), `Timestamp mismatch for key: ${tc.key}`).toBeLessThan(1000);
            }
        });
    });

    describe('encodeInit / decodeMessage Init', () => {
        it('should encode and decode Init message', () => {
            const state = { key1: 'value1', key2: 42 };
            const snapshot = encodeSnapshot(state);
            const wireBytes = encodeInit(snapshot, 1700000000000);

            const msg = decodeMessage(wireBytes);
            expect(msg).not.toBeNull();
            expect(msg?.type).toBe(MsgType.Init);
            expect(msg?.payload).toBeInstanceOf(Uint8Array);

            const decoded = decodeSnapshot(msg!.payload!);
            expect(decoded).toEqual(state);
        });

        it('should encode Init without server time', () => {
            const snapshot = encodeSnapshot({ test: true });
            const wireBytes = encodeInit(snapshot);
            const msg = decodeMessage(wireBytes);

            expect(msg?.type).toBe(MsgType.Init);
        });
    });

    describe('encodePing / encodePong', () => {
        it('should encode Ping message', () => {
            const wireBytes = encodePing();
            const msg = decodeMessage(wireBytes);

            expect(msg).not.toBeNull();
            expect(msg?.type).toBe(MsgType.Ping);
        });

        it('should encode Pong message with timestamp', () => {
            const serverTime = 1767950000000;
            const wireBytes = encodePong(serverTime);
            const msg = decodeMessage(wireBytes);

            expect(msg).not.toBeNull();
            expect(msg?.type).toBe(MsgType.Pong);
            // Pong should include the server timestamp
        });
    });

    describe('encodeCas / decodeMessage CAS', () => {
        it('should encode and decode CAS message', () => {
            const key = 'counter';
            const expected = encodeValue(10);
            const newValue = encodeValue(11);
            const actorId = 'test-actor';

            const wireBytes = encodeCAS(key, expected, newValue, actorId);
            const msg = decodeMessage(wireBytes);

            expect(msg).not.toBeNull();
            expect(msg?.type).toBe(MsgType.CompareAndSwap);
            expect(msg?.key).toBe(key);
            expect(decodeValue(msg!.payload!)).toBe(11); // newValue
            expect(decodeValue(msg!.expectedValue!)).toBe(10); // expected
        });
    });

    describe('decodeMessage', () => {
        it('should handle invalid data gracefully', () => {
            const result = decodeMessage(new Uint8Array([1, 2, 3]));
            expect(result).toBeNull();
        });

        it('should handle empty buffer', () => {
            const result = decodeMessage(new Uint8Array([]));
            expect(result).toBeNull();
        });

        it('should handle truncated data', () => {
            const valid = encodeOp('key', encodeValue('value'));
            const truncated = valid.slice(0, 10);
            const result = decodeMessage(truncated);
            expect(result).toBeNull();
        });
    });

    describe('encodeSnapshot / decodeSnapshot', () => {
        it('should round trip snapshot data', () => {
            const state = { users: [{ id: 1 }], config: { theme: 'dark' } };
            const encoded = encodeSnapshot(state);
            const decoded = decodeSnapshot(encoded);
            expect(decoded).toEqual(state);
        });

        it('should handle empty object', () => {
            const encoded = encodeSnapshot({});
            const decoded = decodeSnapshot(encoded);
            expect(decoded).toEqual({});
        });
    });

    describe('encodeEncrypted / decodeMessage Encrypted', () => {
        it('should encode and decode Encrypted message', () => {
            const payload = new Uint8Array([1, 2, 3, 4, 5]); // Fake ciphertext
            const wireBytes = encodeEncrypted(payload);
            const msg = decodeMessage(wireBytes);

            expect(msg).not.toBeNull();
            expect(msg?.type).toBe(MsgType.Encrypted);
            expect(msg?.payload).toEqual(payload);
        });
    });

    describe('Op isEncrypted flag', () => {
        it('should verify isEncrypted flag is preserved', () => {
            const key = 'secret-key';
            const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

            // Case 1: Encrypted = true
            const wireTrue = encodeOp(key, payload, Date.now(), true);
            const msgTrue = decodeMessage(wireTrue);
            expect(msgTrue?.isEncrypted).toBe(true);

            // Case 2: Encrypted = false
            const wireFalse = encodeOp(key, payload, Date.now(), false);
            const msgFalse = decodeMessage(wireFalse);
            expect(msgFalse?.isEncrypted).toBe(false);
        });
    });

    describe('MsgType enum', () => {
        it('should have correct SERVER-ALIGNED values', () => {
            expect(MsgType.Unknown).toBe(0);
            expect(MsgType.Op).toBe(1);
            expect(MsgType.Sync).toBe(2);
            expect(MsgType.Signal).toBe(3);
            expect(MsgType.Init).toBe(4);
            expect(MsgType.Ping).toBe(5);
            expect(MsgType.Pong).toBe(6);
            expect(MsgType.CompareAndSwap).toBe(7);
            expect(MsgType.Encrypted).toBe(8);
        });
    });
});
