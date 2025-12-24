/**
 * @file SyncedMap.test.ts
 * @brief Unit tests for SyncedMap reactive state container.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncedMap, createSyncedMap, SyncClient } from './SyncedMap';

// Mock Client
function createMockClient(): SyncClient {
    const listeners: Map<string, Set<(...args: unknown[]) => void>> = new Map();

    return {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            if (!listeners.has(event)) {
                listeners.set(event, new Set());
            }
            listeners.get(event)!.add(handler);
            return () => listeners.get(event)?.delete(handler);
        }),
        broadcast: vi.fn(),
        sendToPeer: vi.fn(),
        // Expose for testing
        _emit: (event: string, ...args: unknown[]) => {
            listeners.get(event)?.forEach(h => h(...args));
        },
    } as unknown as SyncClient & { _emit: (event: string, ...args: unknown[]) => void; broadcast: any; sendToPeer: any };
}

// Simple serialize/deserialize for tests
interface TestEntity {
    id: string;
    x: number;
    y: number;
}

const testConfig = {
    serialize: (e: TestEntity): Uint8Array => {
        const json = JSON.stringify(e);
        return new TextEncoder().encode(json);
    },
    deserialize: (buf: Uint8Array): TestEntity => {
        const json = new TextDecoder().decode(buf);
        return JSON.parse(json);
    },
};

describe('SyncedMap', () => {
    let client: SyncClient & { _emit: (event: string, ...args: unknown[]) => void; broadcast: any; sendToPeer: any };
    let map: SyncedMap<TestEntity>;

    beforeEach(() => {
        client = createMockClient() as SyncClient & { _emit: (event: string, ...args: unknown[]) => void; broadcast: any; sendToPeer: any };
        map = createSyncedMap<TestEntity>(client, 'test-entities', testConfig);
    });

    describe('Map interface', () => {
        it('should set and get values', () => {
            const entity = { id: '1', x: 10, y: 20 };
            map.set('e1', entity);

            expect(map.get('e1')).toEqual(entity);
            expect(map.has('e1')).toBe(true);
            expect(map.size).toBe(1);
        });

        it('should delete values', () => {
            map.set('e1', { id: '1', x: 10, y: 20 });
            expect(map.has('e1')).toBe(true);

            const deleted = map.delete('e1');
            expect(deleted).toBe(true);
            expect(map.has('e1')).toBe(false);
            expect(map.size).toBe(0);
        });

        it('should return false when deleting non-existent key', () => {
            const deleted = map.delete('nonexistent');
            expect(deleted).toBe(false);
        });

        it('should iterate over keys', () => {
            map.set('e1', { id: '1', x: 10, y: 20 });
            map.set('e2', { id: '2', x: 30, y: 40 });

            const keys = [...map.keys()];
            expect(keys).toContain('e1');
            expect(keys).toContain('e2');
        });

        it('should iterate over values', () => {
            const e1 = { id: '1', x: 10, y: 20 };
            const e2 = { id: '2', x: 30, y: 40 };
            map.set('e1', e1);
            map.set('e2', e2);

            const values = [...map.values()];
            expect(values).toContainEqual(e1);
            expect(values).toContainEqual(e2);
        });

        it('should iterate over entries', () => {
            const e1 = { id: '1', x: 10, y: 20 };
            map.set('e1', e1);

            const entries = [...map.entries()];
            expect(entries).toEqual([['e1', e1]]);
        });

        it('should support forEach', () => {
            const e1 = { id: '1', x: 10, y: 20 };
            map.set('e1', e1);

            const callback = vi.fn();
            map.forEach(callback);

            expect(callback).toHaveBeenCalledWith(e1, 'e1', map);
        });

        it('should clear all entries', () => {
            map.set('e1', { id: '1', x: 10, y: 20 });
            map.set('e2', { id: '2', x: 30, y: 40 });
            expect(map.size).toBe(2);

            map.clear();
            expect(map.size).toBe(0);
        });
    });

    describe('Broadcasting', () => {
        it('should broadcast update on set', () => {
            const entity = { id: '1', x: 10, y: 20 };
            map.set('e1', entity);

            expect(client.broadcast).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'update',
                    namespace: 'test-entities',
                    key: 'e1',
                    data: expect.any(String), // Base64 encoded
                })
            );
        });

        it('should broadcast null data on delete', () => {
            map.set('e1', { id: '1', x: 10, y: 20 });
            vi.clearAllMocks();

            map.delete('e1');

            expect(client.broadcast).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'update',
                    namespace: 'test-entities',
                    key: 'e1',
                    data: null,
                })
            );
        });
    });

    describe('Remote changes', () => {
        it('should call onRemoteChange when receiving update', () => {
            const handler = vi.fn();
            map.onRemoteChange(handler);

            const entity = { id: '1', x: 10, y: 20 };
            const bytes = testConfig.serialize(entity);
            const base64 = btoa(String.fromCharCode(...bytes));

            client._emit('ephemeral', {
                type: 'update',
                namespace: 'test-entities',
                key: 'e1',
                data: base64,
            });

            expect(handler).toHaveBeenCalledWith('e1', entity);
            expect(map.get('e1')).toEqual(entity);
        });

        it('should call onRemoteDelete when receiving delete', () => {
            map.set('e1', { id: '1', x: 10, y: 20 });

            const handler = vi.fn();
            map.onRemoteDelete(handler);

            client._emit('ephemeral', {
                type: 'update',
                namespace: 'test-entities',
                key: 'e1',
                data: null,
            });

            expect(handler).toHaveBeenCalledWith('e1');
            expect(map.has('e1')).toBe(false);
        });

        it('should unsubscribe from remote changes', () => {
            const handler = vi.fn();
            const unsubscribe = map.onRemoteChange(handler);

            unsubscribe();

            const entity = { id: '1', x: 10, y: 20 };
            const bytes = testConfig.serialize(entity);
            const base64 = btoa(String.fromCharCode(...bytes));

            client._emit('ephemeral', {
                type: 'update',
                namespace: 'test-entities',
                key: 'e1',
                data: base64,
            });

            expect(handler).not.toHaveBeenCalled();
        });

        it('should ignore messages for other namespaces', () => {
            const handler = vi.fn();
            map.onRemoteChange(handler);

            client._emit('ephemeral', {
                type: 'update',
                namespace: 'other-namespace',
                key: 'e1',
                data: 'abc123',
            });

            expect(handler).not.toHaveBeenCalled();
        });
    });

    describe('Snapshot / Hydration', () => {
        it('should return snapshot of all entries', () => {
            const e1 = { id: '1', x: 10, y: 20 };
            const e2 = { id: '2', x: 30, y: 40 };
            map.set('e1', e1);
            map.set('e2', e2);

            const snapshot = map.snapshot();

            expect(snapshot.size).toBe(2);
            expect(snapshot.has('e1')).toBe(true);
            expect(snapshot.has('e2')).toBe(true);
        });

        it('should hydrate from snapshot', () => {
            const handler = vi.fn();
            map.onRemoteChange(handler);

            const e1 = { id: '1', x: 10, y: 20 };
            const bytes = testConfig.serialize(e1);

            const snapshot = new Map<string, Uint8Array>();
            snapshot.set('e1', bytes);

            map.hydrate(snapshot);

            expect(map.get('e1')).toEqual(e1);
            expect(handler).toHaveBeenCalledWith('e1', e1);
        });

        it('should handle snapshot message from ephemeral channel', () => {
            const handler = vi.fn();
            map.onRemoteChange(handler);

            const e1 = { id: '1', x: 10, y: 20 };
            const bytes = testConfig.serialize(e1);
            const base64 = btoa(String.fromCharCode(...bytes));

            client._emit('ephemeral', {
                type: 'snapshot',
                namespace: 'test-entities',
                entries: [{ key: 'e1', data: base64 }],
            });

            expect(map.get('e1')).toEqual(e1);
            expect(handler).toHaveBeenCalledWith('e1', e1);
        });
    });

    describe('Convergence (CAI Properties)', () => {
        it('should converge to same state regardless of operation order', () => {
            // Create two maps
            const client1 = createMockClient() as SyncClient & { _emit: (event: string, ...args: unknown[]) => void };
            const client2 = createMockClient() as SyncClient & { _emit: (event: string, ...args: unknown[]) => void };
            const map1 = createSyncedMap<TestEntity>(client1, 'entities', testConfig);
            const map2 = createSyncedMap<TestEntity>(client2, 'entities', testConfig);

            const e1 = { id: '1', x: 10, y: 20 };
            const e2 = { id: '2', x: 30, y: 40 };
            const e3 = { id: '3', x: 50, y: 60 };

            // Apply ops in different orders
            map1.set('e1', e1);
            map1.set('e2', e2);
            map1.set('e3', e3);

            map2.set('e3', e3);
            map2.set('e1', e1);
            map2.set('e2', e2);

            // Both should have same final state
            expect(map1.get('e1')).toEqual(map2.get('e1'));
            expect(map1.get('e2')).toEqual(map2.get('e2'));
            expect(map1.get('e3')).toEqual(map2.get('e3'));
            expect(map1.size).toBe(map2.size);
        });

        it('should be idempotent (applying same operation twice has no additional effect)', () => {
            const handler = vi.fn();
            map.onRemoteChange(handler);

            const e1 = { id: '1', x: 10, y: 20 };
            const bytes = testConfig.serialize(e1);
            const base64 = btoa(String.fromCharCode(...bytes));

            // Apply same update twice
            client._emit('ephemeral', {
                type: 'update',
                namespace: 'test-entities',
                key: 'e1',
                data: base64,
            });

            client._emit('ephemeral', {
                type: 'update',
                namespace: 'test-entities',
                key: 'e1',
                data: base64,
            });

            // Handler called twice, but final state is same
            expect(handler).toHaveBeenCalledTimes(2);
            expect(map.get('e1')).toEqual(e1);
            expect(map.size).toBe(1);
        });
    });

    describe('Cleanup', () => {
        it('should clean up listeners on destroy', () => {
            const handler = vi.fn();
            map.onRemoteChange(handler);

            map.destroy();

            expect(map.size).toBe(0);
        });
    });

    describe('External API (Binary Transport)', () => {
        it('should apply remote update via applyRemote', () => {
            const handler = vi.fn();
            map.onRemoteChange(handler);

            const entity = { id: '1', x: 10, y: 20 };
            const bytes = testConfig.serialize(entity);

            map.applyRemote('e1', bytes);

            expect(map.get('e1')).toEqual(entity);
            expect(handler).toHaveBeenCalledWith('e1', entity);
        });

        it('should apply remote deletion via applyRemoteRemove', () => {
            map.set('e1', { id: '1', x: 10, y: 20 });

            const handler = vi.fn();
            map.onRemoteDelete(handler);

            map.applyRemoteRemove('e1');

            expect(map.has('e1')).toBe(false);
            expect(handler).toHaveBeenCalledWith('e1');
        });

        it('should not call onRemoteDelete for non-existent key', () => {
            const handler = vi.fn();
            map.onRemoteDelete(handler);

            map.applyRemoteRemove('nonexistent');

            expect(handler).not.toHaveBeenCalled();
        });

        it('should set value without broadcasting via setLocal', () => {
            const entity = { id: '1', x: 10, y: 20 };
            map.setLocal('e1', entity);

            expect(map.get('e1')).toEqual(entity);
            expect(client.broadcast).not.toHaveBeenCalled();
        });

        it('should include setLocal values in snapshot', () => {
            const entity = { id: '1', x: 10, y: 20 };
            map.setLocal('e1', entity);

            const snapshot = map.snapshot();
            expect(snapshot.has('e1')).toBe(true);
        });
    });

    describe('Binary Transport Callbacks', () => {
        it('should call onBroadcast instead of broadcast when provided', () => {
            const onBroadcast = vi.fn();
            const customMap = createSyncedMap<TestEntity>(client, 'custom', {
                ...testConfig,
                onBroadcast,
            });

            const entity = { id: '1', x: 10, y: 20 };
            customMap.set('e1', entity);

            expect(onBroadcast).toHaveBeenCalledTimes(1);
            expect(onBroadcast.mock.calls[0][0]).toBe('e1');
            // Duck-type check for Uint8Array (cross-realm safe)
            const arg = onBroadcast.mock.calls[0][1];
            expect(arg).toBeDefined();
            expect(typeof arg.byteLength).toBe('number');
            expect(arg.byteLength).toBeGreaterThan(0);
            expect(client.broadcast).not.toHaveBeenCalled();
        });

        it('should call onBroadcast with null for deletions', () => {
            const onBroadcast = vi.fn();
            const customMap = createSyncedMap<TestEntity>(client, 'custom', {
                ...testConfig,
                onBroadcast,
            });

            customMap.setLocal('e1', { id: '1', x: 10, y: 20 });
            vi.clearAllMocks();

            customMap.delete('e1');

            expect(onBroadcast).toHaveBeenCalledWith('e1', null);
        });

        it('should call onSnapshot instead of sendToPeer when provided', () => {
            const onSnapshot = vi.fn();
            const customMap = createSyncedMap<TestEntity>(client, 'custom', {
                ...testConfig,
                onSnapshot,
            });

            customMap.setLocal('e1', { id: '1', x: 10, y: 20 });
            customMap.setLocal('e2', { id: '2', x: 30, y: 40 });

            customMap.sendSnapshotTo('peer-123');

            expect(onSnapshot).toHaveBeenCalledWith('peer-123', expect.any(Map));
            expect(onSnapshot.mock.calls[0][1].size).toBe(2);
            expect(client.sendToPeer).not.toHaveBeenCalled();
        });

        it('should use default ephemeral transport when no onSnapshot provided', () => {
            map.setLocal('e1', { id: '1', x: 10, y: 20 });
            vi.clearAllMocks();

            map.sendSnapshotTo('peer-123');

            expect(client.sendToPeer).toHaveBeenCalledWith(
                'peer-123',
                expect.objectContaining({
                    type: 'snapshot',
                    namespace: 'test-entities',
                    entries: expect.any(Array),
                })
            );
        });
    });

    describe('Error Handling', () => {
        it('should handle deserialization errors gracefully', () => {
            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { });
            const handler = vi.fn();
            map.onRemoteChange(handler);

            // Send invalid bytes that will fail to deserialize
            const invalidBytes = new Uint8Array([0xFF, 0xFE, 0xFD]);
            const base64 = btoa(String.fromCharCode(...invalidBytes));

            client._emit('ephemeral', {
                type: 'update',
                namespace: 'test-entities',
                key: 'e1',
                data: base64,
            });

            expect(handler).not.toHaveBeenCalled();
            expect(consoleError).toHaveBeenCalled();
            consoleError.mockRestore();
        });

        it('should handle errors in onRemoteChange handlers gracefully', () => {
            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { });
            const failingHandler = vi.fn(() => { throw new Error('Handler error'); });
            const successHandler = vi.fn();

            map.onRemoteChange(failingHandler);
            map.onRemoteChange(successHandler);

            const entity = { id: '1', x: 10, y: 20 };
            const bytes = testConfig.serialize(entity);
            const base64 = btoa(String.fromCharCode(...bytes));

            client._emit('ephemeral', {
                type: 'update',
                namespace: 'test-entities',
                key: 'e1',
                data: base64,
            });

            // Both handlers called, error caught
            expect(failingHandler).toHaveBeenCalled();
            expect(successHandler).toHaveBeenCalled();
            expect(consoleError).toHaveBeenCalled();
            consoleError.mockRestore();
        });

        it('should handle errors in onRemoteDelete handlers gracefully', () => {
            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { });
            const failingHandler = vi.fn(() => { throw new Error('Handler error'); });

            map.set('e1', { id: '1', x: 10, y: 20 });
            map.onRemoteDelete(failingHandler);

            client._emit('ephemeral', {
                type: 'update',
                namespace: 'test-entities',
                key: 'e1',
                data: null,
            });

            expect(failingHandler).toHaveBeenCalled();
            expect(consoleError).toHaveBeenCalled();
            consoleError.mockRestore();
        });

        it('should ignore non-object ephemeral messages', () => {
            const handler = vi.fn();
            map.onRemoteChange(handler);

            client._emit('ephemeral', 'not an object');
            client._emit('ephemeral', null);
            client._emit('ephemeral', 123);

            expect(handler).not.toHaveBeenCalled();
        });

        it('should ignore ephemeral messages with wrong type', () => {
            const handler = vi.fn();
            map.onRemoteChange(handler);

            client._emit('ephemeral', {
                type: 'unknown',
                namespace: 'test-entities',
                key: 'e1',
                data: 'abc',
            });

            expect(handler).not.toHaveBeenCalled();
        });
    });

    describe('Unsubscribe behavior', () => {
        it('should unsubscribe from onRemoteDelete', () => {
            map.set('e1', { id: '1', x: 10, y: 20 });

            const handler = vi.fn();
            const unsubscribe = map.onRemoteDelete(handler);

            unsubscribe();

            client._emit('ephemeral', {
                type: 'update',
                namespace: 'test-entities',
                key: 'e1',
                data: null,
            });

            expect(handler).not.toHaveBeenCalled();
        });
    });
});
