/**
 * NMeshed v2 - Engine Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncEngine } from '../src/engine';
import { encodeValue } from '../src/protocol';
import { InMemoryAdapter } from '../src/adapters/InMemoryAdapter';

describe('SyncEngine', () => {
    let engine: SyncEngine;
    let storage: InMemoryAdapter;

    beforeEach(() => {
        storage = new InMemoryAdapter();
        engine = new SyncEngine('test-peer', storage, false);
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

    describe('persistence', () => {
        it('should load pending ops from storage on init', async () => {
            // Setup storage with pending ops
            // queue::TIMESTAMP::KEY
            const timestamp = 1000;
            const key = 'queued-key';
            const value = 'queued-value';
            const wireVal = encodeValue(value);

            // Pending op key format: queue::{timestamp}::{key}
            // Actually implementation uses: queue::{timestamp}::{key}
            // Let's verify implementation in engine.ts? 
            // It prefixes constants: PENDING_PREFIX = 'queue::'.

            const storageKey = `queue::${timestamp}::${key}`;
            const opData = { key, value, timestamp, peerId: 'test-peer' };
            // Engine stores encoded Op? 
            // "this.storage.set(queueKey, encodeValue(op))"

            await storage.set(storageKey, encodeValue(opData));

            // Create new engine with this storage
            const newEngine = new SyncEngine('test-peer', storage, false);
            await newEngine.loadFromStorage();

            expect(newEngine.getPendingCount()).toBe(1);
            const drained = newEngine.drainPending();
            expect(drained[0].key).toBe(key);
            // The value we stored WAS the opData object, so that's what we get back
            expect(drained[0].value).toEqual(opData);
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

        it('should delegate loadSnapshot to core if attached', () => {
            const mockCore = {
                applyLocalOp: vi.fn(),
                mergeRemoteDelta: vi.fn(),
                getValue: vi.fn(),
                getAllValues: vi.fn(),
                getBinarySnapshot: vi.fn(),
                loadSnapshot: vi.fn(),
                forEach: vi.fn(),
            };

            engine.attachCore(mockCore as any);
            engine.loadSnapshot(new Uint8Array([]));
            expect(mockCore.loadSnapshot).toHaveBeenCalled();
        });
    });

    describe('clock synchronization', () => {
        it('should adjust operation timestamps based on clock offset', () => {
            // Apply a 1-hour offset (3600000ms)
            // Server is 1 hour ahead
            const offset = 3600000;
            engine.setClockOffset(offset);

            const now = Date.now();
            engine.set('time-test', 'value');

            // Drain pending to check timestamp
            const ops = engine.drainPending();
            expect(ops[0].timestamp).toBeGreaterThanOrEqual(now + offset);
            expect(ops[0].timestamp).toBeLessThan(now + offset + 1000); // 1s tolerance
        });
    });

    describe('debug mode', () => {
        it('should log when debug is enabled', () => {
            const debugEngine = new SyncEngine('debug-peer', new InMemoryAdapter(), true);
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


    describe('error handling & corruption', () => {
        it('should handle persistence failures gracefully', async () => {
            vi.spyOn(storage, 'set').mockRejectedValue(new Error('Write fail'));
            const spy = vi.spyOn(console, 'error').mockImplementation(() => { });
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

            await engine.set('key', 'val');

            expect(spy).toHaveBeenCalledWith('[NMeshed] Persistence failed', expect.any(Error));
            spy.mockRestore();
            logSpy.mockRestore();
        });

        it('should handle corrupted data in loadFromStorage', async () => {
            const badPayload = new Uint8Array([0xC1]); // Unused MsgPack byte
            await storage.set('key1', badPayload);

            // Re-init engine with debug=true
            engine = new SyncEngine('test-peer', storage, true);

            const spy = vi.spyOn(console, 'log').mockImplementation(() => { });

            await engine.loadFromStorage();

            expect(spy).toHaveBeenCalledWith('[NMeshed Engine]', expect.stringContaining('Failed to decode stored key key1'), expect.any(Error));
            spy.mockRestore();
        });

        it('should delegate invalid snapshot load to log warning', () => {
            const badSnapshot = new Uint8Array([0xC1]);
            // Re-init engine with debug=true
            engine = new SyncEngine('test-peer', storage, true);

            const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
            engine.loadSnapshot(badSnapshot);
            expect(spy).toHaveBeenCalledWith('[NMeshed Engine]', expect.stringContaining('Could not decode snapshot'));
            spy.mockRestore();
        });

        it('should handle corrupted pending op rehydration', async () => {
            await storage.set('queue::invalid', new Uint8Array([0]));
            await storage.set('queue::2000::bad', new Uint8Array([0xC1]));
            const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
            await engine.loadFromStorage();

            expect(engine.getPendingCount()).toBe(0);
            spy.mockRestore();
        });
    });

    // -------------------------------------------------------------------------
    // BUG HUNTING: Edge Case Tests
    // -------------------------------------------------------------------------
    describe('cas (Compare-And-Swap)', () => {
        it('should succeed when expected is null and key does not exist', async () => {
            // Key does not exist => current is undefined
            // Expected is null => Should match "absence"
            const result = await engine.cas('new-key', null, 'new-value');
            expect(result).toBe(true);
            expect(engine.get('new-key')).toBe('new-value');
        });

        it('should FAIL when expected is null but key EXISTS', async () => {
            engine.set('existing', 'old-value');
            const result = await engine.cas('existing', null, 'new-value');
            expect(result).toBe(false);
            expect(engine.get('existing')).toBe('old-value'); // Unchanged
        });

        it('should succeed with matching expected value', async () => {
            engine.set('key', { version: 1 });
            const result = await engine.cas('key', { version: 1 }, { version: 2 });
            expect(result).toBe(true);
            expect(engine.get('key')).toEqual({ version: 2 });
        });

        it('should FAIL with mismatched expected value', async () => {
            engine.set('key', { version: 2 });
            const result = await engine.cas('key', { version: 1 }, { version: 3 });
            expect(result).toBe(false);
            expect(engine.get('key')).toEqual({ version: 2 }); // Unchanged
        });

        it('BUG HUNT: should handle undefined vs null correctly', async () => {
            // Edge case: What if user passes `undefined` as expected?
            // This tests the "unspecified behavior" zone.
            // Expected: undefined should NOT match existing value `null`.
            engine.set('tombstone', null);
            // @ts-ignore - Intentionally testing edge case
            const result = await engine.cas('tombstone', undefined, 'resurrected');
            // Depends on implementation. null should NOT equal undefined.
            // Current impl: if (expected === null) check fails (undefined !== null).
            // Then it goes to JSON.stringify comparison.
            // JSON.stringify(null) = 'null', JSON.stringify(undefined) = undefined (!)
            // This is a potential bug: undefined !== null in JS, but JSON.stringify(undefined) is undefined, not 'undefined'.
            // Actually JSON.stringify(undefined) returns `undefined` (the value), not a string.
            // So comparison: 'null' !== undefined => FAIL. Correct behavior!
            expect(result).toBe(false);
        });
    });

    describe('loadSnapshot edge cases', () => {
        it('should handle empty snapshot gracefully', () => {
            const emptySnapshot = encodeValue({});
            engine.loadSnapshot(emptySnapshot);
            expect(engine.getSnapshot()).toEqual({});
        });

        it('should handle snapshot with null values (tombstones)', () => {
            const snapshot = { alive: 'yes', dead: null };
            const data = encodeValue(snapshot);
            engine.loadSnapshot(data);
            expect(engine.get('alive')).toBe('yes');
            expect(engine.get('dead')).toBeNull();
        });
    });
});
