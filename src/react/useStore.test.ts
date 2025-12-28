import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';

// 1. FORENSIC MOCK STABILITY: Use vi.hoisted to ensure a STABLE object reference.
const { mockClient, mockSet } = vi.hoisted(() => {
    const sendOp = vi.fn();
    return {
        mockClient: {
            get: vi.fn(),
            set: sendOp,
            subscribe: vi.fn(() => vi.fn()),
        },
        mockSet: sendOp,
    };
});

// Mock WASM core to prevent OOM
vi.mock('../wasm/nmeshed_core', () => ({
    default: vi.fn(),
    NMeshedCore: vi.fn().mockImplementation(() => ({
        state: {},
        apply_local_op: vi.fn(),
        merge_remote_delta: vi.fn(),
        get_state: vi.fn(() => ({})),
    })),
}));

// 2. STABLE CONTEXT MOCK
vi.mock('./context', () => ({
    useNmeshedContext: () => mockClient,
}));

const { get: mockGet, subscribe: mockSubscribe } = mockClient;

import { useStore } from './useStore';
import { defineSchema } from '../schema/SchemaBuilder';

describe('useStore', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGet.mockReturnValue(undefined);
    });

    const TestSchema = defineSchema({
        title: 'string',
        count: 'int32',
        active: 'boolean',
    });

    describe('Tuple API', () => {
        it('should return [state, setStore, metadata] tuple', () => {
            const { result } = renderHook(() => useStore(TestSchema));

            expect(Array.isArray(result.current)).toBe(true);
            expect(result.current.length).toBe(3);
            expect(typeof result.current[1]).toBe('function');
            expect(typeof result.current[2]).toBe('object');
        });

        it('should provide state as first element', () => {
            const { result } = renderHook(() => useStore(TestSchema));
            const [state] = result.current;

            expect(state).toBeDefined();
            expect(typeof state).toBe('object');
        });
    });

    describe('setStore', () => {
        it('should call set with raw value and schema', () => {
            const { result } = renderHook(() => useStore(TestSchema));
            const [, setStore] = result.current;

            act(() => {
                setStore({ title: 'New Title' });
            });

            expect(mockSet).toHaveBeenCalledTimes(1);
            expect(mockSet).toHaveBeenCalledWith('title', 'New Title', expect.any(Object));
        });

        it('should call set for each field when updating multiple', () => {
            const { result } = renderHook(() => useStore(TestSchema));
            const [, setStore] = result.current;

            act(() => {
                setStore({ title: 'Test', count: 42 });
            });

            expect(mockSet).toHaveBeenCalledTimes(2);
        });

        it('should warn and skip unknown fields', () => {
            const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
            const { result } = renderHook(() => useStore(TestSchema));
            const [, setStore] = result.current;

            act(() => {
                // @ts-expect-error Testing unknown field handling
                setStore({ unknownField: 'value' });
            });

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown field'));
            expect(mockSet).not.toHaveBeenCalled();

            consoleSpy.mockRestore();
        });
    });

    describe('State Reading', () => {
        it('should return decoded values from client', () => {
            mockGet.mockReturnValue('Test Value');

            const { result } = renderHook(() => useStore(TestSchema));
            const [state] = result.current;

            expect(state.title).toBe('Test Value');
        });

        it('should return default values for missing fields', () => {
            mockGet.mockReturnValue(undefined);
            const { result } = renderHook(() => useStore(TestSchema));
            const [state] = result.current;
            expect(state.title).toBe(''); // Default for string
            expect(state.count).toBe(0); // Default for int32
            expect(state.active).toBe(false); // Default for boolean
        });
    });

    describe('Message Handling', () => {
        it('should subscribe to messages on mount', () => {
            renderHook(() => useStore(TestSchema));
            expect(mockSubscribe).toHaveBeenCalledTimes(1);
        });

        it('should unsubscribe on unmount', () => {
            const unsubscribe = vi.fn();
            mockSubscribe.mockReturnValue(unsubscribe);

            const { unmount } = renderHook(() => useStore(TestSchema));
            unmount();

            expect(unsubscribe).toHaveBeenCalled();
        });
    });
});

describe('useStore with Map schema', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGet.mockReturnValue(undefined);
    });

    const TaskSchema = defineSchema({
        id: 'string',
        title: 'string',
    });

    const MapSchema = defineSchema({
        tasks: { type: 'map', schema: TaskSchema.definition },
    });

    it('should pass map values correctly to client.set', () => {
        const { result } = renderHook(() => useStore(MapSchema));
        const [, setStore] = result.current;

        const tasks = {
            't1': { id: 't1', title: 'Task 1' },
            't2': { id: 't2', title: 'Task 2' },
        };

        act(() => {
            setStore({ tasks });
        });

        expect(mockSet).toHaveBeenCalledWith('tasks', tasks, expect.any(Object));

    });
});

describe('Schema Defaults', () => {
    it('should hydrate with schema defaults when data is missing', () => {
        const DefaultSchema = defineSchema({
            list: { type: 'array', itemType: 'string' },
            map: { type: 'map', schema: { val: 'string' } },
            num: 'float32',
            str: 'string'
        });

        const { result } = renderHook(() => useStore(DefaultSchema));
        const [store] = result.current;

        expect(store.list).toEqual([]);
        expect(store.map).toEqual({});
        expect(store.num).toBe(0);
        expect(store.str).toBe('');
    });
});
