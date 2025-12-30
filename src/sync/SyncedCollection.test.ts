import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncedCollection } from './SyncedCollection';
import { SyncEngine } from '../core/SyncEngine';
import { defineSchema } from '../schema/SchemaBuilder';

import { MockSyncEngine } from '../test-utils/mocks';

describe('SyncedCollection', () => {
    let mockEngine: MockSyncEngine;
    let collection: SyncedCollection<any>;

    beforeEach(() => {
        mockEngine = new MockSyncEngine();
        // Spy on methods to assert calls
        vi.spyOn(mockEngine, 'on');
        vi.spyOn(mockEngine, 'registerSchema');
        vi.spyOn(mockEngine, 'getSchema');
        vi.spyOn(mockEngine, 'forEach');
        vi.spyOn(mockEngine, 'set');

        collection = new SyncedCollection(mockEngine as any, 'items:');
    });

    it('should initialize and register schema if provided', () => {
        const schema = defineSchema({ name: 'string' });
        new SyncedCollection(mockEngine as any, 'users:', schema);
        expect(mockEngine.registerSchema).toHaveBeenCalledWith('users:', schema);
    });

    it('should perform fullSync on creation', () => {
        mockEngine.forEach.mockImplementation((cb: any) => {
            cb({ name: 'Item 1' }, 'items:1');
        });
        const fresh = new SyncedCollection(mockEngine as any, 'items:');
        expect(fresh.size).toBe(1);
        expect(fresh.get('1')).toEqual({ name: 'Item 1' });
    });

    it('should handle incoming ops for its prefix', () => {
        // Grab the 'op' listener
        const opListener = mockEngine.on.mock.calls.find((call: any) => call[0] === 'op')[1];

        opListener('items:2', { name: 'Item 2' });
        expect(collection.size).toBe(1);
        expect(collection.get('2')).toEqual({ name: 'Item 2' });

        // Update
        opListener('items:2', { name: 'Item 2 Updated' });
        expect(collection.get('2')).toEqual({ name: 'Item 2 Updated' });

        // Remove
        opListener('items:2', null);
        expect(collection.size).toBe(0);
    });

    it('should delegate set/add/delete to engine', () => {
        collection.set('3', { name: 'Item 3' });
        expect(mockEngine.set).toHaveBeenCalledWith('items:3', { name: 'Item 3' }, undefined);

        collection.delete('3');
        expect(mockEngine.set).toHaveBeenCalledWith('items:3', null);
    });

    it('should provide data as array with IDs', () => {
        const opListener = mockEngine.on.mock.calls.find((call: any) => call[0] === 'op')[1];
        opListener('items:1', { name: 'A' });

        const arr = collection.data;
        expect(arr).toEqual([{ name: 'A', id: '1' }]);

        // Cache check
        expect(collection.data).toBe(arr);

        // Invalidate check
        opListener('items:2', { name: 'B' });
        expect(collection.data).not.toBe(arr);
        expect(collection.data).toHaveLength(2);
    });

    it('should handle clear', () => {
        const opListener = mockEngine.on.mock.calls.find((call: any) => call[0] === 'op')[1];
        opListener('items:1', { name: 'A' });
        opListener('items:2', { name: 'B' });

        collection.clear();
        expect(mockEngine.set).toHaveBeenCalledTimes(2);
    });

    it('should handle errors in set/delete and emit error', () => {
        mockEngine.set.mockImplementation(() => { throw new Error('Boom'); });
        const errorListener = vi.fn();
        collection.on('error' as any, errorListener);

        expect(() => collection.set('1', {})).toThrow();
        expect(errorListener).toHaveBeenCalled();
    });

    it('should handle errors in delete and emit error', () => {
        mockEngine.set.mockImplementation(() => { throw new Error('Boom'); });
        const errorListener = vi.fn();
        collection.on('error' as any, errorListener);

        expect(() => collection.delete('1')).toThrow();
        expect(errorListener).toHaveBeenCalled();
    });

    it('should provide getAll, asArray, and version', () => {
        const opListener = mockEngine.on.mock.calls.find((call: any) => call[0] === 'op')[1];
        opListener('items:1', { name: 'A' });

        expect(collection.getAll()).toBeInstanceOf(Map);
        expect(collection.getAll().get('1')).toEqual({ name: 'A' });
        expect(collection.asArray()).toEqual([{ name: 'A', id: '1' }]);
        expect(collection.version).toBeGreaterThan(0);
    });

    it('should filter keys using optional filter function', () => {
        const filterFn = vi.fn((key: string) => !key.startsWith('items:__'));
        const filteredCollection = new SyncedCollection(mockEngine as any, 'items:', undefined, { filter: filterFn });

        // Get the LAST registered listener (for the filteredCollection)
        const opCalls = mockEngine.on.mock.calls.filter((call: any) => call[0] === 'op');
        const opListener = opCalls[opCalls.length - 1][1];

        opListener('items:regular', { name: 'Regular' });
        opListener('items:__system', { name: 'System' });

        expect(filteredCollection.get('regular')).toEqual({ name: 'Regular' });
        expect(filteredCollection.get('__system')).toBeUndefined();
    });


    it('should handle empty prefix for all keys', () => {
        const allKeysCollection = new SyncedCollection(mockEngine as any, '');
        expect(allKeysCollection.size).toBe(0);
    });
});
