import { describe, it, expect } from 'vitest';
import { defineSchema, SchemaSerializer } from './SchemaBuilder';

describe('SchemaBuilder', () => {
    describe('defineSchema', () => {
        it('should return a schema object with encode/decode methods', () => {
            const schema = defineSchema({
                name: 'string',
                age: 'uint8'
            });
            expect(schema.definition).toBeDefined();
            expect(schema.encode).toBeDefined();
            expect(schema.decode).toBeDefined();
        });
    });

    describe('SchemaSerializer', () => {
        it('should encode and decode primitives correctly', () => {
            const schema = {
                name: 'string',
                active: 'boolean',
                score: 'uint32',
                balance: 'int32',
                ratio: 'float32',
                precise: 'float64',
                bigId: 'uint64',
                negativeBig: 'int64',
                byte: 'uint8'
            } as const;

            const data = {
                name: 'Test Player',
                active: true,
                score: 1000,
                balance: -500,
                ratio: 1.5,
                precise: 12345.6789,
                bigId: BigInt("9007199254740991"), // Max safe integer + more
                negativeBig: BigInt("-9007199254740991"),
                byte: 255
            };

            const encoded = SchemaSerializer.encode(schema, data);
            expect(encoded).toBeInstanceOf(Uint8Array);
            expect(encoded.byteLength).toBeGreaterThan(0);

            const decoded = SchemaSerializer.decode(schema, encoded);

            expect(decoded.name).toBe(data.name);
            expect(decoded.active).toBe(data.active);
            expect(decoded.score).toBe(data.score);
            expect(decoded.balance).toBe(data.balance);
            expect(decoded.ratio).toBeCloseTo(data.ratio);
            expect(decoded.precise).toBeCloseTo(data.precise);
            expect(decoded.bigId).toBe(data.bigId);
            expect(decoded.negativeBig).toBe(data.negativeBig);
            expect(decoded.byte).toBe(data.byte);
        });

        it('should handle arrays', () => {
            const schema = {
                tags: { type: 'array', itemType: 'string' } as const,
                scores: { type: 'array', itemType: 'uint16' } as const
            };

            const data = {
                tags: ['a', 'b', 'c'],
                scores: [10, 20, 65000]
            };

            const encoded = SchemaSerializer.encode(schema, data);
            const decoded = SchemaSerializer.decode(schema, encoded);

            expect(decoded.tags).toEqual(data.tags);
            expect(decoded.scores).toEqual(data.scores);
        });

        it('should handle nested objects', () => {
            const schema = {
                player: {
                    type: 'object',
                    schema: {
                        id: 'string',
                        stats: {
                            type: 'object',
                            schema: {
                                health: 'float32',
                                mana: 'float32'
                            }
                        }
                    }
                } as const
            };

            const data = {
                player: {
                    id: 'p1',
                    stats: {
                        health: 100.0,
                        mana: 50.5
                    }
                }
            };

            const encoded = SchemaSerializer.encode(schema, data);
            const decoded = SchemaSerializer.decode(schema, encoded);

            expect(decoded.player.id).toBe(data.player.id);
            expect(decoded.player.stats.health).toBe(data.player.stats.health);
        });

        it('should handle empty arrays', () => {
            const schema = { list: { type: 'array', itemType: 'string' } as const };
            const data = { list: [] };

            const encoded = SchemaSerializer.encode(schema, data);
            const decoded = SchemaSerializer.decode(schema, encoded);

            expect(decoded.list).toEqual([]);
        });

        it('should default primitives to zero/empty if missing', () => {
            const schema = { val: 'uint32' } as const;
            // @ts-ignore
            const encoded = SchemaSerializer.encode(schema, {});
            const decoded = SchemaSerializer.decode(schema, encoded);
            expect(decoded.val).toBe(0);
        });
    });
});
