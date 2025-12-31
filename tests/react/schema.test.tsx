/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { z } from 'zod';
import { useSyncedSchema } from '../../src/react/schema';
import { NMeshedProvider } from '../../src/react/context';
import { createMockClient } from '../test-utils';
import React from 'react';

// Initialize mock client with typed factory
const mockClient = createMockClient();

vi.mock('../../src/client', () => {
    return {
        NMeshedClient: vi.fn(function () { return mockClient; }),
    };
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
    <NMeshedProvider workspaceId="test-ws" token="test-token" debug={false}>
        {children}
    </NMeshedProvider>
);

describe('Schema Hooks', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockClient.on.mockImplementation(() => () => { });
        mockClient.getAllValues.mockReturnValue({});
        vi.spyOn(console, 'warn').mockImplementation(() => { });
        vi.spyOn(console, 'error').mockImplementation(() => { });
    });

    const pointSchema = z.object({
        x: z.number(),
        y: z.number()
    });

    it('useSyncedSchema should validate initial data', () => {
        mockClient.get.mockReturnValue({ x: 10, y: 20 });

        const { result } = renderHook(
            () => useSyncedSchema('cursor', pointSchema, { x: 0, y: 0 }),
            { wrapper }
        );

        expect(result.current[0]).toEqual({ x: 10, y: 20 });
        expect(result.current[2]).toBe(true);
    });

    it('useSyncedSchema should fallback on invalid initial data', () => {
        mockClient.get.mockReturnValue({ x: "invalid", y: 20 });

        const { result } = renderHook(
            () => useSyncedSchema('cursor', pointSchema, { x: 0, y: 0 }),
            { wrapper }
        );

        expect(result.current[0]).toEqual({ x: 0, y: 0 }); // Fallback
        expect(result.current[2]).toBe(false); // Invalid
    });

    it('useSyncedSchema should update on valid op events', () => {
        let opHandler: any;
        mockClient.on.mockImplementation((event, cb) => {
            if (event === 'op') opHandler = cb;
            return () => { };
        });

        const { result } = renderHook(
            () => useSyncedSchema('cursor', pointSchema, { x: 0, y: 0 }),
            { wrapper }
        );

        // Initial default (get returns undefined by default mock)
        expect(result.current[0]).toEqual({ x: 0, y: 0 });

        act(() => {
            if (opHandler) opHandler('cursor', { x: 50, y: 50 });
        });

        expect(result.current[0]).toEqual({ x: 50, y: 50 });
    });

    it('useSyncedSchema should reject invalid updates', () => {
        let opHandler: any;
        mockClient.on.mockImplementation((event, cb) => {
            if (event === 'op') opHandler = cb;
            return () => { };
        });

        const { result } = renderHook(
            () => useSyncedSchema('cursor', pointSchema, { x: 0, y: 0 }),
            { wrapper }
        );

        act(() => {
            if (opHandler) opHandler('cursor', { x: "bad" });
        });

        expect(result.current[0]).toEqual({ x: 0, y: 0 }); // Remains default
        // console.error is mocked in beforeEach
    });

    it('useSyncedSchema should allow local updates via setValue', () => {
        const { result } = renderHook(
            () => useSyncedSchema('cursor', pointSchema, { x: 0, y: 0 }),
            { wrapper }
        );

        act(() => {
            result.current[1]({ x: 100, y: 100 });
        });

        expect(result.current[0]).toEqual({ x: 100, y: 100 });
        expect(mockClient.set).toHaveBeenCalledWith('cursor', { x: 100, y: 100 });
    });
});
