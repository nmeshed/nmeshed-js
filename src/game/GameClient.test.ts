/**
 * @file GameClient.test.ts
 * @brief Unit tests for GameClient high-level game integration client.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GameClient } from './GameClient';
import type { SyncedMap } from '../sync/SyncedMap';

// Mock the MeshClient parent class
vi.mock('../mesh/MeshClient', () => ({
    MeshClient: class MockMeshClient {
        private listeners: Map<string, Set<(...args: unknown[]) => void>> = new Map();

        constructor() { }

        async connect() {
            // Simulates connect
        }

        on(event: string, handler: (...args: unknown[]) => void) {
            if (!this.listeners.has(event)) {
                this.listeners.set(event, new Set());
            }
            this.listeners.get(event)!.add(handler);
            return () => this.listeners.get(event)?.delete(handler);
        }

        emit(event: string, ...args: unknown[]) {
            this.listeners.get(event)?.forEach(h => h(...args));
        }

        sendEphemeral = vi.fn();
        destroy() { }
    }
}));

// Mock WASM module
vi.mock('../wasm/nmeshed_core.js', () => ({
    default: vi.fn().mockResolvedValue(undefined)
}));

// Simple config for test entities
interface TestEntity {
    id: string;
    x: number;
}

const testConfig = {
    serialize: (e: TestEntity): Uint8Array => {
        return new TextEncoder().encode(JSON.stringify(e));
    },
    deserialize: (buf: Uint8Array): TestEntity => {
        return JSON.parse(new TextDecoder().decode(buf));
    },
};

describe('GameClient', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('Construction', () => {
        it('should create with minimal config', () => {
            const client = new GameClient({
                workspaceId: 'test-room',
                token: 'test-token',
            });

            expect(client).toBeDefined();
        });

        it('should create with full config', () => {
            const client = new GameClient({
                workspaceId: 'test-room',
                token: 'test-token',
                wasm: true,
                wasmPath: '/custom/path.wasm',
                autoSnapshot: true,
                snapshotThrottle: 200,
                tickRate: 30,
            });

            expect(client).toBeDefined();
        });
    });

    describe('Connection', () => {
        it('should connect without WASM when wasm is false', async () => {
            const client = new GameClient({
                workspaceId: 'test-room',
                token: 'test-token',
                wasm: false,
            });

            await client.connect();

            // Should not have called WASM init
            const { default: init } = await import('../wasm/nmeshed_core.js');
            expect(init).not.toHaveBeenCalled();
        });

        it('should initialize WASM when wasm is true', async () => {
            const client = new GameClient({
                workspaceId: 'test-room',
                token: 'test-token',
                wasm: true,
            });

            // Connect should complete without error when WASM is enabled
            await expect(client.connect()).resolves.not.toThrow();
        });
    });

    describe('SyncedMap Factory', () => {
        it('should create and register a SyncedMap', () => {
            const client = new GameClient({
                workspaceId: 'test-room',
                token: 'test-token',
            });

            const map = client.createSyncedMap<TestEntity>('entities', testConfig);

            expect(map).toBeDefined();
            expect(client.getSyncedMaps().has('entities')).toBe(true);
        });

        it('should unregister a SyncedMap', () => {
            const client = new GameClient({
                workspaceId: 'test-room',
                token: 'test-token',
            });

            client.createSyncedMap<TestEntity>('entities', testConfig);
            expect(client.getSyncedMaps().has('entities')).toBe(true);

            client.unregisterSyncedMap('entities');
            expect(client.getSyncedMaps().has('entities')).toBe(false);
        });

        it('should handle unregistering non-existent map', () => {
            const client = new GameClient({
                workspaceId: 'test-room',
                token: 'test-token',
            });

            // Should not throw
            client.unregisterSyncedMap('nonexistent');
        });
    });

    describe('Auto-Snapshot', () => {
        it('should send snapshots when autoSnapshot is enabled and peer joins', async () => {
            vi.useFakeTimers();

            const client = new GameClient({
                workspaceId: 'test-room',
                token: 'test-token',
                autoSnapshot: true,
                snapshotThrottle: 100,
            });

            // Create a map with some data
            const map = client.createSyncedMap<TestEntity>('entities', testConfig);
            map.setLocal('e1', { id: '1', x: 10 });

            // Mock sendSnapshotTo
            const sendSnapshotToSpy = vi.spyOn(map, 'sendSnapshotTo');

            // Simulate peer join
            (client as any).emit('peerJoin', 'peer-123');

            // Fast-forward past throttle
            vi.advanceTimersByTime(150);

            expect(sendSnapshotToSpy).toHaveBeenCalledWith('peer-123');

            vi.useRealTimers();
        });

        it('should throttle rapid peer joins', async () => {
            vi.useFakeTimers();

            const client = new GameClient({
                workspaceId: 'test-room',
                token: 'test-token',
                autoSnapshot: true,
                snapshotThrottle: 100,
            });

            const map = client.createSyncedMap<TestEntity>('entities', testConfig);
            map.setLocal('e1', { id: '1', x: 10 });

            const sendSnapshotToSpy = vi.spyOn(map, 'sendSnapshotTo');

            // Rapid peer joins
            (client as any).emit('peerJoin', 'peer-123');
            (client as any).emit('peerJoin', 'peer-123');
            (client as any).emit('peerJoin', 'peer-123');

            vi.advanceTimersByTime(150);

            // Should only be called once due to throttling
            expect(sendSnapshotToSpy).toHaveBeenCalledTimes(1);

            vi.useRealTimers();
        });

        it('should not send snapshot for empty maps', async () => {
            vi.useFakeTimers();

            const client = new GameClient({
                workspaceId: 'test-room',
                token: 'test-token',
                autoSnapshot: true,
                snapshotThrottle: 100,
            });

            // Empty map
            const map = client.createSyncedMap<TestEntity>('entities', testConfig);
            const sendSnapshotToSpy = vi.spyOn(map, 'sendSnapshotTo');

            (client as any).emit('peerJoin', 'peer-123');
            vi.advanceTimersByTime(150);

            expect(sendSnapshotToSpy).not.toHaveBeenCalled();

            vi.useRealTimers();
        });
    });

    describe('Cleanup', () => {
        it('should destroy all SyncedMaps on destroy', () => {
            const client = new GameClient({
                workspaceId: 'test-room',
                token: 'test-token',
            });

            const map1 = client.createSyncedMap<TestEntity>('entities1', testConfig);
            const map2 = client.createSyncedMap<TestEntity>('entities2', testConfig);

            const destroy1 = vi.spyOn(map1, 'destroy');
            const destroy2 = vi.spyOn(map2, 'destroy');

            client.destroy();

            expect(destroy1).toHaveBeenCalled();
            expect(destroy2).toHaveBeenCalled();
            expect(client.getSyncedMaps().size).toBe(0);
        });
    });

    describe('Fixed-Timestep Tick Loop', () => {
        // Mock requestAnimationFrame and cancelAnimationFrame
        let rafCallbacks: ((time: number) => void)[] = [];
        let rafId = 0;

        beforeEach(() => {
            rafCallbacks = [];
            rafId = 0;

            vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => {
                rafCallbacks.push(cb);
                return ++rafId;
            });

            vi.stubGlobal('cancelAnimationFrame', () => {
                // Just clear
            });

            vi.stubGlobal('performance', {
                now: vi.fn().mockReturnValue(0),
            });
        });

        it('should register and unregister tick callbacks', () => {
            const client = new GameClient({
                workspaceId: 'test-room',
                token: 'test-token',
                tickRate: 60,
            });

            const callback = vi.fn();
            const unsubscribe = client.onTick(callback);

            expect(typeof unsubscribe).toBe('function');

            unsubscribe();
        });

        it('should start and stop the loop', () => {
            const client = new GameClient({
                workspaceId: 'test-room',
                token: 'test-token',
                tickRate: 60,
            });

            expect(client.isRunning).toBe(false);

            client.startLoop();
            expect(client.isRunning).toBe(true);

            client.stopLoop();
            expect(client.isRunning).toBe(false);
        });

        it('should not start loop twice', () => {
            const client = new GameClient({
                workspaceId: 'test-room',
                token: 'test-token',
                tickRate: 60,
            });

            client.startLoop();
            const initialRafCount = rafCallbacks.length;

            client.startLoop(); // Should be no-op
            expect(rafCallbacks.length).toBe(initialRafCount);
        });

        it('should not start loop without valid tickRate', () => {
            const client = new GameClient({
                workspaceId: 'test-room',
                token: 'test-token',
                tickRate: 0,
            });

            client.startLoop();
            expect(client.isRunning).toBe(false);
        });

        it('should call tick callbacks with correct delta time', () => {
            const client = new GameClient({
                workspaceId: 'test-room',
                token: 'test-token',
                tickRate: 60,
            });

            const callback = vi.fn();
            client.onTick(callback);
            client.startLoop();

            // Simulate one frame (16.67ms)
            (performance.now as ReturnType<typeof vi.fn>)
                .mockReturnValueOnce(0)
                .mockReturnValueOnce(16.67);

            if (rafCallbacks.length > 0) {
                rafCallbacks[0](16.67);
            }

            expect(callback).toHaveBeenCalledWith(expect.closeTo(1 / 60, 0.001));
        });

        it('should handle errors in tick callbacks gracefully', () => {
            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { });

            const client = new GameClient({
                workspaceId: 'test-room',
                token: 'test-token',
                tickRate: 60,
            });

            const failingCallback = vi.fn(() => { throw new Error('Test error'); });
            const successCallback = vi.fn();

            client.onTick(failingCallback);
            client.onTick(successCallback);
            client.startLoop();

            (performance.now as ReturnType<typeof vi.fn>)
                .mockReturnValueOnce(0)
                .mockReturnValueOnce(16.67);

            if (rafCallbacks.length > 0) {
                rafCallbacks[0](16.67);
            }

            expect(failingCallback).toHaveBeenCalled();
            expect(successCallback).toHaveBeenCalled();
            expect(consoleError).toHaveBeenCalled();

            consoleError.mockRestore();
        });

        it('should stop loop on destroy', () => {
            const client = new GameClient({
                workspaceId: 'test-room',
                token: 'test-token',
                tickRate: 60,
            });

            client.startLoop();
            expect(client.isRunning).toBe(true);

            client.destroy();
            expect(client.isRunning).toBe(false);
        });

        it('should not call callbacks after stopLoop', () => {
            const client = new GameClient({
                workspaceId: 'test-room',
                token: 'test-token',
                tickRate: 60,
            });

            const callback = vi.fn();
            client.onTick(callback);
            client.startLoop();
            client.stopLoop();

            (performance.now as ReturnType<typeof vi.fn>).mockReturnValue(16.67);

            if (rafCallbacks.length > 0) {
                rafCallbacks[0](16.67);
            }

            expect(callback).not.toHaveBeenCalled();
        });
    });
});

