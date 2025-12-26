/**
 * @file codec.ts
 * @brief Binary encoding/decoding utilities for nMeshed SDK.
 *
 * Provides efficient serialization methods for different value types.
 * The SDK now uses binary-only wire format, but values can be encoded
 * from various JavaScript types.
 *
 * @example
 * ```typescript
 * import { encodeValue, decodeValue } from 'nmeshed';
 *
 * // Encode a JS object to binary
 * const bytes = encodeValue({ x: 100, y: 200 });
 *
 * // Decode binary back to JS object
 * const obj = decodeValue(bytes);
 * ```
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Tag Types for FastBinaryCodec (FBC)
const TAG_NULL = 0;
const TAG_FALSE = 1;
const TAG_TRUE = 2;
const TAG_NUMBER = 3;
const TAG_STRING = 4;
const TAG_ARRAY = 5;
const TAG_OBJECT = 6;
const TAG_BYTES = 7;

const MAX_RECURSION_DEPTH = 32;

/**
 * Encodes a JavaScript value to binary bytes using FastBinaryCodec (FBC).
 */
export function encodeValue(value: unknown): Uint8Array {
    const writer = new BufferWriter();
    encodeRecursive(value, writer, 0);
    return writer.finish();
}

/**
 * Internal recursive encoder with depth tracking.
 */
function encodeRecursive(value: unknown, writer: BufferWriter, depth: number): void {
    if (depth > MAX_RECURSION_DEPTH) {
        throw new Error(`FBC: Max recursion depth (${MAX_RECURSION_DEPTH}) exceeded`);
    }

    if (value === null || value === undefined) {
        writer.writeByte(TAG_NULL);
        return;
    }

    if (typeof value === 'boolean') {
        writer.writeByte(value ? TAG_TRUE : TAG_FALSE);
        return;
    }

    if (typeof value === 'number') {
        writer.writeByte(TAG_NUMBER);
        writer.writeFloat64(value);
        return;
    }

    if (typeof value === 'string') {
        writer.writeByte(TAG_STRING);
        writer.writeString(value);
        return;
    }

    if (value instanceof Uint8Array) {
        writer.writeByte(TAG_BYTES);
        writer.writeBytes(value);
        return;
    }

    if (Array.isArray(value)) {
        writer.writeByte(TAG_ARRAY);
        writer.writeUint32(value.length);
        for (const item of value) {
            encodeRecursive(item, writer, depth + 1);
        }
        return;
    }

    if (typeof value === 'object') {
        const entries = Object.entries(value);
        writer.writeByte(TAG_OBJECT);
        writer.writeUint32(entries.length);
        for (const [k, v] of entries) {
            writer.writeUint16String(k);
            encodeRecursive(v, writer, depth + 1);
        }
        return;
    }

    throw new Error(`FBC cannot encode type: ${typeof value}`);
}

class BufferWriter {
    private buf: Uint8Array;
    private offset: number;
    private view: DataView;

    constructor(initialSize: number = 256) {
        this.buf = new Uint8Array(initialSize);
        this.offset = 0;
        this.view = new DataView(this.buf.buffer);
    }

    private ensure(bytes: number) {
        if (this.offset + bytes > this.buf.length) {
            const newBuf = new Uint8Array(Math.max(this.buf.length * 2, this.offset + bytes));
            newBuf.set(this.buf);
            this.buf = newBuf;
            this.view = new DataView(this.buf.buffer);
        }
    }

    writeByte(val: number) {
        this.ensure(1);
        this.buf[this.offset++] = val;
    }

    writeUint32(val: number) {
        this.ensure(4);
        this.view.setUint32(this.offset, val, true);
        this.offset += 4;
    }

    writeFloat64(val: number) {
        this.ensure(8);
        this.view.setFloat64(this.offset, val, true);
        this.offset += 8;
    }

    writeBytes(bytes: Uint8Array) {
        this.ensure(4 + bytes.length);
        this.writeUint32(bytes.length);
        this.buf.set(bytes, this.offset);
        this.offset += bytes.length;
    }

    writeString(str: string) {
        const bytes = textEncoder.encode(str);
        this.writeBytes(bytes);
    }

