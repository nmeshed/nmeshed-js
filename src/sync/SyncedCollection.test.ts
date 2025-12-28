import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncedCollection } from './SyncedCollection';
import { EventEmitter } from '../utils/EventEmitter';

// ----------------------------------------------------------------------------
// Mock SyncEngine
// ----------------------------------------------------------------------------
class MockSyncEngine extends EventEmitter<any> {
    public registerSchema = vi.fn();
    public getAllValues = vi.fn().mockReturnValue({});
    public set = vi.fn();

    // Simulate incoming op
    public simulateOp(key: string, value: any) {
        this.emit('op', key, value, false);
    }
}

describe('SyncedCollection', () => {
    let mockEngine: MockSyncEngine;
    let collection: SyncedCollection<any>;

    beforeEach(() => {
        mockEngine = new MockSyncEngine();
        collection = new SyncedCollection(mockEngine as any, 'items');
    });

    it('should register schema if provided', () => {
        const schema = { encode: vi.fn(), decode: vi.fn() };
        new SyncedCollection(mockEngine as any, 'schema-items', schema as any);
        expect(mockEngine.registerSchema).toHaveBeenCalledWith('schema-items:', schema);
    });

    it('should initialize with fullSync from engine', () => {
        mockEngine.getAllValues.mockReturnValue({
            'items:1': { id: 1, name: 'one' },
            'items:2': { id: 2, name: 'two' },
            'other:3': { id: 3, name: 'other' }
        });

        const col = new SyncedCollection(mockEngine as any, 'items');
        expect(col.getAll().size).toBe(2);
        expect(col.get('1')).toEqual({ id: 1, name: 'one' });
        expect(col.get('2')).toEqual({ id: 2, name: 'two' });
        expect(col.get('3')).toBeUndefined();
    });

    it('should handle incoming add ops', () => {
        const onAdd = vi.fn();
        const onChange = vi.fn();
        collection.on('add', onAdd);
        collection.on('change', onChange);

        mockEngine.simulateOp('items:new', { id: 'new' });

        expect(collection.get('new')).toEqual({ id: 'new' });
        expect(onAdd).toHaveBeenCalledWith('items:new', { id: 'new' });
        expect(onChange).toHaveBeenCalled();
    });

    it('should handle incoming update ops', () => {
        // Pre-populate
        mockEngine.getAllValues.mockReturnValue({ 'items:1': { val: 1 } });
        collection = new SyncedCollection(mockEngine as any, 'items');

        const onUpdate = vi.fn();
        collection.on('update', onUpdate);

        mockEngine.simulateOp('items:1', { val: 2 });

        expect(collection.get('1')).toEqual({ val: 2 });
        expect(onUpdate).toHaveBeenCalledWith('items:1', { val: 2 });
    });

    it('should handle incoming remove ops (null value)', () => {
        mockEngine.getAllValues.mockReturnValue({ 'items:1': { val: 1 } });
        collection = new SyncedCollection(mockEngine as any, 'items');

        const onRemove = vi.fn();
        collection.on('remove', onRemove);

        mockEngine.simulateOp('items:1', null);

        expect(collection.get('1')).toBeUndefined();
        expect(onRemove).toHaveBeenCalledWith('items:1');
    });

    it('should ignore ops for other prefixes', () => {
        const onAdd = vi.fn();
        collection.on('add', onAdd);

        mockEngine.simulateOp('other:1', { val: 1 });

        expect(collection.getAll().size).toBe(0);
        expect(onAdd).not.toHaveBeenCalled();
    });

    it('should proxy set calls to engine', () => {
        collection.set('123', { data: 'test' });
        expect(mockEngine.set).toHaveBeenCalledWith('items:123', { data: 'test' }, undefined);
    });

    it('should proxy delete calls to engine', () => {
        collection.delete('123');
        expect(mockEngine.set).toHaveBeenCalledWith('items:123', null);
    });

    it('should clear all items', () => {
        mockEngine.getAllValues.mockReturnValue({
            'items:1': 1,
            'items:2': 2
        });
        collection = new SyncedCollection(mockEngine as any, 'items');

        collection.clear();

        expect(mockEngine.set).toHaveBeenCalledWith('items:1', null);
        expect(mockEngine.set).toHaveBeenCalledWith('items:2', null);
    });
});
