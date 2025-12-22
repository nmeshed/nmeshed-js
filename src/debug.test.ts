/**
 * @file debug.test.ts
 * @brief Tests for debug utilities.
 */

import { describe, it, expect } from 'vitest';
import { debugPacket, hexDump, tryParseAsJson, formatBytes, startTimer } from './debug';

describe('debugPacket', () => {
    it('returns descriptive string for empty packet', () => {
        const result = debugPacket(new Uint8Array(0));
        expect(result).toContain('Empty Packet');
    });

    it('includes header info for non-empty packet', () => {
        const data = new Uint8Array([0x10, 0x00, 0x00, 0x00, 0x41, 0x42, 0x43]);
        const result = debugPacket(data);
        expect(result).toContain('7 bytes');
        expect(result).toContain('Root Offset');
    });

    it('shows ASCII for readable bytes', () => {
        const data = new TextEncoder().encode('Hello World');
        const result = debugPacket(data);
        expect(result).toContain('Hello World');
    });
});

describe('hexDump', () => {
    it('returns "(empty)" for empty data', () => {
        expect(hexDump(new Uint8Array(0))).toBe('(empty)');
    });

    it('formats bytes with hex and ASCII', () => {
        const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
        const result = hexDump(data);
        expect(result).toContain('48 65 6c 6c 6f');
        expect(result).toContain('Hello');
    });

    it('replaces non-printable chars with dots', () => {
        const data = new Uint8Array([0x00, 0x01, 0x02, 0x41]); // non-printable + 'A'
        const result = hexDump(data);
        expect(result).toContain('...A');
    });
});

describe('tryParseAsJson', () => {
    it('parses valid JSON', () => {
        const json = JSON.stringify({ test: 123 });
        const bytes = new TextEncoder().encode(json);
        expect(tryParseAsJson(bytes)).toEqual({ test: 123 });
    });

    it('returns null for invalid JSON', () => {
        const bytes = new TextEncoder().encode('not json');
        expect(tryParseAsJson(bytes)).toBe(null);
    });

    it('returns null for binary data', () => {
        const bytes = new Uint8Array([0xFF, 0xFE, 0x00, 0x01]);
        expect(tryParseAsJson(bytes)).toBe(null);
    });
});

describe('formatBytes', () => {
    it('formats bytes correctly', () => {
        expect(formatBytes(100)).toBe('100 B');
        expect(formatBytes(1024)).toBe('1.00 KB');
        expect(formatBytes(2048)).toBe('2.00 KB');
        expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    });
});

describe('startTimer', () => {
    it('tracks elapsed time', async () => {
        const timer = startTimer();
        // Wait a tiny bit
        await new Promise(r => setTimeout(r, 5));
        const elapsed = timer.elapsed();
        expect(elapsed).toBeGreaterThan(0);
    });

    it('provides microsecond precision', () => {
        const timer = startTimer();
        const micros = timer.elapsedMicros();
        expect(micros).toBeGreaterThanOrEqual(0);
    });
});