    writeUint16String(str: string) {
        const bytes = textEncoder.encode(str);
        this.ensure(2 + bytes.length);
        this.view.setUint16(this.offset, bytes.length, true);
        this.offset += 2;
        this.buf.set(bytes, this.offset);
        this.offset += bytes.length;
    }

    finish(): Uint8Array {
        return this.buf.slice(0, this.offset);
    }
}

/**
 * Decodes binary bytes back to a JavaScript value using FastBinaryCodec (FBC).
 */
export function decodeValue(bytes: Uint8Array | ArrayBuffer): unknown {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (data.length === 0) return null;

    const reader = new BufferReader(data);
    return decodeRecursive(reader, 0);
}

function decodeRecursive(reader: BufferReader, depth: number): unknown {
    if (depth > MAX_RECURSION_DEPTH) {
        throw new Error(`FBC: Max recursion depth (${MAX_RECURSION_DEPTH}) exceeded`);
    }

    const tag = reader.readByte();

    switch (tag) {
        case TAG_NULL: return null;
        case TAG_FALSE: return false;
        case TAG_TRUE: return true;
        case TAG_NUMBER: return reader.readFloat64();
        case TAG_STRING: return reader.readString();
        case TAG_BYTES: return reader.readBytes();
        case TAG_ARRAY: {
            const count = reader.readUint32();
            const res = new Array(count);
            for (let i = 0; i < count; i++) {
                res[i] = decodeRecursive(reader, depth + 1);
            }
            return res;
        }
        case TAG_OBJECT: {
            const count = reader.readUint32();
            const res: Record<string, any> = {};
            for (let i = 0; i < count; i++) {
                const k = reader.readUint16String();
                res[k] = decodeRecursive(reader, depth + 1);
            }
            return res;
        }
        default:
            throw new Error(`FBC unknown tag: ${tag} at offset ${reader.getOffset() - 1}`);
    }
}

class BufferReader {
    private offset: number = 0;
    private view: DataView;

    constructor(private buf: Uint8Array) {
        this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    }

    getOffset() { return this.offset; }

    readByte(): number {
        if (this.offset >= this.buf.length) throw new Error('FBC: Unexpected EOF');
        return this.buf[this.offset++];
    }

    readUint16(): number {
        if (this.offset + 2 > this.buf.length) throw new Error('FBC: Unexpected EOF');
        const val = this.view.getUint16(this.offset, true);
        this.offset += 2;
        return val;
    }

    readUint32(): number {
        if (this.offset + 4 > this.buf.length) throw new Error('FBC: Unexpected EOF');
        const val = this.view.getUint32(this.offset, true);
        this.offset += 4;
        return val;
    }

    readFloat64(): number {
        if (this.offset + 8 > this.buf.length) throw new Error('FBC: Unexpected EOF');
        const val = this.view.getFloat64(this.offset, true);
        this.offset += 8;
        return val;
    }

    readBytes(): Uint8Array {
        const len = this.readUint32();
        if (this.offset + len > this.buf.length) throw new Error('FBC: Unexpected EOF');
        const bytes = this.buf.subarray(this.offset, this.offset + len);
        this.offset += len;
        return new Uint8Array(bytes); // Return a copy if required, or subarray for zero-copy. Subarray is preferred for performance.
    }

    readString(): string {
        const len = this.readUint32();
        if (this.offset + len > this.buf.length) throw new Error('FBC: Unexpected EOF');
        const str = textDecoder.decode(this.buf.subarray(this.offset, this.offset + len));
        this.offset += len;
        return str;
    }

    readUint16String(): string {
        const len = this.readUint16();
        if (this.offset + len > this.buf.length) throw new Error('FBC: Unexpected EOF');
        const str = textDecoder.decode(this.buf.subarray(this.offset, this.offset + len));
        this.offset += len;
        return str;
    }
}

/**
 * Type guard to check if a value is binary data.
 */
export function isBinary(value: unknown): value is Uint8Array | ArrayBuffer {
    return value instanceof Uint8Array || value instanceof ArrayBuffer;
}

/**
 * Encodes a value for the binary wire protocol.
 * This is the internal encoder used by set() operations.
 *
 * @internal
 */
export function encodeForWire(value: unknown): Uint8Array {
    return encodeValue(value);
}

