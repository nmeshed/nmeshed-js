import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEngine, EngineState, InvalidStateTransitionError } from './SyncEngine';

// Mock persistence
vi.mock('../persistence', () => ({
    loadQueue: vi.fn().mockResolvedValue([]),
    saveQueue: vi.fn().mockResolvedValue(undefined),
}));

const VALID_UUID_1 = '00000000-0000-0000-0000-000000000001';
const VALID_UUID_2 = '00000000-0000-0000-0000-000000000002';

describe('SyncEngine State Machine', () => {
    let engine: SyncEngine;

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        if (engine && engine.state !== EngineState.DESTROYED) {
            engine.destroy();
        }
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    describe('Initial State', () => {
        it('should start in IDLE state', () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            expect(engine.state).toBe(EngineState.IDLE);
        });

        it('should not be operational in IDLE state', () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            expect(engine.isOperational).toBe(false);
        });
    });

    describe('boot() Transitions', () => {
        it('should transition IDLE -> BOOTING -> ACTIVE on successful boot', async () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            const stateChanges: [EngineState, EngineState][] = [];
            engine.on('stateChange', (from, to) => stateChanges.push([from, to]));

            await engine.boot();
            await vi.advanceTimersByTimeAsync(100);

            expect(engine.state).toBe(EngineState.ACTIVE);
            expect(stateChanges).toContainEqual([EngineState.IDLE, EngineState.BOOTING]);
            expect(stateChanges).toContainEqual([EngineState.BOOTING, EngineState.ACTIVE]);
        });

        it('should be operational after boot', async () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            await engine.boot();
            await vi.advanceTimersByTimeAsync(100);

            expect(engine.isOperational).toBe(true);
        });

        it('should allow re-boot from STOPPED state', async () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            await engine.boot();
            await vi.advanceTimersByTimeAsync(100);

            engine.stop();
            expect(engine.state).toBe(EngineState.STOPPED);

            await engine.boot();
            await vi.advanceTimersByTimeAsync(100);
            expect(engine.state).toBe(EngineState.ACTIVE);
        });

        it('should be idempotent when already ACTIVE', async () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            await engine.boot();
            await vi.advanceTimersByTimeAsync(100);

            const state1 = engine.state;
            await engine.boot(); // Should not throw
            expect(engine.state).toBe(state1);
        });

        it('should throw when booting from DESTROYED state', async () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            engine.destroy();

            await expect(engine.boot()).rejects.toThrow(InvalidStateTransitionError);
        });
    });

    describe('stop() Transitions', () => {
        it('should transition ACTIVE -> STOPPING -> STOPPED', async () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            await engine.boot();
            await vi.advanceTimersByTimeAsync(100);

            const stateChanges: [EngineState, EngineState][] = [];
            engine.on('stateChange', (from, to) => stateChanges.push([from, to]));

            engine.stop();

            expect(engine.state).toBe(EngineState.STOPPED);
            expect(stateChanges).toContainEqual([EngineState.ACTIVE, EngineState.STOPPING]);
            expect(stateChanges).toContainEqual([EngineState.STOPPING, EngineState.STOPPED]);
        });

        it('should not be operational after stop', async () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            await engine.boot();
            await vi.advanceTimersByTimeAsync(100);

            engine.stop();

            expect(engine.isOperational).toBe(false);
        });

        it('should be idempotent when already STOPPED', async () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            await engine.boot();
            await vi.advanceTimersByTimeAsync(100);

            engine.stop();
            engine.stop(); // Should not throw
            expect(engine.state).toBe(EngineState.STOPPED);
        });

        it('should throw when stopping from IDLE state', () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            expect(() => engine.stop()).toThrow(InvalidStateTransitionError);
        });
    });

    describe('destroy() Transitions', () => {
        it('should transition to DESTROYED from IDLE', () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            engine.destroy();
            expect(engine.state).toBe(EngineState.DESTROYED);
        });

        it('should transition to DESTROYED from ACTIVE', async () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            await engine.boot();
            await vi.advanceTimersByTimeAsync(100);

            engine.destroy();
            expect(engine.state).toBe(EngineState.DESTROYED);
        });

        it('should transition to DESTROYED from STOPPED', async () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            await engine.boot();
            await vi.advanceTimersByTimeAsync(100);

            engine.stop();
            engine.destroy();
            expect(engine.state).toBe(EngineState.DESTROYED);
        });

        it('should be idempotent when already DESTROYED', () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            engine.destroy();
            engine.destroy(); // Should not throw
            expect(engine.state).toBe(EngineState.DESTROYED);
        });
    });

    describe('Operation Guards', () => {
        it('should buffer set() calls in IDLE state', () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            const result = engine.set('key', 'value');

            expect(result).toBeInstanceOf(Uint8Array);
            // Value should be buffered, not applied to core
        });

        it('should allow set() in ACTIVE state', async () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            await engine.boot();
            await vi.advanceTimersByTimeAsync(100);

            expect(() => engine.set('key', 'value')).not.toThrow();
        });

        it('should throw set() in DESTROYED state', async () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            await engine.boot();
            await vi.advanceTimersByTimeAsync(100);

            engine.destroy();

            expect(() => engine.set('key', 'value')).toThrow();
        });

        it('should buffer applyRawMessage() calls before boot', () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            const bytes = new Uint8Array([1, 2, 3]);

            // Should not throw
            expect(() => engine.applyRawMessage(bytes)).not.toThrow();
        });

        it('should silently drop applyRawMessage() calls after destroy', async () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            await engine.boot();
            await vi.advanceTimersByTimeAsync(100);

            engine.destroy();

            // Should not throw - just silently drops
            expect(() => engine.applyRawMessage(new Uint8Array([1, 2, 3]))).not.toThrow();
        });
    });

    describe('Reconnection Flow', () => {
        it('should support full connect -> disconnect -> reconnect cycle', async () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);

            // Connect
            await engine.boot();
            await vi.advanceTimersByTimeAsync(100);
            expect(engine.state).toBe(EngineState.ACTIVE);

            // Disconnect
            engine.stop();
            expect(engine.state).toBe(EngineState.STOPPED);

            // Reconnect
            await engine.boot();
            await vi.advanceTimersByTimeAsync(100);
            expect(engine.state).toBe(EngineState.ACTIVE);
            expect(engine.isOperational).toBe(true);
        });

        it('should process buffered messages after reconnect', async () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);

            // Buffer a message before boot
            const bytes = new Uint8Array([1, 2, 3, 4]);
            engine.applyRawMessage(bytes);

            // Boot should process buffered messages
            await engine.boot();
            await vi.advanceTimersByTimeAsync(100);

            // Engine should be operational
            expect(engine.isOperational).toBe(true);
        });
    });

    describe('State Change Events', () => {
        it('should emit stateChange event on every transition', async () => {
            engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2);
            const stateChanges: [EngineState, EngineState][] = [];
            engine.on('stateChange', (from, to) => stateChanges.push([from, to]));

            await engine.boot();
            await vi.advanceTimersByTimeAsync(100);
            engine.stop();
            await engine.boot();
            await vi.advanceTimersByTimeAsync(100);
            engine.destroy();

            expect(stateChanges.length).toBeGreaterThanOrEqual(6);
        });
    });

    describe('InvalidStateTransitionError', () => {
        it('should include from, to, and action in error message', () => {
            const error = new InvalidStateTransitionError(
                EngineState.DESTROYED,
                EngineState.BOOTING,
                'boot()'
            );

            expect(error.message).toContain('DESTROYED');
            expect(error.message).toContain('BOOTING');
            expect(error.message).toContain('boot()');
            expect(error.name).toBe('InvalidStateTransitionError');
        });
    });
});
