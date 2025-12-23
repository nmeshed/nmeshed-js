/**
 * @file GameClient.ts
 * @brief High-level client for game-like use cases with WASM integration.
 *
 * GameClient extends MeshClient with:
 * - Automatic WASM initialization
 * - SyncedMap factory method
 * - Auto-snapshot for new peers
 *
 * @example
 * ```typescript
 * import { GameClient } from 'nmeshed/game';
 *
 * const client = new GameClient({
 *     workspaceId: 'game-room',
 *     token: 'jwt',
 *     wasm: true,
 *     autoSnapshot: true,
 * });
 *
 * await client.connect();
 * const entities = client.createSyncedMap<Entity>('entities', config);
 * ```
 */

import { MeshClient } from '../mesh/MeshClient';
import type { MeshClientConfig } from '../mesh/types';
import { SyncedMap, createSyncedMap, SyncedMapConfig } from '../sync/SyncedMap';
import { logger } from '../utils/Logger';

/**
 * Configuration for GameClient.
 */
export interface GameClientConfig extends MeshClientConfig {
    /** Auto-initialize WASM module before connecting. */
    wasm?: boolean;

    /** Path to WASM file (default: '/nmeshed_core_bg.wasm'). */
    wasmPath?: string;

    /** Auto-send SyncedMap state to new peers. */
    autoSnapshot?: boolean;

    /** Debounce time for auto-snapshots (default: 100ms). */
    snapshotThrottle?: number;

    /** Target tick rate for fixed-timestep helpers (future use). */
    tickRate?: number;
}

/**
 * High-level client for game-like use cases.
 *
 * Extends MeshClient with:
 * - Automatic WASM initialization
 * - SyncedMap factory with auto-registration
 * - Auto-snapshot for peer hydration
 */
export class GameClient extends MeshClient {
    private gameConfig: GameClientConfig;
    private syncedMaps: Map<string, SyncedMap<unknown>> = new Map();
    private snapshotThrottleTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

    constructor(config: GameClientConfig) {
        super(config);
        this.gameConfig = {
            wasmPath: '/nmeshed_core_bg.wasm',
            autoSnapshot: false,
            snapshotThrottle: 100,
            tickRate: 60,
            ...config,
        };

        // Setup auto-snapshot on peer join
        if (this.gameConfig.autoSnapshot) {
            this.setupAutoSnapshot();
        }
    }

    /**
     * Connects to the mesh network.
     * If `wasm: true`, initializes WASM before connecting.
     */
    public override async connect(): Promise<void> {
        if (this.gameConfig.wasm) {
            logger.mesh('GameClient: Initializing WASM...');
            await super.connect(async () => {
                // Dynamic import to avoid SSR issues
                const { default: init } = await import('../wasm/nmeshed_core.js');
                await init({ module_or_path: this.gameConfig.wasmPath });
                logger.mesh('GameClient: WASM initialized');
            });
        } else {
            await super.connect();
        }
    }

    /**
     * Creates and registers a SyncedMap.
     * Registered maps participate in auto-snapshot.
     */
    public createSyncedMap<T>(
        namespace: string,
        config: SyncedMapConfig<T>
    ): SyncedMap<T> {
        const map = createSyncedMap<T>(this as unknown as MeshClient, namespace, config);
        this.syncedMaps.set(namespace, map as SyncedMap<unknown>);
        return map;
    }

    /**
     * Unregisters a SyncedMap.
     */
    public unregisterSyncedMap(namespace: string): void {
        const map = this.syncedMaps.get(namespace);
        if (map) {
            map.destroy();
            this.syncedMaps.delete(namespace);
        }
    }

    /**
     * Returns all registered SyncedMaps.
     */
    public getSyncedMaps(): Map<string, SyncedMap<unknown>> {
        return this.syncedMaps;
    }

