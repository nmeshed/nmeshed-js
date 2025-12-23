/**
 * @file PacketPool.ts
 * @brief Zero-allocation Flatbuffer builder pool for high-performance networking.
 *
 * PacketPool manages a ring buffer of Flatbuffer builders to enable zero-GC
 * serialization in game loops and real-time applications. The pool pattern
 * prevents common "forgotten builder.clear()" bugs and reduces memory pressure.
 *
 * @example
 * ```typescript
 * import { PacketPool } from 'nmeshed';
 *
 * const pool = new PacketPool({ builderSize: 4096, poolSize: 8 });
 *
 * const bytes = pool.withBuilder((builder) => {
 *     // Use builder to create Flatbuffer...
 *     MyTable.startMyTable(builder);
 *     // ...
 *     builder.finish(offset);
 *     return builder.asUint8Array();
 * });
 * ```
 */

import * as flatbuffers from 'flatbuffers';

/**
 * Configuration for PacketPool.
 */
export interface PacketPoolConfig {
    /**
     * Initial capacity of each builder in bytes.
     * @default 4096
     */
    builderSize?: number;

    /**
     * Number of builders in the ring buffer.
     * Higher = more concurrent serialization, but more memory.
     * @default 8
     */
    poolSize?: number;
}

/**
 * Zero-allocation Flatbuffer builder pool.
 *
 * Uses a ring buffer to provide clean builders without allocation.
 * Each call to `withBuilder()` advances the ring index and clears the builder.
 *
 * **Important**: The returned Uint8Array is valid until the ring wraps
 * (poolSize calls later). Do not hold long-term references to the bytes.
 *
 * @example
 * ```typescript
 * const pool = new PacketPool({ builderSize: 4096, poolSize: 8 });
 *
 * // Zero-copy serialization
 * const bytes = pool.withBuilder((builder) => {
 *     const nameOffset = builder.createString('test');
 *     MyTable.startMyTable(builder);
 *     MyTable.addName(builder, nameOffset);
 *     const root = MyTable.endMyTable(builder);
 *     builder.finish(root);
 *     return builder.asUint8Array();
 * });
 *
 * // If you need to keep the bytes, copy them:
 * const safeCopy = bytes.slice();
 * ```
 */
export class PacketPool {
    private readonly builders: flatbuffers.Builder[];
    private readonly poolSize: number;
    private ringIndex: number = 0;

    constructor(config: PacketPoolConfig = {}) {
        const builderSize = config.builderSize ?? 4096;
        this.poolSize = config.poolSize ?? 8;

        if (this.poolSize < 1) {
            throw new Error('PacketPool: poolSize must be at least 1');
        }

        this.builders = new Array(this.poolSize)
            .fill(null)
            .map(() => new flatbuffers.Builder(builderSize));
    }

    /**
     * Executes a callback with a clean builder from the pool.
     *
     * The builder is automatically cleared before use. The callback should
     * build the Flatbuffer and return the serialized bytes.
     *
     * @param callback - Function that builds and returns serialized bytes
     * @returns The Uint8Array returned by the callback
     *
     * @example
     * ```typescript
     * const bytes = pool.withBuilder((builder) => {
     *     // Build your flatbuffer...
     *     builder.finish(root);
     *     return builder.asUint8Array();
     * });
     * ```
     */
    public withBuilder<T = Uint8Array>(callback: (builder: flatbuffers.Builder) => T): T {
        // Advance ring index
        this.ringIndex = (this.ringIndex + 1) % this.poolSize;

        // Acquire and clear builder
        const builder = this.builders[this.ringIndex];
        builder.clear();

        // Execute callback
        return callback(builder);
    }

    /**
     * Returns the current pool size.
     */
    public get size(): number {
        return this.poolSize;
    }

    /**
     * Creates a shared singleton instance with default configuration.
     * Useful for applications that only need one pool.
     */
    private static _shared: PacketPool | null = null;

    public static get shared(): PacketPool {
        if (!PacketPool._shared) {
            PacketPool._shared = new PacketPool();
        }
        return PacketPool._shared;
    }

    /**
     * Resets the shared singleton (for testing).
     */
    public static resetShared(): void {
        PacketPool._shared = null;
    }
}
