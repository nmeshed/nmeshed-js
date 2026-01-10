
/**
 * @module Buffers
 * @description
 * Utilities for handling binary data across different JS environments (Browser/Node)
 * and memory backing types (ArrayBuffer vs SharedArrayBuffer).
 */

/**
 * Ensures a Uint8Array is backed by a standard ArrayBuffer (not SharedArrayBuffer).
 * Web Crypto API (subtle-crypto) often rejects SharedArrayBuffer-backed views.
 * 
 * @param data - The input view.
 * @returns A BufferSource guaranteed to be compatible with Web Crypto.
 */
export function toCryptoBuffer(data: Uint8Array): BufferSource {
    // 1. Check if the buffer is a SharedArrayBuffer (if the environment supports checking)
    // In strict TypeScript environments, `buffer` can be `ArrayBufferLike`.
    const buffer = data.buffer;

    // Use a robust check for SharedArrayBuffer
    // @ts-ignore - SharedArrayBuffer might not be defined in older environments/configs
    if (typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer) {
        // 2. Fundamental Fix: Copy to a standard ArrayBuffer.
        // We cannot simply "cast" a Shared buffer to a Standard one. 
        // We must allocate fresh private memory.
        const standard = new Uint8Array(data.length);
        standard.set(data);
        return standard;
    }

    // 3. For standard buffers, TypeScript's definition of BufferSource 
    // technically allows ArrayBufferView, which Uint8Array IS.
    // However, some TS configurations separate ArrayBufferLike from ArrayBuffer.
    // We use a specific, safe cast here because we have runtime-verified it is not Shared.
    return data as unknown as BufferSource;
}
