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
    });

    it('should initialize with default array for z.array()', () => {
        const proxy = createProxy(engine as any as SyncEngine, 'tasks', z.array(z.string()));
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

            // Action
            const newLen = proxy.push('new-task');

            // Verify local mutation
            expect(newLen).toBe(1);
            expect(proxy[0]).toBe('new-task');
            expect(proxy.length).toBe(1);

            // Verify sync trigger
            expect(engine.set).toHaveBeenCalledTimes(1);
            expect(engine.set).toHaveBeenCalledWith('tasks', ['new-task']);
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
    });
});