    /**
     * Sends snapshots of all registered SyncedMaps to a peer.
     */
    public sendSnapshotToPeer(peerId: string): void {
        // Throttle to avoid spamming on rapid joins
        const throttleKey = `snapshot-${peerId}`;
        const existing = this.snapshotThrottleTimers.get(throttleKey);
        if (existing) {
            clearTimeout(existing);
        }

        this.snapshotThrottleTimers.set(
            throttleKey,
            setTimeout(() => {
                this.snapshotThrottleTimers.delete(throttleKey);

                for (const [namespace, map] of this.syncedMaps) {
                    if (map.size > 0) {
                        logger.mesh(`GameClient: Sending snapshot (${namespace}) to ${peerId}`);
                        map.sendSnapshotTo(peerId);
                    }
                }
            }, this.gameConfig.snapshotThrottle)
        );
    }

    private setupAutoSnapshot(): void {
        this.on('peerJoin', (peerId: string) => {
            logger.mesh(`GameClient: Peer ${peerId} joined, sending auto-snapshot`);
            this.sendSnapshotToPeer(peerId);
        });
    }

    // ============================================
    //           FIXED-TIMESTEP TICK LOOP
    // ============================================

    private tickCallbacks: Set<(dt: number) => void> = new Set();
    private animationFrameId: number | null = null;
    private lastTickTime: number = 0;
    private accumulator: number = 0;
    private _isRunning: boolean = false;

    /**
     * Returns true if the tick loop is running.
     */
    public get isRunning(): boolean {
        return this._isRunning;
    }

    /**
     * Registers a callback to be called on each fixed-timestep tick.
     * Returns an unsubscribe function.
     *
     * @param callback - Function called with delta time in seconds
     * @example
     * ```typescript
     * const unsub = client.onTick((dt) => {
     *     updatePhysics(dt);
     *     syncEntities();
     * });
     * ```
     */
    public onTick(callback: (dt: number) => void): () => void {
        this.tickCallbacks.add(callback);
        return () => this.tickCallbacks.delete(callback);
    }

    /**
     * Starts the fixed-timestep loop.
     * Automatically called on connect() if tickRate is set.
     */
    public startLoop(): void {
        if (this._isRunning) return;
        if (!this.gameConfig.tickRate || this.gameConfig.tickRate <= 0) {
            logger.mesh('GameClient: Cannot start loop without valid tickRate');
            return;
        }

        this._isRunning = true;
        this.lastTickTime = performance.now();
        this.accumulator = 0;

        const frameMs = 1000 / this.gameConfig.tickRate;

        const loop = (now: number) => {
            if (!this._isRunning) return;

            const deltaMs = now - this.lastTickTime;
            this.lastTickTime = now;
            this.accumulator += deltaMs;

            // Fixed timestep: drain accumulator in fixed chunks
            while (this.accumulator >= frameMs) {
                const dt = frameMs / 1000; // Convert to seconds
                for (const callback of this.tickCallbacks) {
                    try {
                        callback(dt);
                    } catch (e) {
                        console.error('[GameClient] Error in tick callback:', e);
                    }
                }
                this.accumulator -= frameMs;
            }

            this.animationFrameId = requestAnimationFrame(loop);
        };

        this.animationFrameId = requestAnimationFrame(loop);
        logger.mesh(`GameClient: Tick loop started at ${this.gameConfig.tickRate} Hz`);
    }

    /**
     * Stops the fixed-timestep loop.
     */
    public stopLoop(): void {
        if (!this._isRunning) return;

        this._isRunning = false;
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        logger.mesh('GameClient: Tick loop stopped');
    }

    /**
     * Cleans up all resources.
     */
    public override destroy(): void {
        this.stopLoop();
        this.tickCallbacks.clear();

        for (const map of this.syncedMaps.values()) {
            map.destroy();
        }
        this.syncedMaps.clear();

        for (const timer of this.snapshotThrottleTimers.values()) {
            clearTimeout(timer);
        }
        this.snapshotThrottleTimers.clear();

        super.destroy();
    }
}

