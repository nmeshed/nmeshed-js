/**
 * @module HLC
 * @description
 * Hybrid Logical Clock (HLC) implementation for nMeshed.
 * 
 * Provides a monotonic 53-bit timestamp safe for JavaScript `number` (Float64).
 * Logic: `(physical_ms * 4096) + logical_counter`
 * 
 * Constraints:
 * - Physical Time: up to ~2200 AD (before exceeding safe integer with 12-bit shift)
 * - Logical Counter: 12 bits (4096 ops per millisecond)
 */

/**
 * @module HLC
 * @description
 * Hybrid Logical Clock (HLC) implementation for nMeshed.
 * 
 * Provides a 128-bit timestamp (Physical[48] | Logical[16] | NodeID[64]).
 * Thread-safe and monotonic.
 */

export class HLC {
    // Bit shifts
    private static LOGICAL_BITS = 16n;
    private static NODE_BITS = 64n;
    private static PHYSICAL_SHIFT = 80n; // 16 + 64
    private static LOGICAL_SHIFT = 64n;

    // Masks
    private static LOGICAL_MASK = 0xFFFFn;
    private static PHYSICAL_MASK = 0xFFFFFFFFFFFFn;
    private static NODE_MASK = 0xFFFFFFFFFFFFFFFFn;

    private lastPhysical = 0n;
    private lastLogical = 0n;
    private nodeId: bigint;

    constructor(nodeId: string | bigint) {
        if (typeof nodeId === 'string') {
            // Hash string to 64-bit BigInt if string provided
            this.nodeId = BigInt('0x' + this.hashString(nodeId).slice(0, 16));
        } else {
            this.nodeId = nodeId;
        }
    }

    /**
     * Unpacks a 128-bit hybrid timestamp.
     */
    static unpack(ts: bigint): { wall: bigint; logical: bigint; nodeId: bigint } {
        const nodeId = ts & HLC.NODE_MASK;
        const logical = (ts >> HLC.LOGICAL_SHIFT) & HLC.LOGICAL_MASK;
        const wall = (ts >> HLC.PHYSICAL_SHIFT) & HLC.PHYSICAL_MASK;
        return { wall, logical, nodeId };
    }

    /**
     * Packs components into a 128-bit timestamp.
     */
    static pack(wall: bigint, logical: bigint, nodeId: bigint): bigint {
        return (wall << HLC.PHYSICAL_SHIFT) | (logical << HLC.LOGICAL_SHIFT) | nodeId;
    }

    /**
     * Generates the next local monotonic timestamp.
     */
    now(): bigint {
        const wall = BigInt(Date.now());

        // Ensure monotonicity
        if (wall > this.lastPhysical) {
            this.lastPhysical = wall;
            this.lastLogical = 0n;
        } else {
            // Wall clock hasn't moved or went back
            this.lastLogical++;
            // If logical overflows 16 bits, we must increment physical (drift)
            if (this.lastLogical > HLC.LOGICAL_MASK) {
                this.lastPhysical++;
                this.lastLogical = 0n;
            }
        }

        return HLC.pack(this.lastPhysical, this.lastLogical, this.nodeId);
    }

    /**
     * Updates local clock based on a received remote timestamp.
     */
    update(remoteTs: bigint): bigint {
        const wall = BigInt(Date.now());
        const { wall: rWall, logical: rLogical } = HLC.unpack(remoteTs);

        // Calculate new physical
        // max(local_physical, remote_physical, wall_now)
        const nextPhysical = this.max(this.lastPhysical, this.max(rWall, wall));

        if (nextPhysical === this.lastPhysical && nextPhysical === rWall) {
            // All equal, increment max logical
            this.lastLogical = this.max(this.lastLogical, rLogical) + 1n;
        } else if (nextPhysical === this.lastPhysical) {
            // Local wins physical, increment local logical
            this.lastLogical++;
        } else if (nextPhysical === rWall) {
            // Remote wins physical, increment based on remote
            this.lastLogical = rLogical + 1n;
        } else {
            // Wall clock wins, reset
            this.lastLogical = 0n;
        }

        // Overflow check
        if (this.lastLogical > HLC.LOGICAL_MASK) {
            this.lastPhysical = nextPhysical + 1n;
            this.lastLogical = 0n;
        } else {
            this.lastPhysical = nextPhysical;
        }

        return HLC.pack(this.lastPhysical, this.lastLogical, this.nodeId);
    }

    private max(a: bigint, b: bigint): bigint {
        return a > b ? a : b;
    }

    private hashString(str: string): string {
        // Simple hash fallback for demo - in prod use robust hash
        let hash = 5381n;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5n) + hash) + BigInt(str.charCodeAt(i));
        }
        // Return hex string padded
        return (hash & 0xFFFFFFFFFFFFFFFFn).toString(16).padStart(16, '0');
    }
}

