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

// Pre-allocated encoder/decoder for zero-GC in hot paths
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encodes a JavaScript value to binary bytes.
 *
 * - Uint8Array/ArrayBuffer: passed through (zero-copy)
 * - string: UTF-8 encoded
 * - number: Float64 (8 bytes, little-endian)
 * - boolean: single byte (0 or 1)
 * - object/array: JSON stringified then UTF-8 encoded
 *
 * @param value - Any JavaScript value to encode
 * @returns Binary representation
 */
export function encodeValue(value: unknown): Uint8Array {
    // Fast path: already binary
    if (value instanceof Uint8Array) {
        return value;
    }
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }

    // Primitive encodings
    if (typeof value === 'string') {
        return textEncoder.encode(value);
    }

    if (typeof value === 'number') {
        const buf = new ArrayBuffer(8);
        new DataView(buf).setFloat64(0, value, true);
        return new Uint8Array(buf);
    }

    if (typeof value === 'boolean') {
        return new Uint8Array([value ? 1 : 0]);
    }

    if (value === null || value === undefined) {
        return new Uint8Array(0);
    }

    // Complex types: JSON encode
    // This is the "convenience" path - users can avoid this by pre-encoding
    try {
        const json = JSON.stringify(value);
        return textEncoder.encode(json);
    } catch (error) {
        // Circular reference or other JSON error - throw with clear message
        throw new Error(`Cannot encode value: ${error instanceof Error ? error.message : 'JSON serialization failed'}`);
    }
}

/**
 * Decodes binary bytes back to a JavaScript value.
 *
 * Attempts to parse as JSON first. If that fails, returns the raw string.
 * For pure binary data, use the raw Uint8Array directly.
 *
 * @param bytes - Binary data to decode
 * @returns Decoded JavaScript value
 */
export function decodeValue(bytes: Uint8Array | ArrayBuffer): unknown {
    const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;

    if (data.length === 0) {
        return null;
    }

    // Try to decode as UTF-8 string
    try {
        const text = textDecoder.decode(data);

        // Try parsing as JSON
        try {
            return JSON.parse(text);
        } catch {
            // Not JSON, return as string
            return text;
        }
    } catch {
        // Not valid UTF-8, return raw bytes
        return data;
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
