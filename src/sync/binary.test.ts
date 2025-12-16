
import { describe, it, expect } from 'vitest';
import { marshalOp, unmarshalOp } from './binary';
import { Operation } from '../types';

describe('Binary Protocol Packer', () => {
    it('should round-trip an operation correctly', () => {
        const workspaceId = '12345678-1234-1234-1234-123456789abc';
        const op: Operation = {
            key: 'test-key',
            value: { foo: 'bar', count: 42 },
            timestamp: 1627889123000000 // Microseconds
        };

        // Pack
        const buffer = marshalOp(workspaceId, op);
        expect(buffer.byteLength).toBeGreaterThan(0);

        // Unpack
        const result = unmarshalOp(buffer);
        expect(result).not.toBeNull();
        expect(result?.workspaceId).toBe(workspaceId);
        expect(result?.op.key).toBe(op.key);
        expect(result?.op.timestamp).toBe(op.timestamp);
        // Note: unmarshalOp now returns raw bytes. We must decode manually in tests if we want to check logic.
        const decodedValue = JSON.parse(new TextDecoder().decode(result?.op.value as Uint8Array));
        expect(decodedValue).toEqual(op.value);
    });

    it('should handle Uint8Array values (opaque bytes)', () => {
        const workspaceId = 'aabbccdd-1122-3344-5566-77889900aabb';
        const rawBytes = new Uint8Array([1, 2, 3, 4, 255]);
        const op: Operation = {
            key: 'binary-key',
            value: rawBytes,
            timestamp: 1000
        };

        const buffer = marshalOp(workspaceId, op);
        const result = unmarshalOp(buffer);

        // Should return raw bytes strictly
        expect(result?.op.value).toBeInstanceOf(Uint8Array);
        expect(result?.op.value).toEqual(rawBytes);
    });

    it('should NOT strictly cast ambiguous binaries to JSON numbers automatically', () => {
        // The "Magic 12" test
        const workspaceId = 'aabbccdd-1122-3344-5566-77889900aabb';
        const ambiguousBytes = new Uint8Array([0x31, 0x32]); // "12"
        const op: Operation = {
            key: 'ambiguous',
            value: ambiguousBytes,
            timestamp: 1000
        };

        const buffer = marshalOp(workspaceId, op);
        const result = unmarshalOp(buffer);

        // Strict behavior: It remains bytes.
        expect(result?.op.value).toBeInstanceOf(Uint8Array);
        expect(result?.op.value).toEqual(ambiguousBytes);
    });
});
