import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// STABLE MOCKS
const { mockClient } = vi.hoisted(() => {
    const mockCollection = {
        getAll: vi.fn(() => new Map()),
        items: vi.fn(() => []),
        set: vi.fn(),
        delete: vi.fn(),
        on: vi.fn(() => vi.fn()),
        clear: vi.fn(),
    };
    return {
        mockClient: {
            getCollection: vi.fn(() => mockCollection),
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

        expect(mockClient.getCollection).toHaveBeenCalledWith('items', ItemSchema);
        expect(result.current.items).toBeDefined();
        expect(typeof result.current.set).toBe('function');
        expect(typeof result.current.delete).toBe('function');
    });

    it('should subscribe to collection changes on mount', () => {
        const mockCollection = mockClient.getCollection();
        renderHook(() => useCollection('items', ItemSchema));

        expect(mockCollection.on).toHaveBeenCalledWith('change', expect.any(Function));
    });

    it('should call set on the collection', () => {
        const mockCollection = mockClient.getCollection();
        const { result } = renderHook(() => useCollection('items', ItemSchema));

        act(() => {
            result.current.set('id1', { id: 'id1', name: 'Test' });
        });

        expect(mockCollection.set).toHaveBeenCalledWith('id1', { id: 'id1', name: 'Test' });
    });

    it('should call delete on the collection', () => {
        const mockCollection = mockClient.getCollection();
        const { result } = renderHook(() => useCollection('items', ItemSchema));

        act(() => {
            result.current.delete('id1');
        });

        expect(mockCollection.delete).toHaveBeenCalledWith('id1');
    });
});
