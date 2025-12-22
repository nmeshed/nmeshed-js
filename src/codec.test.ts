/**
 * @file codec.test.ts
 * @brief Tests for binary encoding/decoding utilities.
 */

import { describe, it, expect } from 'vitest';
import { encodeValue, decodeValue, isBinary } from './codec';

describe('encodeValue', () => {
    it('passes through Uint8Array unchanged', () => {
        const input = new Uint8Array([1, 2, 3, 4, 5]);
        const result = encodeValue(input);
        expect(result).toBe(input);
    });

    it('converts ArrayBuffer to Uint8Array', () => {
        const buffer = new ArrayBuffer(4);
        new Uint8Array(buffer).set([10, 20, 30, 40]);
        const result = encodeValue(buffer);
        expect(result).toBeInstanceOf(Uint8Array);
        expect(Array.from(result)).toEqual([10, 20, 30, 40]);
    });

    it('encodes strings as UTF-8', () => {
        const result = encodeValue('Hello');
        expect(result).toHaveProperty('byteLength');
        expect(new TextDecoder().decode(result)).toBe('Hello');
    });

    it('encodes numbers as Float64', () => {
        const result = encodeValue(3.14159);
        expect(result.byteLength).toBe(8);
        const decoded = new DataView(result.buffer, result.byteOffset).getFloat64(0, true);
        expect(decoded).toBeCloseTo(3.14159);
    });

    it('encodes booleans as single byte', () => {
        expect(Array.from(encodeValue(true))).toEqual([1]);
        expect(Array.from(encodeValue(false))).toEqual([0]);
    });

    it('encodes null and undefined as empty array', () => {
        expect(encodeValue(null).length).toBe(0);
        expect(encodeValue(undefined).length).toBe(0);
    });

    it('encodes objects as JSON', () => {
        const obj = { x: 100, y: 200, name: 'test' };
        const result = encodeValue(obj);
        const decoded = JSON.parse(new TextDecoder().decode(result));
        expect(decoded).toEqual(obj);
    });

    it('encodes arrays as JSON', () => {
        const arr = [1, 2, 3, 'four', { five: 5 }];
        const result = encodeValue(arr);
        const decoded = JSON.parse(new TextDecoder().decode(result));
        expect(decoded).toEqual(arr);
    });

    it('throws on circular references', () => {
        const circular: any = { a: 1 };
        circular.self = circular;
        expect(() => encodeValue(circular)).toThrow('Cannot encode value');
    });
});

describe('decodeValue', () => {
    it('returns null for empty array', () => {
        expect(decodeValue(new Uint8Array(0))).toBe(null);
    });

    it('parses JSON objects', () => {
        const json = JSON.stringify({ x: 1, y: 2 });
        const bytes = new TextEncoder().encode(json);
        expect(decodeValue(bytes)).toEqual({ x: 1, y: 2 });
    });

    it('parses JSON arrays', () => {
        const json = JSON.stringify([1, 2, 3]);
        const bytes = new TextEncoder().encode(json);
        expect(decodeValue(bytes)).toEqual([1, 2, 3]);
    });

    it('returns string for non-JSON text', () => {
        const text = 'Hello, World!';
        const bytes = new TextEncoder().encode(text);
        expect(decodeValue(bytes)).toBe(text);
    });

    it('handles ArrayBuffer input', () => {
        const json = JSON.stringify({ test: true });
        const buffer = new TextEncoder().encode(json).buffer;
        expect(decodeValue(buffer)).toEqual({ test: true });
    });
});

describe('isBinary', () => {
    it('returns true for Uint8Array', () => {
        expect(isBinary(new Uint8Array())).toBe(true);
    });

    it('returns true for ArrayBuffer', () => {
        expect(isBinary(new ArrayBuffer(0))).toBe(true);
    });

    it('returns false for other types', () => {
        expect(isBinary('string')).toBe(false);
        expect(isBinary(123)).toBe(false);
        expect(isBinary({})).toBe(false);
        expect(isBinary(null)).toBe(false);
        expect(isBinary(undefined)).toBe(false);
    });
});
