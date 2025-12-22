export { C as ConnectionStatus, I as InitMessage, M as MessageHandler, N as NMeshedClient, a as NMeshedConfig, c as NMeshedMessage, O as Operation, b as OperationMessage, S as StatusHandler } from './client-D1LKSk-Q.mjs';

/**
 * Error types for nMeshed SDK.
 *
 * Using typed errors allows consumers to handle specific failure modes.
 */
/**
 * Base class for all nMeshed errors.
 */
declare class NMeshedError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
/**
 * Thrown when configuration is invalid.
 */
declare class ConfigurationError extends NMeshedError {
    constructor(message: string);
}
/**
 * Thrown when connection fails or times out.
 */
declare class ConnectionError extends NMeshedError {
    readonly cause?: Error | undefined;
    readonly isRetryable: boolean;
    constructor(message: string, cause?: Error | undefined, isRetryable?: boolean);
}
/**
 * Thrown when authentication fails.
 */
declare class AuthenticationError extends NMeshedError {
    constructor(message?: string);
}
/**
 * Thrown when a message fails to parse or validate.
 */
declare class MessageError extends NMeshedError {
    readonly rawMessage?: string | undefined;
    constructor(message: string, rawMessage?: string | undefined);
}
/**
 * Thrown when the operation queue exceeds capacity.
 */
declare class QueueOverflowError extends NMeshedError {
    constructor(maxSize: number);
}

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
declare function encodeValue(value: unknown): Uint8Array;
/**
 * Decodes binary bytes back to a JavaScript value.
 *
 * Attempts to parse as JSON first. If that fails, returns the raw string.
 * For pure binary data, use the raw Uint8Array directly.
 *
 * @param bytes - Binary data to decode
 * @returns Decoded JavaScript value
 */
declare function decodeValue(bytes: Uint8Array | ArrayBuffer): unknown;
/**
 * Type guard to check if a value is binary data.
 */
declare function isBinary(value: unknown): value is Uint8Array | ArrayBuffer;

/**
 * @file debug.ts
 * @brief Debug utilities for nMeshed SDK.
 *
 * Provides helper functions for debugging binary packets without
 * introducing JSON code paths into the production runtime.
 *
 * @example
 * ```typescript
 * import { debugPacket, hexDump } from 'nmeshed/debug';
 *
 * mesh.on('message', (peerId, data) => {
 *     if (DEBUG_MODE) {
 *         console.log(debugPacket(data));
 *     }
 * });
 * ```
 */
/**
 * Converts a binary packet to a human-readable debug representation.
 * This is for development/debugging only - not for production use.
 *
 * @param data - Binary packet data
 * @returns Human-readable string representation
 */
declare function debugPacket(data: ArrayBuffer | Uint8Array): string;
/**
 * Creates a hex dump of binary data (like xxd/hexdump).
 *
 * @param data - Binary data to dump
 * @param bytesPerLine - Bytes per line (default: 16)
 * @returns Formatted hex dump string
 */
declare function hexDump(data: ArrayBuffer | Uint8Array, bytesPerLine?: number): string;
/**
 * Attempts to decode binary data as JSON for debugging.
 * Returns null if the data is not valid JSON.
 *
 * WARNING: This allocates memory and should only be used for debugging.
 *
 * @param data - Binary data that might be JSON
 * @returns Parsed JSON object or null
 */
declare function tryParseAsJson(data: ArrayBuffer | Uint8Array): unknown | null;
/**
 * Measures the size of data and returns human-readable string.
 */
declare function formatBytes(bytes: number): string;
/**
 * Performance timer for measuring operation latency.
 *
 * @example
 * ```typescript
 * const timer = startTimer();
 * await someOperation();
 * console.log(`Took ${timer.elapsed()}ms`);
 * ```
 */
declare function startTimer(): {
    elapsed: () => number;
    elapsedMicros: () => number;
};

export { AuthenticationError, ConfigurationError, ConnectionError, MessageError, NMeshedError, QueueOverflowError, debugPacket, decodeValue, encodeValue, formatBytes, hexDump, isBinary, startTimer, tryParseAsJson };
