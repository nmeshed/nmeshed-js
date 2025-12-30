
import { describe, it, expect, beforeEach } from 'vitest';
import { SyncEngine, EngineState } from './SyncEngine';

// Mock NMeshedClientCore since we don't have WASM in unit tests usually
class MockCore {
    apply_local_op() { return new Uint8Array([1, 2, 3]); } // Dummy delta
    get_all_values() { return {}; }
    get_raw_value() { return null; }
}

const VALID_WS = '00000000-0000-0000-0000-000000000001';
const VALID_PEER = '00000000-0000-0000-0000-000000000010';

describe('SyncEngine Vector Clocks (Milestone 4)', () => {
    let engine: SyncEngine;

    beforeEach(() => {
        engine = new SyncEngine(VALID_WS, VALID_PEER);
        (engine as any).core = new MockCore(); // Inject mock core
        (engine as any)._state = EngineState.ACTIVE; // Force active
    });

    it('should track local vector clock on operations', () => {
        engine.set('foo', 'bar');
        const vector = engine.getLocalVector();
        expect(vector.get(VALID_PEER)).toBeDefined();
        // first op is index 0. Check if map is populated.
        expect(vector.has(VALID_PEER)).toBe(true);
    });

    it('should calculate horizon correctly (min of all vectors)', () => {
        const remoteVec1 = new Map<string, bigint>([
            ['peerA', 10n],
            ['peerB', 5n]
        ]);
        const remoteVec2 = new Map<string, bigint>([
            ['peerA', 8n],
            ['peerB', 20n]
        ]);

        // Mock current local state
        (engine as any).localVector = new Map([['peerA', 100n], ['peerB', 100n]]);

        engine.updateRemoteVector('remote1', remoteVec1);
        engine.updateRemoteVector('remote2', remoteVec2);

        const horizon = (engine as any).calculateHorizon();

        // peerA: min(100, 10, 8) = 8
        // peerB: min(100, 5, 20) = 5
        expect(horizon.get('peerA')).toBe(8n);
        expect(horizon.get('peerB')).toBe(5n);
    });

    it('should default to 0 if a peer is missing in a remote vector', () => {
        const remoteVec1 = new Map<string, bigint>([
            ['peerA', 10n]
            // peerB missing
        ]);

        (engine as any).localVector = new Map([['peerA', 100n], ['peerB', 100n]]);
        engine.updateRemoteVector('remote1', remoteVec1);

        const horizon = (engine as any).calculateHorizon();
        expect(horizon.get('peerA')).toBe(10n);
        expect(horizon.get('peerB')).toBe(0n); // Missing in remote1
    });
});
