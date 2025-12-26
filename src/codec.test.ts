import { describe, it, expect } from 'vitest';
import { encodeValue, decodeValue, isBinary } from './codec';

describe('FastBinaryCodec (FBC)', () => {
    describe('encodeValue & decodeValue', () => {
        const roundtrip = (val: any) => decodeValue(encodeValue(val));

        it('roundtrips primitives', () => {
            expect(roundtrip(null)).toBe(null);
            expect(roundtrip(true)).toBe(true);
            expect(roundtrip(false)).toBe(false);
            expect(roundtrip(123.456)).toBe(123.456);
            expect(roundtrip('hello world')).toBe('hello world');
        });

        it('roundtrips Uint8Array', () => {
            const input = new Uint8Array([1, 2, 3, 4, 5]);
            const decoded = roundtrip(input) as Uint8Array;
            expect(decoded).toBeInstanceOf(Uint8Array);
            expect(Array.from(decoded)).toEqual([1, 2, 3, 4, 5]);
        });

        it('roundtrips objects', () => {
            const input = { a: 1, b: 'two', c: { d: true }, e: [1, 2, 3] };
            expect(roundtrip(input)).toEqual(input);
        });

        it('roundtrips arrays', () => {
            const input = [1, 'two', { three: 3 }, [4, 5]];
            expect(roundtrip(input)).toEqual(input);
        });

        it('handles large strings', () => {
            const large = 'a'.repeat(10000);
            expect(roundtrip(large)).toBe(large);
        });

        it('throws on max recursion depth', () => {
            let deeplyNested: any = {};
            let current = deeplyNested;
            for (let i = 0; i < 40; i++) {
                current.next = {};
                current = current.next;
            }
            expect(() => encodeValue(deeplyNested)).toThrow('Max recursion depth');
        });

        it('throws on circular references', () => {
            const circular: any = { a: 1 };
            circular.self = circular;
            expect(() => encodeValue(circular)).toThrow('Max recursion depth');
        });

        it('does not fall back to JSON for legacy data (strict binary)', () => {
            const json = JSON.stringify({ legacy: true });
            const bytes = new TextEncoder().encode(json);
            // Starting with '{' (123) which is not a valid FBC tag
            expect(() => decodeValue(bytes)).toThrow('FBC unknown tag');
        });

        it('throws on malformed FBC data', () => {
            const malformed = new Uint8Array([99, 1, 2, 3]); // Tag 99 is unknown
            expect(() => decodeValue(malformed)).toThrow('FBC unknown tag');
        });

        it('throws on unexpected EOF during decoding', () => {
            const truncated = encodeValue({ a: 1 }).slice(0, 5);
            expect(() => decodeValue(truncated)).toThrow('FBC: Unexpected EOF');
        });
    });

    describe('isBinary', () => {
        it('returns true for Uint8Array and ArrayBuffer', () => {
            expect(isBinary(new Uint8Array())).toBe(true);
            expect(isBinary(new ArrayBuffer(0))).toBe(true);
        });

        it('returns false for non-binary types', () => {
            expect(isBinary('string')).toBe(false);
            expect(isBinary(123)).toBe(false);
            expect(isBinary({})).toBe(false);
            expect(isBinary(null)).toBe(false);
        });
    });
});
