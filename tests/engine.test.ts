/**
 * NMeshed v2 - Engine Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncEngine } from '../src/engine';
import { encodeValue } from '../src/protocol';

describe('SyncEngine', () => {
    let engine: SyncEngine;

    beforeEach(() => {
        engine = new SyncEngine('test-peer', false);
    });

    describe('get/set', () => {
        it('should set and get values', () => {
            engine.set('key', 'value');
            expect(engine.get('key')).toBe('value');
        });

        it('should return undefined for missing keys', () => {
            expect(engine.get('missing')).toBeUndefined();
        });

        it('should emit op event on set', () => {
            const handler = vi.fn();
            engine.on('op', handler);

            engine.set('key', 'value');

            expect(handler).toHaveBeenCalledWith('key', 'value', true);
        });

        it('should return Uint8Array payload', () => {
            const payload = engine.set('key', 'value');
            expect(payload).toBeInstanceOf(Uint8Array);
        });

        it('should handle complex values', () => {
            const value = { nested: { deep: true }, arr: [1, 2, 3] };
            engine.set('complex', value);
            expect(engine.get('complex')).toEqual(value);
        });
    });

    describe('delete', () => {
        it('should delete keys (set to null tombstone)', () => {
            engine.set('key', 'value');
            engine.delete('key');
            expect(engine.get('key')).toBeNull();
        });

        it('should emit op event on delete', () => {
            const handler = vi.fn();
            engine.set('key', 'value');
            engine.on('op', handler);

            engine.delete('key');

            expect(handler).toHaveBeenCalledWith('key', null, true);
        });

        it('should return Uint8Array payload', () => {
            engine.set('key', 'value');
            const payload = engine.delete('key');
            expect(payload).toBeInstanceOf(Uint8Array);
        });
    });

    describe('applyRemote', () => {
        it('should apply remote operations', () => {
            const payload = encodeValue('remote-value');
            engine.applyRemote('key', payload, 'other-peer');
            expect(engine.get('key')).toBe('remote-value');
        });

        it('should emit op event with isLocal=false', () => {
            const handler = vi.fn();
            engine.on('op', handler);

            const payload = encodeValue('value');
            engine.applyRemote('key', payload, 'peer-123');

            expect(handler).toHaveBeenCalledWith('key', 'value', false);
        });

        it('should handle complex remote values', () => {
            const value = { tasks: [{ id: 1 }] };
            const payload = encodeValue(value);
            engine.applyRemote('board', payload, 'peer');
            expect(engine.get('board')).toEqual(value);
        });
    });

    describe('loadSnapshot', () => {
        it('should load snapshot data', () => {
            const snapshot = { key1: 'value1', key2: 42 };
            const data = encodeValue(snapshot);
            engine.loadSnapshot(data);

            expect(engine.get('key1')).toBe('value1');
            expect(engine.get('key2')).toBe(42);
        });

        it('should emit op events for each key', () => {
            const handler = vi.fn();
            engine.on('op', handler);

            const snapshot = { a: 1, b: 2, c: 3 };
            const data = encodeValue(snapshot);
            engine.loadSnapshot(data);

            expect(handler).toHaveBeenCalledTimes(3);
        });
    });

    describe('getSnapshot / getAllValues', () => {
        it('should export all values', () => {
            engine.set('a', 1);
            engine.set('b', 2);

            const snapshot = engine.getSnapshot();

            expect(snapshot).toEqual({ a: 1, b: 2 });
        });

        it('getAllValues should return same as getSnapshot', () => {
            engine.set('x', 'y');
            expect(engine.getAllValues()).toEqual(engine.getSnapshot());
        });

        it('should iterate over all entries', () => {
            engine.set('a', 1);
            engine.set('b', 2);

            const entries: [string, unknown][] = [];
            engine.forEach((value, key) => entries.push([key, value]));

            expect(entries).toEqual([['a', 1], ['b', 2]]);
        });
    });

    describe('status', () => {
        it('should start disconnected', () => {
            expect(engine.getStatus()).toBe('disconnected');
        });

        it('should emit status event on change', () => {
            const handler = vi.fn();
            engine.on('status', handler);

            engine.setStatus('connecting');

            expect(handler).toHaveBeenCalledWith('connecting');
        });

        it('should not emit if status unchanged', () => {
            const handler = vi.fn();
            engine.setStatus('connecting');
            engine.on('status', handler);

            engine.setStatus('connecting');

            expect(handler).not.toHaveBeenCalled();
        });

        it('should support all status types', () => {
            const statuses = ['disconnected', 'connecting', 'connected', 'syncing', 'ready', 'reconnecting', 'error'] as const;
            for (const status of statuses) {
                engine.setStatus(status);
                expect(engine.getStatus()).toBe(status);
            }
        });
    });

    describe('pending operations', () => {
        it('should track pending operations', () => {
            expect(engine.getPendingCount()).toBe(0);

            engine.set('key', 'value');

            expect(engine.getPendingCount()).toBe(1);
        });

        it('should clear pending operations', () => {
            engine.set('key', 'value');
            engine.clearPending();

            expect(engine.getPendingCount()).toBe(0);
        });

        it('should drain pending operations', () => {
            engine.set('a', 1);
            engine.set('b', 2);

            const ops = engine.drainPending();

            expect(ops).toHaveLength(2);
            expect(engine.getPendingCount()).toBe(0);
        });

        it('should include operation details in drained ops', () => {
            engine.set('key', 'value');
            const ops = engine.drainPending();

            expect(ops[0].key).toBe('key');
            expect(ops[0].value).toBe('value');
            expect(ops[0].peerId).toBe('test-peer');
        });
    });

    describe('peerId', () => {
        it('should return the peer ID', () => {
            expect(engine.getPeerId()).toBe('test-peer');
        });
    });

    describe('cleanup', () => {
        it('should clear state on destroy', () => {
            engine.set('key', 'value');
            engine.destroy();

            expect(engine.get('key')).toBeUndefined();
            expect(engine.getPendingCount()).toBe(0);
        });
    });

    describe('event handling', () => {
        it('should allow unsubscribing from events', () => {
            const handler = vi.fn();
            const unsub = engine.on('op', handler);

            unsub();
            engine.set('key', 'value');

            expect(handler).not.toHaveBeenCalled();
        });

        it('should handle errors in event handlers gracefully', () => {
            const errorHandler = vi.fn(() => { throw new Error('Handler error'); });
            const normalHandler = vi.fn();

            engine.on('op', errorHandler);
            engine.on('op', normalHandler);

            // Should not throw
            expect(() => engine.set('key', 'value')).not.toThrow();

            // Normal handler should still be called
            expect(normalHandler).toHaveBeenCalled();
        });

        it('should emit error events', () => {
            const handler = vi.fn();
            engine.on('error', handler);

            // Emit error directly
            (engine as any).emit('error', new Error('test'));

            expect(handler).toHaveBeenCalled();
        });

        it('should emit peerJoin events', () => {
            const handler = vi.fn();
            engine.on('peerJoin', handler);

            (engine as any).emit('peerJoin', 'peer-123');

            expect(handler).toHaveBeenCalledWith('peer-123');
        });

        it('should emit peerLeave events', () => {
            const handler = vi.fn();
            engine.on('peerLeave', handler);

            (engine as any).emit('peerLeave', 'peer-456');

            expect(handler).toHaveBeenCalledWith('peer-456');
        });

        it('should emit ready events', () => {
            const handler = vi.fn();
            engine.on('ready', handler);

            (engine as any).emit('ready');

            expect(handler).toHaveBeenCalled();
        });
    });

    describe('WASM core', () => {
        it('should attach WASM core', () => {
            const mockCore = {
                applyLocalOp: vi.fn(),
                mergeRemoteDelta: vi.fn(),
                getValue: vi.fn(),
                getAllValues: vi.fn(),
                getBinarySnapshot: vi.fn(),
                loadSnapshot: vi.fn(),
                forEach: vi.fn(),
            };

            expect(() => engine.attachCore(mockCore)).not.toThrow();
        });
    });

    describe('debug mode', () => {
        it('should log when debug is enabled', () => {
            const debugEngine = new SyncEngine('debug-peer', true);
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

            debugEngine.set('key', 'value');

            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });

        it('should not log when debug is disabled', () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

            engine.set('key', 'value');

            // Filter out any logging that isn't from our engine
            const engineLogs = consoleSpy.mock.calls.filter(
                call => call[0]?.toString().includes('[NMeshed')
            );
            expect(engineLogs).toHaveLength(0);
            consoleSpy.mockRestore();
        });
    });
});
