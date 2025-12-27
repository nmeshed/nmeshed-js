/**
 * A minimal Consistent Hash Ring for distributing keys to peers.
 * Uses a simple FNV-1a hash for browser compatibility and speed.
 */
export class ConsistentHashRing {
    private nodes: string[] = [];
    private sortedKeys: bigint[] = [];
    private ring: Map<bigint, string> = new Map();
    private replicationFactor: number;

    constructor(replicationFactor: number = 20) {
        this.replicationFactor = replicationFactor;
    }

    /**
     * Add a node (peer) to the ring.
     */
    public addNode(nodeId: string) {
        if (this.nodes.includes(nodeId)) return;
        this.nodes.push(nodeId);

        for (let i = 0; i < this.replicationFactor; i++) {
            const key = this.hash(`${nodeId}:${i}`);
            this.ring.set(key, nodeId);
            this.sortedKeys.push(key);
        }
        this.sortedKeys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }

    /**
     * Remove a node from the ring.
     */
    public removeNode(nodeId: string) {
        const index = this.nodes.indexOf(nodeId);
        if (index === -1) return;
        this.nodes.splice(index, 1);

        // Remove from map and sorted keys
        const keysToRemove: bigint[] = [];
        for (const [key, node] of this.ring.entries()) {
            if (node === nodeId) {
                keysToRemove.push(key);
                this.ring.delete(key);
            }
        }

        this.sortedKeys = this.sortedKeys.filter(k => !keysToRemove.includes(k));
    }

    /**
     * Get the node responsible for the data key.
     */
    public getNode(dataKey: string): string | null {
        if (this.nodes.length === 0) return null;

        const hash = this.hash(dataKey);

        // Find the first node with key >= hash using binary search
        let low = 0;
        let high = this.sortedKeys.length - 1;
        let idx = -1;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const midVal = this.sortedKeys[mid];

            if (midVal >= hash) {
                idx = mid;
                high = mid - 1;
            } else {
                low = mid + 1;
            }
        }

        // Wrap around to 0 if not found (Ring topology)
        if (idx === -1) {
            idx = 0;
        }

        const nodeKey = this.sortedKeys[idx];
        return this.ring.get(nodeKey) || null;
    }

    /**
     * FNV-1a 64-bit hash algorithm.
     */
    private hash(val: string): bigint {
        const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
        const FNV_PRIME = 0x00000100000001B3n;

        let hash = FNV_OFFSET_BASIS;
        for (let i = 0; i < val.length; i++) {
            hash ^= BigInt(val.charCodeAt(i));
            hash = (hash * FNV_PRIME) & 0xFFFFFFFFFFFFFFFFn;
        }
        return hash;
    }

    public getNodes(): string[] {
        return [...this.nodes];
    }
}
