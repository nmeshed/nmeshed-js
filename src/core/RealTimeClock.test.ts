/**
 * @file RealTimeClock.test.ts
 * @brief Tests for RealTimeClock tick synchronization.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealTimeClock } from './RealTimeClock';

describe('RealTimeClock', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('lifecycle', () => {
        it('starts in stopped state with tick 0', () => {
            const clock = new RealTimeClock('peer-1', 60);
            expect(clock.getTick()).toBe(0);
        });

        it('can set tick directly', () => {
            const clock = new RealTimeClock('peer-1', 60);
            clock.setTick(100);
            expect(clock.getTick()).toBe(100);
        });

        it('emits tick events when started', () => {
            const clock = new RealTimeClock('peer-1', 60);
            const tickHandler = vi.fn();
            clock.on('tick', tickHandler);

            clock.start();
            // At 60 ticks/sec, each tick is ~16.67ms
            vi.advanceTimersByTime(50);

            expect(tickHandler).toHaveBeenCalled();
            clock.stop();
        });

        it('stops emitting ticks when stopped', () => {
            const clock = new RealTimeClock('peer-1', 60);
            const tickHandler = vi.fn();
            clock.on('tick', tickHandler);

            clock.start();
            vi.advanceTimersByTime(50);
            const callsBeforeStop = tickHandler.mock.calls.length;

            clock.stop();
            tickHandler.mockClear();

            vi.advanceTimersByTime(100);
            expect(tickHandler).not.toHaveBeenCalled();
        });

        it('ignores multiple start calls', () => {
            const clock = new RealTimeClock('peer-1', 60);
            clock.start();
            clock.start(); // Should not error or double-schedule
            clock.stop();
        });
    });

    describe('tick progression', () => {
        it('advances ticks at the configured rate', () => {
            const clock = new RealTimeClock('peer-1', 10); // 10 ticks/sec = 100ms/tick
            clock.start();

            vi.advanceTimersByTime(300); // Should advance ~3 ticks

            expect(clock.getTick()).toBeGreaterThanOrEqual(2);
            clock.stop();
        });

        it('catches up when falling more than 120 ticks behind target', () => {
            const clock = new RealTimeClock('peer-1', 60); // 60 ticks/sec = ~16ms/tick
            clock.start();

            // Advance time to let the clock tick a bit
            vi.advanceTimersByTime(100); // Should advance ~6 ticks
            expect(clock.getTick()).toBeGreaterThan(0);

            const tickBefore = clock.getTick();

            // Simulate receiving a remote sync that's way ahead (more than 120 ticks)
            clock.applySync({
                tick: tickBefore + 200, // 200 ticks ahead
                timestamp: Date.now(),
                peerId: 'remote-peer'
            });

            // Advance time to let clock process and potentially jump
            vi.advanceTimersByTime(50);

            // The clock should have started catching up
            expect(clock.getTick()).toBeGreaterThan(tickBefore);
            clock.stop();
        });
    });

    describe('applySync', () => {
        it('ignores sync from self', () => {
            const clock = new RealTimeClock('peer-1', 60);
            const syncHandler = vi.fn();
            clock.on('sync', syncHandler);

            clock.applySync({
                tick: 100,
                timestamp: Date.now(),
                peerId: 'peer-1' // Same as local peer
            });

            expect(syncHandler).not.toHaveBeenCalled();
        });

        it('updates target tick from remote sync', () => {
            const clock = new RealTimeClock('local-peer', 60);
            const syncHandler = vi.fn();
            clock.on('sync', syncHandler);

            clock.applySync({
                tick: 50,
                timestamp: Date.now(),
                peerId: 'remote-peer'
            });

            expect(syncHandler).toHaveBeenCalledWith(expect.objectContaining({
                tick: 50,
                peerId: 'remote-peer'
            }));
        });

        it('ignores sync with lower tick than current target', () => {
            const clock = new RealTimeClock('local', 60);
            const syncHandler = vi.fn();
            clock.on('sync', syncHandler);

            // First sync sets target
            clock.applySync({ tick: 100, timestamp: Date.now(), peerId: 'remote' });
            expect(syncHandler).toHaveBeenCalledTimes(1);

            // Lower tick ignored
            clock.applySync({ tick: 50, timestamp: Date.now(), peerId: 'remote' });
            expect(syncHandler).toHaveBeenCalledTimes(1); // No additional call
        });

        it('handles BigInt tick values from FlatBuffers', () => {
            const clock = new RealTimeClock('local', 60);
            const syncHandler = vi.fn();
            clock.on('sync', syncHandler);

            // FlatBuffers may send BigInt for int64
            clock.applySync({
                tick: BigInt(42) as any, // Coerced to number internally
                timestamp: BigInt(Date.now()) as any,
                peerId: 'remote'
            });

            expect(syncHandler).toHaveBeenCalled();
        });
    });

    describe('RAF fallback', () => {
        it('uses setTimeout fallback when RAF is unavailable', () => {
            // Temporarily remove requestAnimationFrame and cancelAnimationFrame
            const originalRAF = globalThis.requestAnimationFrame;
            const originalCAF = globalThis.cancelAnimationFrame;
            (globalThis as any).requestAnimationFrame = undefined;
            (globalThis as any).cancelAnimationFrame = undefined;

            const clock = new RealTimeClock('peer-1', 60);
            clock.start();

            // Should not throw and should still tick via setTimeout
            vi.advanceTimersByTime(100);

            expect(clock.getTick()).toBeGreaterThan(0);
            clock.stop();

            // Restore
            globalThis.requestAnimationFrame = originalRAF;
            globalThis.cancelAnimationFrame = originalCAF;
        });
    });
});
