
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
    encode: (data: InferObject<T>) => Uint8Array;
    decode: (buffer: Uint8Array) => InferObject<T>;
    defaultValue: (key: keyof T) => InferField<T[keyof T]>;
}

// ============================================================================
// Type Inference Utilities
// ============================================================================

/**
 * Maps primitive type strings to their TypeScript equivalents.
 */
type InferPrimitive<T extends PrimitiveType> =
    T extends 'string' ? string :
    T extends 'boolean' ? boolean :
    T extends 'float32' | 'float64' ? number :
    T extends 'int32' | 'int64' | 'uint32' | 'uint64' | 'uint8' | 'uint16' ? number :
    never;

/**
 * Recursively infers the TypeScript type for a schema field.
 */
type InferField<T extends SchemaField> =
    T extends PrimitiveType ? InferPrimitive<T> :
    T extends { type: 'array'; itemType: infer I extends SchemaField } ? InferField<I>[] :
    T extends { type: 'map'; schema: infer S extends SchemaDefinition } ? Record<string, InferObject<S>> :
    T extends { type: 'object'; schema: infer S extends SchemaDefinition } ? InferObject<S> :
    unknown;

/**
 * Infers the TypeScript type for a schema definition object.
 */
type InferObject<T extends SchemaDefinition> = {
    [K in keyof T]: InferField<T[K]>;
};

/**
 * Infers the TypeScript type from a Schema instance.
 * 
 * @example
 * ```ts
 * const TaskSchema = defineSchema({ id: 'string', done: 'boolean' });
 * type Task = InferSchema<typeof TaskSchema>;
 * // Task = { id: string; done: boolean; }
 * ```
 */
export type InferSchema<T extends Schema<any>> =
    T extends Schema<infer D> ? InferObject<D> : never;

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
        encode: (data: InferObject<T>) => SchemaSerializer.encode(definition, data),
        decode: (buffer: Uint8Array) => SchemaSerializer.decode(definition, buffer) as InferObject<T>,
        defaultValue: (key: keyof T) => SchemaSerializer.getDefaultValue(definition[key as string]) as any
    };
}

// ============================================================================
// Schema Registry
// ============================================================================

/**
 * Global registry for schemas to support "Invisible Schema Registration".
 */
export const SchemaRegistry = new Map<string, Schema<any>>();

/**
 * Registers a schema globally for a specific key pattern.
 */
export function registerGlobalSchema(keyPattern: string, schema: Schema<any>): void {
    SchemaRegistry.set(keyPattern, schema);
}

/**
 * Automatically find a schema for a key.
 */
export function findSchema(key: string): Schema<any> | undefined {
    // Exact match
    if (SchemaRegistry.has(key)) return SchemaRegistry.get(key);
    // Prefix match
    for (const [pattern, schema] of SchemaRegistry) {
        if (pattern !== '' && key.startsWith(pattern)) return schema;
    }
    return SchemaRegistry.get('');
}

/**
 * Internal Serializer Logic.
 */
export class SchemaSerializer {
    private static textEncoder = new TextEncoder();
    private static textDecoder = new TextDecoder();
    private static scratchBuffer = new Uint8Array(65536); // 64KB scratch

    static encode(schema: SchemaDefinition, data: any): Uint8Array {
        const keys = Object.keys(schema).sort();
        let offset = 0;

        for (const key of keys) {
            const fieldType = schema[key];
            const value = data[key];
            offset = this.encodeFieldInto(fieldType, value, this.scratchBuffer, offset);
        }

        return this.scratchBuffer.slice(0, offset);
    }

