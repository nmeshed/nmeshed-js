import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from './EventEmitter';

interface TestEvents {
    data: [string];
    error: [Error];
    empty: [];
    [key: string]: any[];
}

describe('EventEmitter', () => {
    it('should emit events to listeners', () => {
        const emitter = new EventEmitter<TestEvents>();
        const listener = vi.fn();

        emitter.on('data', listener);
        emitter.emit('data', 'hello');

        expect(listener).toHaveBeenCalledWith('hello');
    });

    it('should unsubscribe listener using returned function', () => {
        const emitter = new EventEmitter<TestEvents>();
        const listener = vi.fn();

        const unsubscribe = emitter.on('data', listener);
        unsubscribe();
        emitter.emit('data', 'hello');

        expect(listener).not.toHaveBeenCalled();
    });

    it('should unsubscribe using off()', () => {
        const emitter = new EventEmitter<TestEvents>();
        const listener = vi.fn();

        emitter.on('data', listener);
        emitter.off('data', listener);
        emitter.emit('data', 'hello');

        expect(listener).not.toHaveBeenCalled();
    });

    it('should handle once() subscription', () => {
        const emitter = new EventEmitter<TestEvents>();
        const listener = vi.fn();

        emitter.once('data', listener);
        emitter.emit('data', 'first');
        emitter.emit('data', 'second');

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith('first');
    });

    it('should remove all listeners', () => {
        const emitter = new EventEmitter<TestEvents>();
        const listener = vi.fn();

        emitter.on('data', listener);
        emitter.removeAllListeners();
        emitter.emit('data', 'hello');

        expect(listener).not.toHaveBeenCalled();
    });

    it('should catch handler errors without crashing', () => {
        const emitter = new EventEmitter<TestEvents>();
        const errorListener = vi.fn(() => { throw new Error('Boom'); });
        const successListener = vi.fn();

        // Suppress console.error for this test
        const originalError = console.error;
        console.error = vi.fn();

        emitter.on('data', errorListener);
        emitter.on('data', successListener);

        expect(() => emitter.emit('data', 'test')).not.toThrow();
        expect(successListener).toHaveBeenCalledWith('test');
        expect(console.error).toHaveBeenCalled();

        console.error = originalError;
    });

    it('should safely handle emitting with no listeners', () => {
        const emitter = new EventEmitter<TestEvents>();
        expect(() => emitter.emit('data', 'test')).not.toThrow();
    });
});
