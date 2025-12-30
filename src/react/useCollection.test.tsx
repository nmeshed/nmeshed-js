import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// STABLE MOCKS
const { mockClient } = vi.hoisted(() => {
    const mockCollection = {
        getAll: vi.fn(() => new Map()),
        get: vi.fn((id) => (mockCollection.getAll() as any).get(id)), // Dynamic get
        data: [] as any[],
        asArray: vi.fn(() => (mockCollection as any).data || []),

        set: vi.fn(),
        add: vi.fn(),
        delete: vi.fn(),
        on: vi.fn(() => vi.fn()),
        off: vi.fn(),
        clear: vi.fn(),
        size: 0,
    };

    return {
        mockClient: {
            getCollection: vi.fn(() => mockCollection),
            collection: vi.fn(() => mockCollection),
            get: vi.fn(),
            set: vi.fn(),
            subscribe: vi.fn(() => vi.fn()),
        },
    };
});

vi.mock('./context', () => ({
    useNmeshedContext: () => mockClient,
}));

import { useCollection } from './useCollection';
import { defineSchema } from '../schema/SchemaBuilder';

describe('useCollection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    const ItemSchema = defineSchema({
        id: 'string',
        name: 'string',
    });

    it('should initialize and return collection interface', () => {
        const { result } = renderHook(() => useCollection('items', ItemSchema));
        const [items, actions] = result.current;

        expect(mockClient.collection).toHaveBeenCalledWith('items', ItemSchema);
        expect(actions.map).toBeDefined();
        expect(Array.isArray(items)).toBe(true);
        expect(typeof actions.set).toBe('function');
        expect(typeof actions.delete).toBe('function');
    });

    it('should subscribe to collection changes on mount', () => {
        const mockCollection = mockClient.collection();
        renderHook(() => useCollection('items', ItemSchema));

        expect(mockCollection.on).toHaveBeenCalledWith('change', expect.any(Function));
    });

    it('should call set on the collection', () => {
        const mockCollection = mockClient.collection();
        const { result } = renderHook(() => useCollection('items', ItemSchema));

        act(() => {
            const [, { set }] = result.current;
            set('id1', { id: 'id1', name: 'Test' } as any);
        });

        expect(mockCollection.set).toHaveBeenCalledWith('id1', { id: 'id1', name: 'Test' });
    });

    it('should call add on the collection', () => {
        const mockCollection = mockClient.collection();
        const { result } = renderHook(() => useCollection('items', ItemSchema));

        act(() => {
            const [, { add }] = result.current;
            add('id1', { id: 'id1', name: 'Test' } as any);
        });

        expect(mockCollection.add).toHaveBeenCalledWith('id1', { id: 'id1', name: 'Test' });
    });

    it('should call delete on the collection', () => {

        const mockCollection = mockClient.collection();
        const { result } = renderHook(() => useCollection('items', ItemSchema));

        act(() => {
            const [, { delete: del }] = result.current;
            del('id1');
        });

        expect(mockCollection.delete).toHaveBeenCalledWith('id1');
    });

    it('returns items as array with ids', () => {
        const testMap = new Map([
            ['1', { name: 'A' }],
            ['2', { name: 'B' }],
        ]);
        const testArray = [{ name: 'A', id: '1' }, { name: 'B', id: '2' }];
        const mockCollection = mockClient.collection();
        (mockCollection as any).data = testArray;
        (mockCollection.getAll as any).mockReturnValue(testMap);

        const { result } = renderHook(() => useCollection('items', ItemSchema));
        const [items] = result.current;

        expect(items).toHaveLength(2);
        expect(items).toEqual([{ name: 'A', id: '1' }, { name: 'B', id: '2' }]);
    });

    it('get returns item by id from the actions', () => {
        const testMap = new Map([
            ['1', { name: 'A' }],
        ]);
        const mockCollection = mockClient.collection();
        (mockCollection.getAll as any).mockReturnValue(testMap);

        const { result } = renderHook(() => useCollection('items', ItemSchema));
        const [, { get }] = result.current;
        expect(get('1')).toEqual({ name: 'A' });
    });

    it('clear calls collection.clear', () => {
        const mockCollection = mockClient.collection();
        const { result } = renderHook(() => useCollection('items', ItemSchema));

        act(() => {
            const [, { clear }] = result.current;
            clear();
        });

        expect(mockCollection.clear).toHaveBeenCalled();
    });

});
