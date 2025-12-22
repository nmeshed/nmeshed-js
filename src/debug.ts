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
export function debugPacket(data: ArrayBuffer | Uint8Array): string {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;

    if (bytes.length === 0) {
        return '[Empty Packet]';
    }

    const lines: string[] = [
        `[Packet: ${bytes.length} bytes]`,
        `  Header: ${hexDump(bytes.subarray(0, Math.min(16, bytes.length)))}`,
    ];

    // Try to detect packet type from first byte (Flatbuffers root offset)
    if (bytes.length >= 4) {
        const rootOffset = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
        lines.push(`  Root Offset: ${rootOffset}`);
    }

    // Show ASCII representation for readable portions
    const ascii = bytesToAscii(bytes.subarray(0, Math.min(64, bytes.length)));
    if (ascii.length > 0) {
        lines.push(`  ASCII: "${ascii}"`);
    }

    return lines.join('\n');
}

/**
 * Creates a hex dump of binary data (like xxd/hexdump).
 *
 * @param data - Binary data to dump
 * @param bytesPerLine - Bytes per line (default: 16)
 * @returns Formatted hex dump string
 */
export function hexDump(data: ArrayBuffer | Uint8Array, bytesPerLine: number = 16): string {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;

    if (bytes.length === 0) return '(empty)';

    const lines: string[] = [];
    for (let i = 0; i < bytes.length; i += bytesPerLine) {
        const slice = bytes.subarray(i, Math.min(i + bytesPerLine, bytes.length));
        const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = bytesToAscii(slice);
        const offset = i.toString(16).padStart(8, '0');
        lines.push(`${offset}  ${hex.padEnd(bytesPerLine * 3 - 1)}  |${ascii}|`);
    }

    return lines.join('\n');
}

/**
 * Converts bytes to ASCII, replacing non-printable characters with dots.
 */
function bytesToAscii(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.')
        .join('');
}

/**
 * Attempts to decode binary data as JSON for debugging.
 * Returns null if the data is not valid JSON.
 *
 * WARNING: This allocates memory and should only be used for debugging.
 *
 * @param data - Binary data that might be JSON
 * @returns Parsed JSON object or null
 */
export function tryParseAsJson(data: ArrayBuffer | Uint8Array): unknown | null {
    try {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        const text = new TextDecoder().decode(bytes);
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * Measures the size of data and returns human-readable string.
 */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

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
export function startTimer(): { elapsed: () => number; elapsedMicros: () => number } {
    const start = performance.now();
    return {
        elapsed: () => performance.now() - start,
        elapsedMicros: () => (performance.now() - start) * 1000,
    };
}
