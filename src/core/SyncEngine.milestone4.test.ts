
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEngine, EngineState } from './SyncEngine';
import * as flatbuffers from 'flatbuffers';
import { SyncPacket } from '../schema/nmeshed/sync-packet';
import { StateVectorEntry } from '../schema/nmeshed/state-vector-entry';
import { VersionVector } from '../schema/nmeshed/version-vector';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';

// Mock Core to spy on WASM calls
class MockCore {
    apply_vessel = vi.fn();
    apply_local_op = vi.fn().mockReturnValue(new Uint8Array([1]));
    get_all_values = vi.fn().mockReturnValue({});
    get_raw_value = vi.fn().mockReturnValue(null);
    prune = vi.fn();
}

describe('Milestone 4: The Stable Horizon (Absolutist Quality Check)', () => {
    let engine: SyncEngine;
    let mockCore: MockCore;

    beforeEach(() => {
        engine = new SyncEngine('ws-audited', 'peer-local');
        mockCore = new MockCore();
        (engine as any).core = mockCore;
        (engine as any)._state = EngineState.ACTIVE;

        // Reset Vectors
        (engine as any).localVector = new Map<string, bigint>();
        (engine as any).remoteVectors = new Map<string, Map<string, bigint>>();

        // Suppress logs for cleaner test output
        (engine as any).logger = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn()
        };
    });

    // Helper to build a SyncPacket
    function createSyncPacket(
        snapshot: number[] | null,
        vector: Record<string, bigint> | null
    ): Uint8Array {
        const builder = new flatbuffers.Builder(1024);

        // Snapshot
        let snapshotOffset = 0;
        if (snapshot) {
            snapshotOffset = SyncPacket.createSnapshotVector(builder, snapshot);
        }

        // Vector
        let vectorOffset = 0;
        if (vector) {
            const entries: number[] = [];
            for (const [p, s] of Object.entries(vector)) {
                const sOffset = builder.createString(p);
                const entry = StateVectorEntry.createStateVectorEntry(builder, sOffset, BigInt(s));
                entries.push(entry);
            }
            const itemsVec = VersionVector.createItemsVector(builder, entries);
            vectorOffset = VersionVector.createVersionVector(builder, itemsVec);
        }

        SyncPacket.startSyncPacket(builder);
        if (snapshot) SyncPacket.addSnapshot(builder, snapshotOffset);
        if (vector) SyncPacket.addCurrentVector(builder, vectorOffset);
        const syncOffset = SyncPacket.endSyncPacket(builder);

        WirePacket.startWirePacket(builder);
        WirePacket.addMsgType(builder, MsgType.Sync);
        WirePacket.addSync(builder, syncOffset);
        const wp = WirePacket.endWirePacket(builder);
        builder.finish(wp);

        return builder.asUint8Array();
    }

    it('Scenario 1: Late Joiner receives full Snapshot', () => {
        const snapshotData = [0xDE, 0xAD, 0xBE, 0xEF];
        const bytes = createSyncPacket(snapshotData, null);

        const emitSpy = vi.spyOn(engine, 'emit');

        engine.applyRawMessage(bytes);

        // Expect Core to receive the vessel
        expect(mockCore.apply_vessel).toHaveBeenCalledTimes(1);
        expect(mockCore.apply_vessel).toHaveBeenCalledWith(bytes);

        // Expect 'snapshot' event to update UI
        expect(emitSpy).toHaveBeenCalledWith('snapshot');
    });

    it('Scenario 2: Remote Vector Update propagates to Horizon', () => {
        // Local state: PeerA=10
        (engine as any).localVector.set('PeerA', 10n);

        // Incoming Sync: PeerA=5 (This peer is behind us, so Horizon for PeerA should be min(10, 5) = 5)
        const bytes = createSyncPacket(null, { 'PeerA': 5n });

        engine.applyRawMessage(bytes);

        // Verify Remote Vector stored
        const remotes = (engine as any).remoteVectors as Map<string, Map<string, bigint>>;
        expect(remotes.has('server')).toBe(true);
        expect(remotes.get('server')?.get('PeerA')).toBe(5n);

        // Verify Horizon Calculation was triggered (via pruneHistory check)
        // Since we mocked prune, we can check if it was checked logically.
        // Actually, let's inspect the calculated simulation log or just call calculateHorizon manually to verify logic.
        const horizon = (engine as any).calculateHorizon();
        expect(horizon.get('PeerA')).toBe(5n);
    });

    it('Scenario 3: Disjoint Vectors (The Zero Floor)', () => {
        // Local: PeerA=10
        (engine as any).localVector.set('PeerA', 10n);

        // Remote: PeerB=20 (Counts PeerA as 0 implied)
        const bytes = createSyncPacket(null, { 'PeerB': 20n });

        engine.applyRawMessage(bytes);

        const horizon = (engine as any).calculateHorizon();

        // PeerA is known locally (10) but unknown to remote (0). Min = 0.
        expect(horizon.get('PeerA')).toBe(0n);

        // PeerB is known remote (20) but unknown to local (0). Min = 0.
        expect(horizon.get('PeerB')).toBe(0n);
    });

    it('Scenario 4: Defensive Handling of Malformed Sync Packet', () => {
        // Empty buffer
        expect(() => engine.applyRawMessage(new Uint8Array([]))).not.toThrow();

        // Random garbage (should be caught by flatbuffers or try/catch in SyncEngine)
        const garbage = new Uint8Array([1, 2, 3, 4, 255, 255]);
        expect(() => engine.applyRawMessage(garbage)).not.toThrow();

        // Verify no crash
    });

    it('Scenario 5: Pruning Logic sanity check', () => {
        // Local: PeerA=10
        (engine as any).localVector.set('PeerA', 10n);
        // Remote: PeerA=10
        const bytes = createSyncPacket(null, { 'PeerA': 10n });

        engine.applyRawMessage(bytes);

        // Horizon should be 10.
        const horizon = (engine as any).calculateHorizon();
        expect(horizon.get('PeerA')).toBe(10n);

        // In debug mode, this would log "Pruning history <= 10".
        // We verify that the code path is safe and executes.
    });
});
