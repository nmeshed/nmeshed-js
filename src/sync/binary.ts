/**
 * Zero-Overhead Binary Protocol
 * 
 * "JSON is for config files, not wire protocols."
 * 
 * Schema (Cursor Update):
 * [0:1]   OpCode (0x01 = Cursor)
 * [1:9]   Timestamp (Double - 64 bit) - for interpolation
 * [9:13]  X (Uint16) - 0-65535 normalized coordinates or screen space? 
 *         Screen space is risky for resizing. Normalized (0-1) * 65535 is safer for responsive design.
 *         Let's stick to Float32 (4 bytes) for generic coordinates to avoid casting issues for now, or Int16 if we want extreme compression.
 *         Let's use Int16 for screen space (Screen pixels usually < 32k).
 * [13:17] Y (Uint16)
 * [17:N]  UserId (String - Length Prefixed or Null Terminated? Length byte is safer).
 */

const OP_CURSOR = 0x01;

export function packCursor(userId: string, x: number, y: number): ArrayBuffer {
    const userIdBytes = new TextEncoder().encode(userId);
    // Op(1) + X(2) + Y(2) + ID_Len(1) + ID(N)
    const buffer = new ArrayBuffer(1 + 2 + 2 + 1 + userIdBytes.length);
    const view = new DataView(buffer);

    let offset = 0;

    // OpCode
    view.setUint8(offset++, OP_CURSOR);

    // Coordinates (Clamped to Uint16 range 0-65535)
    // We assume pixels, if negative or > 65k, we clamp.
    view.setUint16(offset, Math.max(0, Math.min(65535, x)), false); // Big Endian
    offset += 2;

    view.setUint16(offset, Math.max(0, Math.min(65535, y)), false);
    offset += 2;

    // UserId Length
    view.setUint8(offset++, userIdBytes.length);

    // UserId Body
    new Uint8Array(buffer).set(userIdBytes, offset);

    return buffer;
}

export function unpackCursor(buffer: ArrayBuffer): { x: number, y: number, userId: string } | null {
    const view = new DataView(buffer);
    if (view.byteLength < 6) return null; // Min size

    let offset = 0;
    const op = view.getUint8(offset++);

    if (op !== OP_CURSOR) return null;

    const x = view.getUint16(offset, false);
    offset += 2;

    const y = view.getUint16(offset, false);
    offset += 2;

    const idLen = view.getUint8(offset++);
    const idBytes = new Uint8Array(buffer, offset, idLen);
    const userId = new TextDecoder().decode(idBytes);

    return { x, y, userId };
}

export function isBinaryCursor(data: unknown): boolean {
    return data instanceof ArrayBuffer || data instanceof Uint8Array;
}
