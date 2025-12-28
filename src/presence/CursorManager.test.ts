/**
 * @file CursorManager.test.ts
 * @brief Unit tests for CursorManager.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CursorManager } from './CursorManager';

// Mock MeshClient
const createMockClient = () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    return {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            if (!listeners.has(event)) {
                listeners.set(event, new Set());
            }
            listeners.get(event)!.add(handler);
            return () => listeners.get(event)?.delete(handler);
        }),
        emit: (event: string, ...args: unknown[]) => {
            listeners.get(event)?.forEach(h => h(...args));
        },
        sendEphemeral: vi.fn(),
        sendEphemeral: vi.fn(),
        sendMessage: vi.fn(),
    };
};

describe('CursorManager', () => {
    let mockClient: ReturnType<typeof createMockClient>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockClient = createMockClient();
    });

    describe('Construction', () => {
        it('should create with default config', () => {
            const manager = new CursorManager(mockClient as any);
            expect(manager).toBeDefined();
            expect(manager.userId).toBeDefined();
        });

        it('should create with custom config', () => {
            const manager = new CursorManager(mockClient as any, {
                userId: 'my-user',
                namespace: 'custom',
                throttleMs: 32,
                staleTimeoutMs: 10000,
            });
            expect(manager.userId).toBe('my-user');
        });
    });

    describe('sendCursor', () => {
        it('should send cursor position via ephemeral', () => {
            const manager = new CursorManager(mockClient as any, { userId: 'me' });

            manager.sendCursor(100, 200);

            expect(mockClient.sendMessage).toHaveBeenCalledWith(expect.anything());
            // Verify payload content if possible, but for strict binary, we just check call.
            // Or decode and check.
            const call = mockClient.sendMessage.mock.calls[0][0];
            const decoded = JSON.parse(new TextDecoder().decode(call));
            expect(decoded).toEqual({
                type: '__cursor__',
                namespace: 'cursor',
                userId: 'me',
                x: 100,
                y: 200,
                timestamp: expect.any(Number),
            });
        });

        it('should throttle rapid cursor updates', () => {
            const manager = new CursorManager(mockClient as any, { throttleMs: 100 });

            manager.sendCursor(100, 200);
            manager.sendCursor(110, 210);
            manager.sendCursor(120, 220);

            // Only first call should go through due to throttle
            expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
        });

        it('should round coordinates', () => {
            const manager = new CursorManager(mockClient as any, { userId: 'me' });

            manager.sendCursor(100.7, 200.3);

            const call = mockClient.sendMessage.mock.calls[0][0];
            const decoded = JSON.parse(new TextDecoder().decode(call));
            expect(decoded).toEqual(expect.objectContaining({ x: 101, y: 200 }));
        });
    });

    describe('onCursor', () => {
        it('should notify on peer cursor update', () => {
            const manager = new CursorManager(mockClient as any, { userId: 'me' });
            const callback = vi.fn();

            manager.onCursor(callback);

            // Simulate ephemeral message (payload only)
            mockClient.emit('ephemeral', {
                type: '__cursor__',
                namespace: 'cursor',
                userId: 'peer-123',
                x: 50,
                y: 75,
                timestamp: Date.now(),
            });

            expect(callback).toHaveBeenCalledWith('peer-123', 50, 75);
        });

        it('should ignore local user cursor messages', () => {
            const manager = new CursorManager(mockClient as any, { userId: 'me' });
            const callback = vi.fn();

            manager.onCursor(callback);

            mockClient.emit('ephemeral', {
                type: '__cursor__',
                namespace: 'cursor',
                userId: 'me',
                x: 50,
                y: 75,
                timestamp: Date.now(),
            });

            expect(callback).not.toHaveBeenCalled();
            expect(manager.getCursors().size).toBe(0);
        });

        it('should return unsubscribe function', () => {
            const manager = new CursorManager(mockClient as any, { userId: 'me' });
            const callback = vi.fn();

            const unsub = manager.onCursor(callback);
            unsub();

            mockClient.emit('ephemeral', {
                type: '__cursor__',
                namespace: 'cursor',
                userId: 'peer-123',
                x: 50,
                y: 75,
                timestamp: Date.now(),
            });

            expect(callback).not.toHaveBeenCalled();
        });

        it('should ignore messages with wrong namespace', () => {
            const manager = new CursorManager(mockClient as any, { namespace: 'my-namespace', userId: 'me' });
            const callback = vi.fn();

            manager.onCursor(callback);

            mockClient.emit('ephemeral', {
                type: '__cursor__',
                namespace: 'other-namespace',
                userId: 'peer-123',
                x: 50,
                y: 75,
                timestamp: Date.now(),
            });

            expect(callback).not.toHaveBeenCalled();
        });

        it('should ignore non-cursor messages', () => {
            const manager = new CursorManager(mockClient as any);
            const callback = vi.fn();

            manager.onCursor(callback);

            mockClient.emit('ephemeral', {
                type: 'other-type',
                data: 'something',
            });

            expect(callback).not.toHaveBeenCalled();
        });
    });

    describe('getCursors', () => {
        it('should return all cursors', () => {
            const manager = new CursorManager(mockClient as any, { userId: 'me' });

            mockClient.emit('ephemeral', {
                type: '__cursor__',
                namespace: 'cursor',
                userId: 'peer-1',
                x: 10,
                y: 20,
                timestamp: Date.now(),
            });

            mockClient.emit('ephemeral', {
                type: '__cursor__',
                namespace: 'cursor',
                userId: 'peer-2',
                x: 30,
                y: 40,
                timestamp: Date.now(),
            });

            const cursors = manager.getCursors();
            expect(cursors.size).toBe(2);
            expect(cursors.get('peer-1')).toEqual(expect.objectContaining({ x: 10, y: 20 }));
            expect(cursors.get('peer-2')).toEqual(expect.objectContaining({ x: 30, y: 40 }));
        });

        it('should return a copy (not the internal map)', () => {
            const manager = new CursorManager(mockClient as any);

            const cursors1 = manager.getCursors();
            const cursors2 = manager.getCursors();

            expect(cursors1).not.toBe(cursors2);
        });
    });

    describe('getCursor', () => {
        it('should return specific cursor', () => {
            const manager = new CursorManager(mockClient as any, { userId: 'me' });

            mockClient.emit('ephemeral', {
                type: '__cursor__',
                namespace: 'cursor',
                userId: 'peer-1',
                x: 10,
                y: 20,
                timestamp: Date.now(),
            });

            expect(manager.getCursor('peer-1')).toEqual(expect.objectContaining({ x: 10, y: 20 }));
        });

        it('should return undefined for unknown peer', () => {
            const manager = new CursorManager(mockClient as any);
            expect(manager.getCursor('unknown')).toBeUndefined();
        });
    });

    describe('Peer disconnect', () => {
        it('should remove cursor on peer disconnect', () => {
            const manager = new CursorManager(mockClient as any, { userId: 'me' });
            const removeCallback = vi.fn();

            manager.onCursorRemove(removeCallback);

            // Add cursor
            mockClient.emit('ephemeral', {
                type: '__cursor__',
                namespace: 'cursor',
                userId: 'peer-1',
                x: 10,
                y: 20,
                timestamp: Date.now(),
            });

            expect(manager.getCursor('peer-1')).toBeDefined();

            // Peer disconnects
            mockClient.emit('peerDisconnect', 'peer-1');

            expect(manager.getCursor('peer-1')).toBeUndefined();
            expect(removeCallback).toHaveBeenCalledWith('peer-1');
        });

        it('should not call remove callback for unknown peer', () => {
            const manager = new CursorManager(mockClient as any);
            const removeCallback = vi.fn();

            manager.onCursorRemove(removeCallback);
            mockClient.emit('peerDisconnect', 'unknown-peer');

            expect(removeCallback).not.toHaveBeenCalled();
        });
    });

    describe('Error handling', () => {
        it('should catch errors in cursor callbacks', () => {
            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { });
            const manager = new CursorManager(mockClient as any, { userId: 'me' });

            manager.onCursor(() => { throw new Error('Test error'); });

            mockClient.emit('ephemeral', {
                type: '__cursor__',
                namespace: 'cursor',
                userId: 'peer-1',
                x: 10,
                y: 20,
                timestamp: Date.now(),
            });

            expect(consoleError).toHaveBeenCalled();
            consoleError.mockRestore();
        });

        it('should catch errors in remove callbacks', () => {
            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { });
            const manager = new CursorManager(mockClient as any, { userId: 'me' });

            // Add cursor first
            mockClient.emit('ephemeral', {
                type: '__cursor__',
                namespace: 'cursor',
                userId: 'peer-1',
                x: 10,
                y: 20,
                timestamp: Date.now(),
            });

            manager.onCursorRemove(() => { throw new Error('Test error'); });
            mockClient.emit('peerDisconnect', 'peer-1');

            expect(consoleError).toHaveBeenCalled();
            consoleError.mockRestore();
        });
    });

    describe('destroy', () => {
        it('should clean up resources', () => {
            const manager = new CursorManager(mockClient as any, { userId: 'me' });
            const callback = vi.fn();

            manager.onCursor(callback);

            mockClient.emit('ephemeral', {
                type: '__cursor__',
                namespace: 'cursor',
                userId: 'peer-1',
                x: 10,
                y: 20,
                timestamp: Date.now(),
            });

            manager.destroy();

            expect(manager.getCursors().size).toBe(0);
        });
    });

    describe('Edge Cases', () => {
        it('should ignore null data in ephemeral message', () => {
            const manager = new CursorManager(mockClient as any);

            // Simulate null data - should not throw
            mockClient.emit('ephemeral', null);

            expect(manager.getCursors().size).toBe(0);
        });

        it('should ignore non-cursor-type messages', () => {
            const manager = new CursorManager(mockClient as any);

            // Message with different type
            mockClient.emit('ephemeral', {
                type: 'not-a-cursor',
                namespace: 'cursor',
                userId: 'peer-1',
                x: 10,
                y: 20,
                timestamp: Date.now(),
            });

            expect(manager.getCursors().size).toBe(0);
        });

        it('should ignore messages with wrong namespace', () => {
            const manager = new CursorManager(mockClient as any, { namespace: 'custom-ns' });

            mockClient.emit('ephemeral', {
                type: '__cursor__',
                namespace: 'wrong-namespace',
                userId: 'peer-1',
                x: 10,
                y: 20,
                timestamp: Date.now(),
            });

            expect(manager.getCursors().size).toBe(0);
        });
    });
});
