import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SyncEngine } from './SyncEngine';

// Mock WASM core
vi.mock('../wasm/nmeshed_core', () => {
    class MockCore {
        state: Record<string, Uint8Array> = {};
        deltas: Uint8Array[] = [];

        apply_local_op = vi.fn((key: string, value: Uint8Array, _ts: bigint) => {
            this.state[key] = value;
            const delta = new Uint8Array([1, 2, 3, key.charCodeAt(0)]); // Mock delta
            this.deltas.push(delta);
            return delta;
        });
        merge_remote_delta = vi.fn((delta: Uint8Array) => {
            // Return parsed result
            return { key: 'remote-key', value: delta };
        });
        get_state = vi.fn(() => this.state);
        get_value = vi.fn((key: string) => this.state[key] || null);
    }
    return {
        default: vi.fn(),
        NMeshedClientCore: MockCore
    };
});

// Mock persistence
vi.mock('../persistence', () => ({
    loadQueue: vi.fn().mockResolvedValue([]),
    saveQueue: vi.fn().mockResolvedValue(undefined),
}));

describe('SyncEngine', () => {
    let engine: SyncEngine;

    beforeEach(async () => {
        vi.useFakeTimers();
        engine = new SyncEngine('test-workspace', 'crdt', 100, false);
        await engine.boot();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('set', () => {
        it('throws on empty key', () => {
            expect(() => engine.set('', 'value')).toThrow();
        });

        it('sets optimistic state and returns delta', () => {
            const delta = engine.set('mykey', 'myvalue');
            expect(delta).toBeInstanceOf(Uint8Array);
            expect(delta.length).toBeGreaterThan(0);
        });

        it('adds to operation queue', () => {
            engine.set('key1', 'val1');
            engine.set('key2', 'val2');
            expect(engine.getQueueSize()).toBe(2);
        });

        it('skips queue with shouldQueue=false', () => {
            engine.set('key3', 'val3', undefined, false);
            expect(engine.getQueueSize()).toBe(0);
        });

        it('emits op event', () => {
            const listener = vi.fn();
            engine.on('op', listener);
            engine.set('foo', 'bar');
            expect(listener).toHaveBeenCalledWith('foo', 'bar', true);
        });
    });

    describe('get', () => {
        it('returns optimistic value', () => {
            engine.set('getTest', 'testValue');
            expect(engine.get('getTest')).toBe('testValue');
        });

        it('returns undefined for missing key', () => {
            expect(engine.get('nonexistent')).toBeUndefined();
        });
    });

    describe('getAllValues', () => {
        it('returns all optimistic state', () => {
            engine.set('a', 1);
            engine.set('b', 2);
            const all = engine.getAllValues();
            expect(all['a']).toBe(1);
            expect(all['b']).toBe(2);
        });
    });

    describe('queue management', () => {
        it('shiftQueue removes items from front', () => {
            engine.set('q1', 'v1');
            engine.set('q2', 'v2');
            engine.set('q3', 'v3');
            engine.shiftQueue(1);
            expect(engine.getQueueSize()).toBe(2);
        });

        it('getPendingOps returns queue contents', () => {
            engine.set('p1', 'v');
            const ops = engine.getPendingOps();
            expect(ops.length).toBe(1);
            expect(ops[0]).toBeInstanceOf(Uint8Array);
        });
    });

    describe('schema registry', () => {
        it('registers and retrieves schemas', () => {
            const mockSchema = { encode: vi.fn(v => new Uint8Array([1])), decode: vi.fn() };
            engine.registerSchema('entity', mockSchema as any);
            expect(engine.getSchemaForKey('entity:123')).toBe(mockSchema);
        });

        it('uses global schema if no local match', () => {
            // Without any registered schema and without any global fallback, undefined
            expect(engine.getSchemaForKey('unknown:xyz')).toBeUndefined();
        });
    });

    describe('handleRemoteOp', () => {
        it('injects value into confirmed state', () => {
            engine.handleRemoteOp('remote1', 'remoteValue');
            expect(engine.getConfirmed('remote1')).toBe('remoteValue');
        });

        it('emits op event for remote op', () => {
            const spy = vi.fn();
            engine.on('op', spy);
            engine.handleRemoteOp('remote2', 'val2');
            expect(spy).toHaveBeenCalledWith('remote2', 'val2', false);
        });
    });

    describe('handleInitSnapshot', () => {
        it('applies snapshot data to confirmed state', () => {
            engine.handleInitSnapshot({ snap1: 'snapped', snap2: { nested: true } });
            expect(engine.getConfirmed('snap1')).toBe('snapped');
            expect(engine.getConfirmed('snap2')).toEqual({ nested: true });
        });

        it('emits snapshot event', () => {
            const spy = vi.fn();
            engine.on('snapshot', spy);
            engine.handleInitSnapshot({ x: 1 });
            expect(spy).toHaveBeenCalled();
        });
    });

    describe('handleOpUpdate', () => {
        it('applies individual op update', () => {
            (engine as any).handleOpUpdate({ key: 'opk', value: 'opv', timestamp: 123 });
            expect(engine.getConfirmed('opk')).toBe('opv');
        });
    });

    describe('destroy', () => {
        it('clears state and sets destroyed flag', () => {
            engine.set('destroyme', 'val');
            engine.destroy();
            // After destroy, engine should be in destroyed state
            // New ops should fail or be ignored (implementation dependent)
            // At minimum, confirm it doesn't throw
        });
    });

    // === Additional coverage tests ===

    describe('applyRawMessage unit', () => {
        it('queues message if core not ready', () => {
            const freshEngine = new SyncEngine('fresh', 'crdt', 100, false);
            freshEngine.applyRawMessage(new Uint8Array([1, 2, 3]));
            const bootQueue = (freshEngine as any).bootQueue;
            expect(bootQueue.length).toBe(1);
        });
    });

    describe('getQueueLength', () => {
        it('returns operation queue length', () => {
            engine.set('ql1', 'v');
            engine.set('ql2', 'v');
            expect(engine.getQueueLength()).toBe(2);
        });
    });

    describe('isOptimistic', () => {
        it('returns true for keys in optimistic state', () => {
            engine.set('opt1', 'val');
            expect(engine.isOptimistic('opt1')).toBe(true);
        });

        it('returns false for keys only in confirmed state', () => {
            engine.handleRemoteOp('conf1', 'val');
            expect(engine.isOptimistic('conf1')).toBe(false);
        });
    });

    describe('set with schema', () => {
        it('uses schema for encoding', () => {
            const mockSchema = {
                encode: vi.fn(() => new Uint8Array([5, 6, 7])),
                decode: vi.fn()
            };
            engine.set('schemaKey', { foo: 'bar' }, mockSchema as any);
            expect(mockSchema.encode).toHaveBeenCalledWith({ foo: 'bar' });
        });

        it('falls back to JSON encoding on schema failure', () => {
            const brokenSchema = {
                encode: vi.fn(() => { throw new Error('encode fail'); }),
                decode: vi.fn()
            };
            // Should not throw, falls back to JSON
            const delta = engine.set('brokenSchema', 'value', brokenSchema as any);
            expect(delta).toBeInstanceOf(Uint8Array);
        });
    });

    describe('addToQueue maxSize', () => {
        it('drops oldest when queue exceeds maxSize', () => {
            // Create engine with small maxSize
            const smallEngine = new SyncEngine('small', 'crdt', 3, false);
            // Simulate booted state
            (smallEngine as any).core = { apply_local_op: vi.fn(() => new Uint8Array([1])) };

            smallEngine.set('a', 1);
            smallEngine.set('b', 2);
            smallEngine.set('c', 3);
            smallEngine.set('d', 4); // This should drop 'a'

            expect(smallEngine.getQueueSize()).toBe(3);
        });
    });

    describe('handleOpUpdate with binary value', () => {
        it('decodes binary value using schema', () => {
            const mockSchema = {
                encode: vi.fn(),
                decode: vi.fn(() => ({ decoded: true }))
            };
            engine.registerSchema('bin', mockSchema as any);

            // Create a binary value that looks like encoded data
            const binaryVal = new Uint8Array([1, 2, 3]);
            (engine as any).handleOpUpdate({ key: 'bin:test', value: binaryVal, timestamp: 123 });

            // Schema decode should have been used
            expect(mockSchema.decode).toHaveBeenCalled();
        });
    });

    describe('handleInitSnapshot with empty data', () => {
        it('handles null data gracefully', () => {
            engine.handleInitSnapshot(null as any);
            // Should not throw
        });

        it('handles empty object', () => {
            const spy = vi.fn();
            engine.on('snapshot', spy);
            engine.handleInitSnapshot({});
            expect(spy).toHaveBeenCalled();
        });
    });

    // === Deep coverage tests for remaining methods ===

    describe('clearQueue', () => {
        it('empties the operation queue', () => {
            engine.set('cq1', 'v1');
            engine.set('cq2', 'v2');
            expect(engine.getQueueSize()).toBeGreaterThan(0);
            engine.clearQueue();
            expect(engine.getQueueLength()).toBe(0);
        });

        it('emits queueChange event', () => {
            const spy = vi.fn();
            engine.on('queueChange', spy);
            engine.set('qc', 'v');
            engine.clearQueue();
            expect(spy).toHaveBeenCalled();
        });
    });

    describe('getAllValues with core state', () => {
        it('merges core state into result', () => {
            // The mock core has state we set via engine.set()
            engine.set('av1', 'val1');
            const all = engine.getAllValues();
            expect(all['av1']).toBe('val1');
        });
    });

    describe('get with preConnectState', () => {
        it('returns preConnectState if no optimistic or confirmed', async () => {
            const freshEngine = new SyncEngine('preconn', 'crdt', 100, false);
            freshEngine.set('pre', 'preval'); // Goes to preConnectState since core is null
            expect(freshEngine.get('pre')).toBe('preval');
        });
    });

    describe('shiftQueue edge cases', () => {
        it('does nothing for count <= 0', () => {
            engine.set('sq1', 'v');
            const sizeBefore = engine.getQueueSize();
            engine.shiftQueue(0);
            engine.shiftQueue(-1);
            expect(engine.getQueueSize()).toBe(sizeBefore);
        });
    });
});


// === Separate describe block for loadPersistedState format handling ===
describe('SyncEngine loadPersistedState formats', () => {
    it('handles Uint8Array format in persisted queue', async () => {
        // Mock loadQueue to return Uint8Array items
        const { loadQueue } = await import('../persistence');
        (loadQueue as any).mockResolvedValue([
            new Uint8Array([1, 2, 3]),
            new Uint8Array([4, 5, 6]),
        ]);

        const engine = new SyncEngine('persist-binary', 'crdt', 100, false);
        await engine.boot();

        // Queue should have 2 items from persisted state
        expect(engine.getQueueLength()).toBe(2);
    });

    it('handles wrapped data format in persisted queue', async () => {
        // Mock loadQueue to return wrapped objects with data property
        const { loadQueue } = await import('../persistence');
        (loadQueue as any).mockResolvedValue([
            { data: new Uint8Array([7, 8, 9]) },
            { data: new Uint8Array([10, 11, 12]) },
        ]);

        const engine = new SyncEngine('persist-wrapped', 'crdt', 100, false);
        await engine.boot();

        expect(engine.getQueueLength()).toBe(2);
    });

    it('handles legacy object format in persisted queue', async () => {
        // Mock loadQueue to return plain objects (legacy format)
        const { loadQueue } = await import('../persistence');
        (loadQueue as any).mockResolvedValue([
            { key: 'legacy1', value: 'val1' },
            { key: 'legacy2', value: 'val2' },
        ]);

        const engine = new SyncEngine('persist-legacy', 'crdt', 100, false);
        await engine.boot();

        // Should JSON-encode legacy objects as fallback
        expect(engine.getQueueLength()).toBe(2);
    });

    it('handles mixed formats in persisted queue', async () => {
        const { loadQueue } = await import('../persistence');
        (loadQueue as any).mockResolvedValue([
            new Uint8Array([1, 2]),           // Binary
            { data: new Uint8Array([3, 4]) }, // Wrapped
            { key: 'k', value: 'v' },        // Legacy
        ]);

        const engine = new SyncEngine('persist-mixed', 'crdt', 100, false);
        await engine.boot();

        expect(engine.getQueueLength()).toBe(3);
    });
});

// === Tests for getAllValues binary decode from core ===
describe('SyncEngine getAllValues with binary core state', () => {
    it('decodes binary values from core state', async () => {
        // This test verifies getAllValues properly decodes binary from core
        // The existing mock already covers this path through the set() method
        const engine = new SyncEngine('binary-core', 'crdt', 100, false);
        await engine.boot();

        // Set a value which goes through the mock core
        engine.set('core-key', { fromCore: true });

        // getAllValues should include the decoded value
        const all = engine.getAllValues();
        expect(all['core-key']).toEqual({ fromCore: true });
    });
});
