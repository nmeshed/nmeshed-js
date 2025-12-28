
import { describe, it, expect } from 'vitest';
import { RingBuffer } from './RingBuffer';

describe('RingBuffer', () => {
    it('should push and shift', () => {
        const rb = new RingBuffer<number>(3);
        rb.push(1);
        rb.push(2);
        expect(rb.length).toBe(2);
        expect(rb.shift()).toBe(1);
        expect(rb.shift()).toBe(2);
        expect(rb.isEmpty).toBe(true);
    });

    it('should overwrite correctly (circular)', () => {
        const rb = new RingBuffer<number>(3);
        rb.push(1);
        rb.push(2);
        rb.push(3);
        expect(rb.isFull).toBe(true);
        rb.push(4); // Should overwrite 1
        expect(rb.length).toBe(3);
        expect(rb.shift()).toBe(2);
        expect(rb.shift()).toBe(3);
        expect(rb.shift()).toBe(4);
    });

    it('should shiftMany', () => {
        const rb = new RingBuffer<number>(5);
        rb.push(1);
        rb.push(2);
        rb.push(3);
        rb.shiftMany(2);
        expect(rb.length).toBe(1);
        expect(rb.shift()).toBe(3);
    });

    it('should toArray correctly with wrap-around', () => {
        const rb = new RingBuffer<number>(3);
        rb.push(1);
        rb.push(2);
        rb.push(3);
        rb.push(4); // [4, 2, 3] internal, read at 2

        expect(rb.toArray()).toEqual([2, 3, 4]);
    });
});
