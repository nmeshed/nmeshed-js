
/**
 * Supported primitive types.
 */
export type PrimitiveType = 'string' | 'float32' | 'float64' | 'int32' | 'int64' | 'uint64' | 'boolean' | 'uint8' | 'uint16' | 'uint32';

/**
 * A field definition in the schema.
 */
export type SchemaField =
    | PrimitiveType
    | { type: 'map'; schema: SchemaDefinition }
    | { type: 'array'; itemType: SchemaField }
    | { type: 'object'; schema: SchemaDefinition };

/**
 * The schema definition object.
 */
export interface SchemaDefinition {
    [key: string]: SchemaField;
}

/**
 * Result of defineSchema().
 * Provides type info and serialization methods.
 */
export interface Schema<T extends SchemaDefinition> {
    definition: T;
    encode: (data: any) => Uint8Array;
    decode: (buffer: Uint8Array) => any;
}

/**
 * Defines a schema for auto-serialization.
 * 
 * @param definition The schema definition
 * @returns An object with encode/decode methods
 * 
 * @example
 * ```ts
 * const PlayerSchema = defineSchema({
 *   x: 'float32',
 *   y: 'float32',
 *   name: 'string',
 *   inventory: { type: 'array', itemType: 'string' }
 * });
 * ```
 */
export function defineSchema<T extends SchemaDefinition>(definition: T): Schema<T> {
    return {
        definition,
        encode: (data: any) => SchemaSerializer.encode(definition, data),
        decode: (buffer: Uint8Array) => SchemaSerializer.decode(definition, buffer)
    };
}

/**
 * Internal Serializer Logic.
 * precise layout:
 * [Field Count: uint8]
 * [Field 1 ID: uint8] [Field 1 Size: varint (skip for fixed)] [Field 1 Data]
 * ...
 * 
 * Note: This is a simplified binary format. 
 * For 'object' types, we flatten or nest? 
 * Let's assume recursion.
 */
export class SchemaSerializer {
    private static textEncoder = new TextEncoder();
    private static textDecoder = new TextDecoder();

    static encode(schema: SchemaDefinition, data: any): Uint8Array {
        const parts: Uint8Array[] = [];
        let totalSize = 0;

        const keys = Object.keys(schema).sort(); // Deterministic order

        for (const key of keys) {
            const fieldType = schema[key];
            const value = data[key];
            const chunk = this.encodeValue(fieldType, value);
            parts.push(chunk);
            totalSize += chunk.byteLength;
        }

        const result = new Uint8Array(totalSize);
        let offset = 0;
        for (const part of parts) {
            result.set(part, offset);
            offset += part.byteLength;
        }
        return result;
    }

