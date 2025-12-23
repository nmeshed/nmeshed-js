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

    /**
     * Cleans up all resources.
     */
    public override destroy(): void {
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
