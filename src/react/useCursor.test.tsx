/**
 * @file useCursor.test.tsx
 * @brief Unit tests for useCursor React hook.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCursor } from './useCursor';

// Mock CursorManager
vi.mock('../presence/CursorManager', () => ({
    CursorManager: class MockCursorManager {
        private cursors = new Map();
        private cursorCallbacks = new Set<() => void>();
        private removeCallbacks = new Set<() => void>();

        sendCursor = vi.fn();

        onCursor(callback: () => void) {
            this.cursorCallbacks.add(callback);
            return () => this.cursorCallbacks.delete(callback);
        }

        onCursorRemove(callback: () => void) {
            this.removeCallbacks.add(callback);
            return () => this.removeCallbacks.delete(callback);
        }

        getCursors() {
            return new Map(this.cursors);
        }

        getCursor(userId: string) {
            return this.cursors.get(userId);
        }

        destroy = vi.fn();

        // Test helper
        _simulateCursor(userId: string, x: number, y: number) {
            this.cursors.set(userId, { userId, x, y, timestamp: Date.now() });
            this.cursorCallbacks.forEach(cb => cb());
        }

        _simulateRemove(userId: string) {
            this.cursors.delete(userId);
            this.removeCallbacks.forEach(cb => cb());
        }
    },
}));

// Mock MeshClient
const createMockClient = () => ({
    on: vi.fn(() => () => { }),
    sendEphemeral: vi.fn(),
});

describe('useCursor', () => {
    let mockClient: ReturnType<typeof createMockClient>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockClient = createMockClient();
    });

    describe('Initialization', () => {
        it('should initialize with empty cursors', () => {
            const { result } = renderHook(() => useCursor(mockClient as any));

            expect(result.current.cursors.size).toBe(0);
            expect(typeof result.current.sendCursor).toBe('function');
            expect(result.current.manager).toBeDefined();
        });

        it('should handle null client', () => {
            const { result } = renderHook(() => useCursor(null));

            expect(result.current.cursors.size).toBe(0);
            expect(typeof result.current.sendCursor).toBe('function');

            // Should not throw when calling sendCursor
            expect(() => result.current.sendCursor(100, 200)).not.toThrow();
        });

        it('exercises all dummy manager methods when client is null', () => {
            const { result } = renderHook(() => useCursor(null));
            const manager = result.current.manager;

            // Exercise all dummy manager methods
            manager.sendCursor(0, 0);
            const unsubCursor = manager.onCursor(() => { });
            const unsubRemove = manager.onCursorRemove(() => { });
            expect(manager.getCursors().size).toBe(0);
            expect(manager.getCursor('anyone')).toBeUndefined();
            manager.destroy();

            // Clean up subscriptions
            unsubCursor();
            unsubRemove();
        });
    });

    describe('sendCursor', () => {
        it('should delegate to manager', () => {
            const { result } = renderHook(() => useCursor(mockClient as any));

            act(() => {
                result.current.sendCursor(100, 200);
            });

            expect(result.current.manager.sendCursor).toHaveBeenCalledWith(100, 200);
        });
    });

    describe('Cursor updates', () => {
        it('should update cursors on manager callback', () => {
            const { result } = renderHook(() => useCursor(mockClient as any));

            // Simulate a cursor update via the mock manager
            act(() => {
                (result.current.manager as any)._simulateCursor('peer-1', 50, 75);
            });

            expect(result.current.cursors.size).toBe(1);
            expect(result.current.cursors.get('peer-1')).toEqual(
                expect.objectContaining({ x: 50, y: 75 })
            );
        });

        it('should update cursors on remove', () => {
            const { result } = renderHook(() => useCursor(mockClient as any));

            // Add then remove
            act(() => {
                (result.current.manager as any)._simulateCursor('peer-1', 50, 75);
            });

            expect(result.current.cursors.size).toBe(1);

            act(() => {
                (result.current.manager as any)._simulateRemove('peer-1');
            });

            expect(result.current.cursors.size).toBe(0);
        });
    });

    describe('Cleanup', () => {
        it('should destroy manager on unmount', () => {
            const { result, unmount } = renderHook(() => useCursor(mockClient as any));

            const destroySpy = result.current.manager.destroy;

            unmount();

            expect(destroySpy).toHaveBeenCalled();
        });
    });
});