    static decode(schema: SchemaDefinition, buffer: Uint8Array): any {
        const result: any = {};
        const state = { offset: 0, buffer, view: new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength) };
        const keys = Object.keys(schema).sort();
        for (const key of keys) {
            result[key] = this.decodeField(schema[key], state);
        }
        return result;
    }

    static encodeValue(type: SchemaField, value: any): Uint8Array {
        return this.encodeField(type, value);
    }

    static decodeValue(type: SchemaField, buffer: Uint8Array): any {
        const state = { offset: 0, buffer, view: new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength) };
        return this.decodeField(type, state);
    }

    private static encodeField(type: SchemaField, value: any): Uint8Array {
        if (typeof type === 'string') {
            return this.encodePrimitive(type, value);
        }

        if (type.type === 'object') {
            return this.encode(type.schema, value);
        }

        if (type.type === 'array') {
            // [Count: uint16] [Item 1] [Item 2] ...
            if (!Array.isArray(value)) return new Uint8Array([0, 0]); // Count 0

            const itemType = type.itemType;
            const items = value.map(v => this.encodeField(itemType, v));

            let size = 2; // count header
            items.forEach(b => size += b.byteLength);

            const buf = new Uint8Array(size);
            const view = new DataView(buf.buffer);
            view.setUint16(0, value.length, true); // Little endian

            let offset = 2;
            for (const itemBuf of items) {
                buf.set(itemBuf, offset);
                offset += itemBuf.byteLength;
            }
            return buf;
        }

        if (type.type === 'map') {
            // Maps are serialized as arrays of Entries [Key, Value]
            // Not implemented for this MVP pass unless needed
            throw new Error("Map type not fully implemented in MVP Serializer");
        }

        return new Uint8Array(0);
    }

    private static decodeField(type: SchemaField, state: { offset: number, buffer: Uint8Array, view: DataView }): any {
        if (typeof type === 'string') {
            return this.decodePrimitive(type, state);
        }

        if (type.type === 'object') {
            return this.decodeStateful(type.schema, state);
        }

        if (type.type === 'array') {
            const count = state.view.getUint16(state.offset, true);
            state.offset += 2;
            const result = [];
            for (let i = 0; i < count; i++) {
                result.push(this.decodeField(type.itemType, state));
            }
            return result;
        }

        return null;
    }

    // --- Stateful Decode Helper for Object ---
    private static decodeStateful(schema: SchemaDefinition, state: { offset: number, buffer: Uint8Array, view: DataView }): any {
        const result: any = {};
        const keys = Object.keys(schema).sort();
        for (const key of keys) {
            result[key] = this.decodeField(schema[key], state);
        }
        return result;
    }

    // --- Primitives ---

    private static encodePrimitive(type: PrimitiveType, value: any): Uint8Array {
        switch (type) {
            case 'boolean': return new Uint8Array([value ? 1 : 0]);
            case 'uint8': return new Uint8Array([value & 0xFF]);
            case 'uint16': {
                const b = new Uint8Array(2);
                new DataView(b.buffer).setUint16(0, value || 0, true);
                return b;
            }

            case 'int32': {
                const b = new Uint8Array(4);
                new DataView(b.buffer).setInt32(0, value || 0, true);
                return b;
            }
            case 'uint32': {
                const b = new Uint8Array(4);
                new DataView(b.buffer).setUint32(0, value || 0, true);
                return b;
            }
            case 'float32': {
                const b = new Uint8Array(4);
                new DataView(b.buffer).setFloat32(0, value || 0, true);
                return b;
            }
            case 'float64': {
                const b = new Uint8Array(8);
                new DataView(b.buffer).setFloat64(0, value || 0, true);
                return b;
            }
            case 'int64': {
                const b = new Uint8Array(8);
                new DataView(b.buffer).setBigInt64(0, BigInt(value || 0), true);
                return b;
            }
            case 'uint64': {
                const b = new Uint8Array(8);
                new DataView(b.buffer).setBigUint64(0, BigInt(value || 0), true);
                return b;
            }
            case 'string': {
                const str = String(value || "");
                const bytes = this.textEncoder.encode(str);
                const len = bytes.length;
                // Varint length or uint16? Let's use uint16 for simplicity (max 64k strings)
                const header = new Uint8Array(2);
                new DataView(header.buffer).setUint16(0, len, true);
                const res = new Uint8Array(2 + len);
                res.set(header);
                res.set(bytes, 2);
                return res;
            }
            default: return new Uint8Array(0);
        }
    }

    private static decodePrimitive(type: PrimitiveType, state: { offset: number, view: DataView }): any {
        switch (type) {
            case 'boolean': {
                const val = state.view.getUint8(state.offset);
                state.offset += 1;
                return val !== 0;
            }
            case 'uint8': {
                const val = state.view.getUint8(state.offset);
                state.offset += 1;
                return val;
            }
            case 'uint16': {
                const val = state.view.getUint16(state.offset, true);
                state.offset += 2;
                return val;
            }
            case 'int32': {
                const val = state.view.getInt32(state.offset, true);
                state.offset += 4;
                return val;
            }
            case 'uint32': {
                const val = state.view.getUint32(state.offset, true);
                state.offset += 4;
                return val;
            }
            case 'float32': {
                const val = state.view.getFloat32(state.offset, true);
                state.offset += 4;
                return val;
            }
            case 'float64': {
                const val = state.view.getFloat64(state.offset, true);
                state.offset += 8;
                return val;
            }
            case 'int64': {
                const val = state.view.getBigInt64(state.offset, true);
                state.offset += 8;
                return val;
            }
            case 'uint64': {
                const val = state.view.getBigUint64(state.offset, true);
                state.offset += 8;
                return val;
            }
            case 'string': {
                const len = state.view.getUint16(state.offset, true);
                state.offset += 2;
                // Slice buffer for decoder
                // state.view.buffer is the whole arraybuffer.
                // We need strict slice.
                const bytes = new Uint8Array(state.view.buffer, state.view.byteOffset + state.offset, len);
                const str = this.textDecoder.decode(bytes);
                state.offset += len;
                return str;
            }
        }
    }
}
