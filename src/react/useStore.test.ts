import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';

// 1. FORENSIC MOCK STABILITY: Use vi.hoisted to ensure a STABLE object reference.
// The previous implementation returned a new object literal on every call, 
// triggering an infinite React render loop due to unstable dependencies in useMemo/useEffect.
const { mockClient } = vi.hoisted(() => {
    return {
        mockClient: {
            get: vi.fn(),
            sendOperation: vi.fn(),
            onMessage: vi.fn(() => vi.fn()),
        }
    };
});

// Mock WASM core to prevent OOM during jsdom environment setup
vi.mock('../wasm/nmeshed_core', () => ({
    default: vi.fn(),
    NMeshedCore: vi.fn().mockImplementation(() => ({
        state: {},
        apply_local_op: vi.fn(),
        merge_remote_delta: vi.fn(),
        get_state: vi.fn(() => ({})),
    })),
}));

// 2. STABLE CONTEXT MOCK: Returns the same object reference every time.
vi.mock('./context', () => ({
    useNmeshedContext: () => mockClient,
}));

// Destructure for easy use in tests while maintaining reference stability
const { get: mockGet, sendOperation: mockSendOperation, onMessage: mockOnMessage } = mockClient;



// Import after mocking
import { useStore, UseStoreReturn } from './useStore';
import { defineSchema, SchemaSerializer } from '../schema/SchemaBuilder';

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
        it('should return [state, setStore] tuple', () => {
            const { result } = renderHook(() => useStore(TestSchema));

            expect(Array.isArray(result.current)).toBe(true);
            expect(result.current.length).toBe(2);
            expect(typeof result.current[1]).toBe('function');
        });

        it('should provide state as first element', () => {
            const { result } = renderHook(() => useStore(TestSchema));
            const [state] = result.current;

            expect(state).toBeDefined();
            expect(typeof state).toBe('object');
        });

        it('should provide setStore function as second element', () => {
            const { result } = renderHook(() => useStore(TestSchema));
            const [, setStore] = result.current;

            expect(typeof setStore).toBe('function');
        });
    });

    describe('setStore', () => {
        it('should call sendOperation with encoded value for single field', () => {
            const { result } = renderHook(() => useStore(TestSchema));
            const [, setStore] = result.current;

            act(() => {
                setStore({ title: 'New Title' });
            });

            expect(mockSendOperation).toHaveBeenCalledTimes(1);
            expect(mockSendOperation).toHaveBeenCalledWith('title', expect.any(Uint8Array));
        });

        it('should call sendOperation for each field when updating multiple', () => {
            const { result } = renderHook(() => useStore(TestSchema));
            const [, setStore] = result.current;

            act(() => {
                setStore({ title: 'Test', count: 42 });
            });

            expect(mockSendOperation).toHaveBeenCalledTimes(2);
        });

        it('should encode string values correctly', () => {
            const { result } = renderHook(() => useStore(TestSchema));
            const [, setStore] = result.current;

            act(() => {
                setStore({ title: 'Hello' });
            });

            const encodedArg = mockSendOperation.mock.calls[0][1];
            const decoded = SchemaSerializer.decodeValue('string', encodedArg);
            expect(decoded).toBe('Hello');
        });

        it('should encode int32 values correctly', () => {
            const { result } = renderHook(() => useStore(TestSchema));
            const [, setStore] = result.current;

            act(() => {
                setStore({ count: 123 });
            });

            const encodedArg = mockSendOperation.mock.calls[0][1];
            const decoded = SchemaSerializer.decodeValue('int32', encodedArg);
            expect(decoded).toBe(123);
        });

        it('should encode boolean values correctly', () => {
            const { result } = renderHook(() => useStore(TestSchema));
            const [, setStore] = result.current;

            act(() => {
                setStore({ active: true });
            });

            const encodedArg = mockSendOperation.mock.calls[0][1];
            const decoded = SchemaSerializer.decodeValue('boolean', encodedArg);
            expect(decoded).toBe(true);
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
            expect(mockSendOperation).not.toHaveBeenCalled();

            consoleSpy.mockRestore();
        });
    });

    describe('State Reading', () => {
        it('should decode Uint8Array values from client', () => {
            const encoded = SchemaSerializer.encodeValue('string', 'Test Value');
            mockGet.mockImplementation((key: string) => {
                if (key === 'title') return encoded;
                return undefined;
            });

            const { result } = renderHook(() => useStore(TestSchema));
            const [state] = result.current;

            expect(state.title).toBe('Test Value');
        });

        it('should handle raw values (not Uint8Array) passthrough', () => {
            mockGet.mockImplementation((key: string) => {
                if (key === 'count') return 99; // Raw number, not encoded
                return undefined;
            });

            const { result } = renderHook(() => useStore(TestSchema));
            const [state] = result.current;

            expect(state.count).toBe(99);
        });

        it('should return undefined for failed decoding', () => {
            mockGet.mockImplementation((key: string) => {
                if (key === 'title') return new Uint8Array([0xFF, 0xFF]); // Invalid
                return undefined;
            });

            const { result } = renderHook(() => useStore(TestSchema));
            const [state] = result.current;

            expect(state.title).toBeUndefined();
        });
    });

    describe('Message Handling', () => {
        it('should subscribe to messages on mount', () => {
            renderHook(() => useStore(TestSchema));
            expect(mockOnMessage).toHaveBeenCalledTimes(1);
        });

        it('should unsubscribe on unmount', () => {
            const unsubscribe = vi.fn();
            mockOnMessage.mockReturnValue(unsubscribe);

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

    it('should encode map values correctly', () => {
        const { result } = renderHook(() => useStore(MapSchema));
        const [, setStore] = result.current;

        const tasks = {
            't1': { id: 't1', title: 'Task 1' },
            't2': { id: 't2', title: 'Task 2' },
        };

        act(() => {
            setStore({ tasks });
        });

        expect(mockSendOperation).toHaveBeenCalledWith('tasks', expect.any(Uint8Array));
    });
});
