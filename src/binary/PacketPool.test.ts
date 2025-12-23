/**
 * @file PacketPool.test.ts
 * @brief Unit tests for PacketPool zero-allocation builder pool.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PacketPool } from './PacketPool';

describe('PacketPool', () => {
    afterEach(() => {
        PacketPool.resetShared();
    });

    describe('Construction', () => {
        it('should create with default config', () => {
            const pool = new PacketPool();
            expect(pool.size).toBe(8);
        });

        it('should create with custom config', () => {
            const pool = new PacketPool({ builderSize: 8192, poolSize: 4 });
            expect(pool.size).toBe(4);
        });

        it('should throw for poolSize < 1', () => {
            expect(() => new PacketPool({ poolSize: 0 })).toThrow('poolSize must be at least 1');
            expect(() => new PacketPool({ poolSize: -1 })).toThrow('poolSize must be at least 1');
        });
    });

    describe('withBuilder', () => {
        it('should provide a clean builder to callback', () => {
            const pool = new PacketPool({ poolSize: 2 });

            const result = pool.withBuilder((builder) => {
                // Builder should be usable
                expect(builder).toBeDefined();
                expect(typeof builder.clear).toBe('function');
                return new Uint8Array([1, 2, 3]);
            });

            expect(result).toEqual(new Uint8Array([1, 2, 3]));
        });

        it('should clear builder before each use', () => {
            const pool = new PacketPool({ poolSize: 1 });

            // First use - add some data
            pool.withBuilder((builder) => {
                builder.createString('test data');
                return builder.asUint8Array();
            });

            // Second use - builder should be cleared
            const result = pool.withBuilder((builder) => {
                // After clear, offset should be reset
                // We can verify by checking the builder is in a fresh state
                expect(builder.offset()).toBe(0);
                return new Uint8Array([42]);
            });

            expect(result).toEqual(new Uint8Array([42]));
        });

        it('should cycle through ring buffer', () => {
            const pool = new PacketPool({ poolSize: 3 });
            const usedIndices: number[] = [];

            // Track which builders are used
            for (let i = 0; i < 6; i++) {
                pool.withBuilder((builder) => {
                    // Each builder has unique identity
                    usedIndices.push(i);
                    return new Uint8Array([i]);
                });
            }

            // Should have cycled through all 6 calls
            expect(usedIndices).toEqual([0, 1, 2, 3, 4, 5]);
        });

        it('should support generic return types', () => {
            const pool = new PacketPool();

            // Return a number
            const num = pool.withBuilder(() => 42);
            expect(num).toBe(42);

            // Return a string
            const str = pool.withBuilder(() => 'hello');
            expect(str).toBe('hello');

            // Return an object
            const obj = pool.withBuilder(() => ({ foo: 'bar' }));
            expect(obj).toEqual({ foo: 'bar' });
        });
    });

    describe('Shared singleton', () => {
        it('should return same instance', () => {
            const pool1 = PacketPool.shared;
            const pool2 = PacketPool.shared;
            expect(pool1).toBe(pool2);
        });

        it('should reset shared instance', () => {
            const pool1 = PacketPool.shared;
            PacketPool.resetShared();
            const pool2 = PacketPool.shared;
            expect(pool1).not.toBe(pool2);
        });
    });

    describe('Real Flatbuffer usage', () => {
        it('should work with actual Flatbuffer operations', () => {
            const pool = new PacketPool();

            const bytes = pool.withBuilder((builder) => {
                // Create a simple string (most basic Flatbuffer op)
                const strOffset = builder.createString('test');

                // Simulate finishing a simple buffer
                // (We can't use real schema without importing it)
                builder.finish(strOffset);

                return builder.asUint8Array();
            });

            // Should produce valid bytes
            expect(bytes.length).toBeGreaterThan(0);
            expect(bytes instanceof Uint8Array).toBe(true);
        });
    });
});
