
/**
 * A fixed-size Ring Buffer (Circular Buffer) implementation.
 * 
 * Provides O(1) push and shift operations, avoiding the O(n) array methods.
 * Useful for high-performance operation queues where simple Arrays would cause GC pressure
 * and performance degradation during shifts.
 */
export class RingBuffer<T> {
    private buffer: (T | undefined)[];
    private capacity: number;
    private readPtr: number = 0;
    private writePtr: number = 0;
    private count: number = 0;

    constructor(capacity: number) {
        if (capacity <= 0) throw new Error('RingBuffer capacity must be > 0');
        this.capacity = capacity;
        this.buffer = new Array(capacity);
    }

    /**
     * Adds an item to the end of the buffer.
     * If buffer is full, it overwrites the oldest item (circular).
     */
    public push(item: T): void {
        this.buffer[this.writePtr] = item;
        this.writePtr = (this.writePtr + 1) % this.capacity;

        if (this.count < this.capacity) {
            this.count++;
        } else {
            // Overwrote oldest, move read pointer
            this.readPtr = (this.readPtr + 1) % this.capacity;
        }
    }

    /**
     * Removes and returns the oldest item from the buffer.
     * Returns undefined if empty.
     */
    public shift(): T | undefined {
        if (this.count === 0) return undefined;

        const item = this.buffer[this.readPtr];
        this.buffer[this.readPtr] = undefined; // GC help
        this.readPtr = (this.readPtr + 1) % this.capacity;
        this.count--;

        return item;
    }

    /**
     * Removes the first N items.
     * Efficiency: O(n) where n is count (to clear references), but simpler than array splice.
     */
    public shiftMany(count: number): void {
        const toShift = Math.min(count, this.count);
        for (let i = 0; i < toShift; i++) {
            this.buffer[this.readPtr] = undefined;
            this.readPtr = (this.readPtr + 1) % this.capacity;
        }
        this.count -= toShift;
    }

    public get length(): number {
        return this.count;
    }

    public get isFull(): boolean {
        return this.count === this.capacity;
    }

    public get isEmpty(): boolean {
        return this.count === 0;
    }

    public clear(): void {
        this.readPtr = 0;
        this.writePtr = 0;
        this.count = 0;
        this.buffer.fill(undefined);
    }

    public toArray(): T[] {
        const res: T[] = new Array(this.count);
        let ptr = this.readPtr;
        for (let i = 0; i < this.count; i++) {
            res[i] = this.buffer[ptr] as T;
            ptr = (ptr + 1) % this.capacity;
        }
        return res;
    }
}
