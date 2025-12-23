/**
 * Binary Protocol Packer (v1)
 * Match spec in internal-docs/binary_spec.md
 */

import { Operation } from '../types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Constants
export const MSG_TYPE_OP = 0x01;
export const MSG_TYPE_EPHEMERAL = 0x02;
export const MSG_TYPE_CURSOR = 0x03; // Legacy/Cursor specific

/**
 * Encodes an Operation into the custom binary format.
 * Format:
 * [1 byte]  MsgType (0x01)
 * [16 bytes] WorkspaceUUID (Binary)
 * [1 byte]   Key Length (K)
 * [K bytes]  Key String (UTF-8)
 * [8 bytes]  Timestamp (int64, Unix Micro)
 * [4 bytes]  Value Length (V)
 * [V bytes]  Value (JSON/Bytes)
 */
export function marshalOp(workspaceId: string, op: Operation): ArrayBuffer {
    const keyBytes = encoder.encode(op.key);

    // Value handling: If it's already Uint8Array, use it. Else JSON stringify.
    let valBytes: Uint8Array;
    if (op.value instanceof Uint8Array) {
        valBytes = op.value;
    } else {
        const jsonStr = JSON.stringify(op.value);
        valBytes = encoder.encode(jsonStr);
    }

    // UUID Handling: Need to parse 36-char string to 16-byte array
    const uuidBytes = parseUUID(workspaceId);

    // Calculate Size
    // 1 (Type) + 16 (UUID) + 4 (KeyLen) + KeyBytes + 8 (Timestamp) + 4 (ValLen) + ValBytes
    const size = 1 + 16 + 4 + keyBytes.length + 8 + 4 + valBytes.length;
    const buffer = new ArrayBuffer(size);
    const view = new DataView(buffer);
    const byteView = new Uint8Array(buffer);

    let offset = 0;

    // MsgType
    view.setUint8(offset++, MSG_TYPE_OP);

    // WorkspaceID (16 bytes)
    byteView.set(uuidBytes, offset);
    offset += 16;

    // Key Length (4 bytes, Little Endian)
    view.setUint32(offset, keyBytes.length, true);
    offset += 4;

    // Key
    byteView.set(keyBytes, offset);
    offset += keyBytes.length;

    // Timestamp (8 bytes, Little Endian)
    // Javascript numbers are doubles (53 bit integer precision).
    // UnixMicro might exceed 53 bits (2^53 is ~9007 trillion, today is ~1.7 billion * 1e6 = 1.7e15. 2^53 is 9e15. Safe.)
    // We can use BigInt for safety.
    view.setBigInt64(offset, BigInt(op.timestamp), true);
    offset += 8;

    // Value Length (4 bytes, Little Endian)
    view.setUint32(offset, valBytes.length, true);
    offset += 4;

    // Value
    byteView.set(valBytes, offset);
    offset += valBytes.length;

    return buffer;
}

/**
 * Unmarshals a binary buffer into an Operation.
 * Returns the value as a raw Uint8Array. The caller is responsible for processing/parsing the value.
 */
export function unmarshalOp(buffer: ArrayBuffer): { workspaceId: string, op: Operation } | null {
    const view = new DataView(buffer);
    const byteView = new Uint8Array(buffer);
    if (byteView.length < 1) return null;

    let offset = 0;

    const type = view.getUint8(offset++);
    if (type !== MSG_TYPE_OP) return null;

    // WorkspaceID
    if (offset + 16 > byteView.length) return null;
    const uuidBytes = byteView.subarray(offset, offset + 16);
    const workspaceId = stringifyUUID(uuidBytes);
    offset += 16;

    // Key Length
    if (offset + 4 > byteView.length) return null;
    const keyLen = view.getUint32(offset, true);
    offset += 4;

    // Key
    if (offset + keyLen > byteView.length) return null;
    const keyBytes = byteView.subarray(offset, offset + keyLen);
    const key = decoder.decode(keyBytes);
    offset += keyLen;

    // Timestamp
    if (offset + 8 > byteView.length) return null;
    const timestamp = Number(view.getBigInt64(offset, true));
    offset += 8;

    // Value Length
    if (offset + 4 > byteView.length) return null;
    const valLen = view.getUint32(offset, true);
    offset += 4;

    // Value
    if (offset + valLen > byteView.length) return null;
    // Copy the subarray to ensure data safety (avoid buffer reuse issues)
    const valBytes = new Uint8Array(byteView.subarray(offset, offset + valLen));
    offset += valLen;

    return {
        workspaceId,
        op: {
            key,
            value: valBytes, // STRICT: Always return bytes
            timestamp
        }
    };
}


// --- Legacy Cursor Helpers (Restored) ---

/**
 * @deprecated Use CursorManager or MeshClient.sendCursor() for real-time cursors.
 */
export function packCursor(userId: string, x: number, y: number): ArrayBuffer {
    const userIdBytes = new TextEncoder().encode(userId);
    // Op(1) + X(2) + Y(2) + ID_Len(1) + ID(N)
    const buffer = new ArrayBuffer(1 + 2 + 2 + 1 + userIdBytes.length);
    const view = new DataView(buffer);

    let offset = 0;

    view.setUint8(offset++, MSG_TYPE_CURSOR);

    // Coordinates (Clamped to Uint16 range 0-65535)
    view.setUint16(offset, Math.max(0, Math.min(65535, x)), false); // Big Endian
    offset += 2;

    view.setUint16(offset, Math.max(0, Math.min(65535, y)), false);
    offset += 2;

    view.setUint8(offset++, userIdBytes.length);
    new Uint8Array(buffer).set(userIdBytes, offset);

    return buffer;
}

/**
 * @deprecated Use CursorManager or useCursor() for real-time cursors.
 */
export function unpackCursor(buffer: ArrayBuffer): { x: number, y: number, userId: string } | null {
    const view = new DataView(buffer);
    if (view.byteLength < 6) return null;

    let offset = 0;
    const op = view.getUint8(offset++);

    if (op !== MSG_TYPE_CURSOR) return null;

    const x = view.getUint16(offset, false);
    offset += 2;

    const y = view.getUint16(offset, false);
    offset += 2;

    const idLen = view.getUint8(offset++);
    const idBytes = new Uint8Array(buffer, offset, idLen);
    const userId = new TextDecoder().decode(idBytes);

    return { x, y, userId };
}

/**
 * @deprecated Cursors are now handled via JSON ephemeral messages.
 */
export function isBinaryCursor(data: unknown): boolean {
    if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) return false;
    // Check first byte
    const view = new DataView(data instanceof Uint8Array ? data.buffer : data);
    return view.byteLength > 0 && view.getUint8(0) === MSG_TYPE_CURSOR;
}


// Helpers

function parseUUID(uuid: string): Uint8Array {
    const hex = uuid.replace(/-/g, '');
    const arr = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        arr[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return arr;
}

function stringifyUUID(bytes: Uint8Array): string {
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return [
        hex.substr(0, 8),
        hex.substr(8, 4),
        hex.substr(12, 4),
        hex.substr(16, 4),
        hex.substr(20, 12)
    ].join('-');
}