    private static encodeFieldInto(type: SchemaField, value: any, target: Uint8Array, offset: number): number {
        const view = new DataView(target.buffer, target.byteOffset);

        if (typeof type === 'string') {
            switch (type) {
                case 'boolean':
                    target[offset++] = value ? 1 : 0;
                    return offset;
                case 'uint8':
                    target[offset++] = value & 0xFF;
                    return offset;
                case 'uint16':
                    view.setUint16(offset, value || 0, true);
                    return offset + 2;
                case 'int32':
                    view.setInt32(offset, value || 0, true);
                    return offset + 4;
                case 'uint32':
                    view.setUint32(offset, value || 0, true);
                    return offset + 4;
                case 'float32':
                    view.setFloat32(offset, value || 0, true);
                    return offset + 4;
                case 'float64':
                    view.setFloat64(offset, value || 0, true);
                    return offset + 8;
                case 'int64':
                    view.setBigInt64(offset, BigInt(value || 0), true);
                    return offset + 8;
                case 'uint64':
                    view.setBigUint64(offset, BigInt(value || 0), true);
                    return offset + 8;
                case 'string': {
                    const str = String(value || "");
                    const { written } = this.textEncoder.encodeInto(str, target.subarray(offset + 2));
                    view.setUint16(offset, written, true);
                    return offset + 2 + written;
                }
            }
        }

        if (type.type === 'object') {
            const keys = Object.keys(type.schema).sort();
            for (const key of keys) {
                offset = this.encodeFieldInto(type.schema[key], value[key], target, offset);
            }
            return offset;
        }

        if (type.type === 'array') {
            const arr = value as any[];
            view.setUint16(offset, arr ? arr.length : 0, true);
            offset += 2;
            if (arr) {
                for (const item of arr) {
                    offset = this.encodeFieldInto(type.itemType, item, target, offset);
                }
            }
            return offset;
        }

        if (type.type === 'map') {
            const entries = value instanceof Map ? Array.from(value.entries()) : Object.entries(value || {});
            view.setUint16(offset, entries.length, true);
            offset += 2;
            for (const [k, v] of entries) {
                // Encode key (string)
                offset = this.encodeFieldInto('string', String(k), target, offset);
                // Encode value (object schema)
                const subKeys = Object.keys(type.schema).sort();
                for (const skey of subKeys) {
                    offset = this.encodeFieldInto(type.schema[skey], (v as any)[skey], target, offset);
                }
            }
            return offset;
        }

        return offset;
    }

    static decode(schema: SchemaDefinition, buffer: Uint8Array): any {
        if (!buffer || buffer.byteLength === 0) {
            // Return empty object with defaults for empty buffer
            const result: any = {};
            for (const key of Object.keys(schema).sort()) {
                result[key] = this.getDefaultValue(schema[key]);
            }
            return result;
        }

        const result: any = {};
        const state = { offset: 0, buffer, view: new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength) };
        const keys = Object.keys(schema).sort();
        for (const key of keys) {
            try {
                result[key] = this.decodeField(schema[key], state);
            } catch (e) {
                // If decoding fails, set to default and continue
                result[key] = this.getDefaultValue(schema[key]);
            }
        }
        return result;
    }

    static encodeValue(type: SchemaField, value: any): Uint8Array {
        return this.encodeField(type, value);
    }

    static decodeValue(type: SchemaField, buffer: Uint8Array): any {
        if (!buffer || buffer.byteLength === 0) {
            return this.getDefaultValue(type);
        }
        const state = { offset: 0, buffer, view: new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength) };
        return this.decodeField(type, state);
    }

    /**
     * Returns sensible defaults for each type to avoid runtime errors.
     */
    public static getDefaultValue(type: SchemaField): any {
        if (typeof type === 'string') {
            switch (type) {
                case 'string': return '';
                case 'boolean': return false;
                case 'float32': case 'float64': return 0.0;
                default: return 0; // All numeric types
            }
        }
        switch (type.type) {
            case 'array': return [];
            case 'map': return {};
            case 'object': return {};
            default: return null;
        }
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
            // Maps are serialized as arrays of [Key, Value] entries.
            // Format: [Count: uint16] [Key1] [Value1] [Key2] [Value2] ...
            // Keys are always strings for simplicity.
            if (!value || typeof value !== 'object') return new Uint8Array([0, 0]); // Count 0

            const entries = value instanceof Map
                ? Array.from(value.entries())
                : Object.entries(value);

            const itemParts: Uint8Array[] = [];
            let itemsSize = 0;

            for (const [k, v] of entries) {
                // Encode key as string
                const keyBytes = this.encodePrimitive('string', String(k));
                // Encode value using the schema's value type
                const valueBytes = this.encode(type.schema, v);

                itemParts.push(keyBytes);
                itemParts.push(valueBytes);
                itemsSize += keyBytes.byteLength + valueBytes.byteLength;
            }

            const buf = new Uint8Array(2 + itemsSize);
            const view = new DataView(buf.buffer);
            view.setUint16(0, entries.length, true); // Entry count

            let offset = 2;
            for (const part of itemParts) {
                buf.set(part, offset);
                offset += part.byteLength;
            }
            return buf;
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

        if (type.type === 'map') {
            // Maps are decoded from [Count: uint16] [Key1] [Value1] [Key2] [Value2] ...
            const count = state.view.getUint16(state.offset, true);
            state.offset += 2;
            const result: Record<string, any> = {};
            for (let i = 0; i < count; i++) {
                // Decode key (always string)
                const key = this.decodePrimitive('string', state);
                // Decode value using the schema's value type
                const value = this.decodeStateful(type.schema, state);
                result[key] = value;
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
