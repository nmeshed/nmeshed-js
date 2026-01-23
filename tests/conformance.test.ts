import { describe, it, expect } from 'vitest';
import { decodeMessage, MsgType } from '../src/protocol';
import * as fs from 'fs';
import * as path from 'path';

const VECTORS_DIR = path.resolve(__dirname, '../../../platform/core/tests/conformance/vectors');

function readVector(filename: string): Uint8Array {
    return new Uint8Array(fs.readFileSync(path.join(VECTORS_DIR, filename)));
}

describe('Protocol Conformance', () => {
    it('should decode op_basic.bin correctly', () => {
        const data = readVector('op_basic.bin');
        const msg = decodeMessage(data);

        expect(msg).not.toBeNull();
        expect(msg?.type).toBe(MsgType.Op);
        expect(msg?.key).toBe('conformance-key');
        expect(msg?.payload).toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(msg?.actorId).toBe('actor-rust');

        // HLC: 1000n
        expect(msg?.timestamp).toBe(1000n);
        expect(msg?.serverTime).toBeCloseTo(123456.0);
    });

    it('should decode op_bigint.bin correctly', () => {
        const data = readVector('op_bigint.bin');
        const msg = decodeMessage(data);

        expect(msg).not.toBeNull();
        expect(msg?.type).toBe(MsgType.Op);
        expect(msg?.key).toBe('bigint-key');
        expect(new TextDecoder().decode(msg?.payload)).toBe('big-time');

        // HLC: 1767225600000n
        expect(msg?.timestamp).toBe(1767225600000n);
    });
});
