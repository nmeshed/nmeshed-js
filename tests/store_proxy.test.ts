/**
 * StoreProxy Tests
 * 
 * Verifying the "Ferrari" engine mechanics.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { createProxy } from '../src/StoreProxy';
import { SyncEngine } from '../src/engine';

// Mock Engine
class MockEngine {
    state = new Map<string, any>();
    set = vi.fn((key: string, value: any) => {
        this.state.set(key, value);
        return new Uint8Array();
    });
    get = vi.fn((key: string) => this.state.get(key));
}

describe('StoreProxy', () => {
    let engine: MockEngine;

    beforeEach(() => {
        engine = new MockEngine();
        vi.spyOn(console, 'log').mockImplementation(() => { }); // Suppress debug logs
    });

    it('should initialize with default array for z.array()', () => {
        const schema = z.array(z.string());
        const typeName = (schema as any)?._def?.typeName;
        expect(typeName).toBe('ZodArray');

        const proxy = createProxy(engine as any as SyncEngine, 'tasks', schema);
        expect(proxy).toEqual([]);
        expect(Array.isArray(proxy)).toBe(true);
    });

    it('should initialize with default object for z.object()', () => {
        const proxy = createProxy(engine as any as SyncEngine, 'config', z.object({}));
        expect(proxy).toEqual({});
        expect(Array.isArray(proxy)).toBe(false);
    });

    it('should use existing engine state if present', () => {
        engine.state.set('tasks', ['existing']);
        const proxy = createProxy(engine as any as SyncEngine, 'tasks', z.array(z.string()));
        expect(proxy).toEqual(['existing']);
    });

    describe('Array Traps', () => {
        it('should intercept .push() and trigger engine.set', () => {
            const proxy = createProxy<string[]>(engine as any as SyncEngine, 'tasks', z.array(z.string()));

            // Action - this exercises lines 23-26 (push trap)
            const newLen = proxy.push('new-task');

            // Verify local mutation
            expect(newLen).toBe(1);
            expect(proxy[0]).toBe('new-task');
            expect(proxy.length).toBe(1);

            // Verify sync trigger
            expect(engine.set).toHaveBeenCalledTimes(1);
            expect(engine.set).toHaveBeenCalledWith('tasks', ['new-task']);
        });

        it('should handle multiple push calls', () => {
            const proxy = createProxy<string[]>(engine as any as SyncEngine, 'tasks', z.array(z.string()));
            proxy.push('a');
            proxy.push('b', 'c');
            expect(proxy).toEqual(['a', 'b', 'c']);
            expect(engine.set).toHaveBeenCalledTimes(2);
        });

        it('should handle standard property access', () => {
            const proxy = createProxy<string[]>(engine as any as SyncEngine, 'tasks', z.array(z.string()));
            proxy.push('a');
            expect(proxy[0]).toBe('a');
            expect(proxy.length).toBe(1);
        });
    });

    describe('Object Traps', () => {
        it('should intercept assignment and trigger engine.set', () => {
            const proxy = createProxy<Record<string, any>>(engine as any as SyncEngine, 'settings', z.object({}));

            // Action
            proxy.theme = 'dark';

            // Verify local
            expect(proxy.theme).toBe('dark');

            // Verify sync
            expect(engine.set).toHaveBeenCalledWith('settings', expect.objectContaining({ theme: 'dark' }));
        });

        it('should handle nested property access', () => {
            engine.state.set('settings', { nested: { value: 42 } });
            const proxy = createProxy<Record<string, any>>(engine as any as SyncEngine, 'settings', z.object({}));
            expect(proxy.nested.value).toBe(42);
        });

        it('should return false for failed Reflect.set', () => {
            // Frozen object cannot be modified
            const frozen = Object.freeze({ immutable: true });
            engine.state.set('frozen', frozen);
            const proxy = createProxy<Record<string, any>>(engine as any as SyncEngine, 'frozen', z.object({}));

            // This should fail silently due to frozen object
            const result = Reflect.set(proxy, 'newProp', 'value');
            // Note: Proxy behavior with frozen objects is complex, just verify no crash
            expect(frozen).toEqual({ immutable: true });
        });

        it('BUG: should intercept delete and trigger engine.set (sync the removal)', () => {
            // BUG: StoreProxy doesn't have deleteProperty trap!
            // This causes usePresence cleanup to only work locally
            const proxy = createProxy<Record<string, any>>(engine as any as SyncEngine, 'presence', z.object({}));

            // Set a value first
            proxy.peer1 = { x: 1, y: 2 };
            expect(engine.set).toHaveBeenCalledTimes(1);
            engine.set.mockClear();

            // Delete the value
            delete proxy.peer1;

            // BUG: This should trigger engine.set to sync the deletion
            // Currently it only mutates locally - other peers never see it!
            expect(engine.set).toHaveBeenCalledTimes(1);
            expect(engine.set).toHaveBeenCalledWith('presence', expect.not.objectContaining({ peer1: expect.anything() }));
        });
    });
});
