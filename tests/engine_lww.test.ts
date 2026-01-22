import { describe, expect, test, beforeEach } from 'vitest';
import { SyncEngine } from '../src/engine';
import { InMemoryAdapter } from '../src/adapters/InMemoryAdapter';

describe('SyncEngine LWW & Immutability', () => {
    let engine: SyncEngine;

    beforeEach(() => {
        engine = new SyncEngine('peer_local', new InMemoryAdapter());
    });

    test('Reference Trap: get() should return a copy', async () => {
        const key = 'obj_1';
        const original = { status: 'available' };

        await engine.set(key, original);

        const retrieved = engine.get<{ status: string }>(key);
        expect(retrieved).toBeDefined();
        if (!retrieved) return;

        // Mutate the retrieved object
        retrieved.status = 'mutated';

        // Check internal state via a new get()
        const check = engine.get<{ status: string }>(key);
        expect(check?.status).toBe('available'); // Should NOT be 'mutated'
    });

    test('LWW: Higher timestamp should overwrite local state', async () => {
        const key = 'seat_1';
        const localVal = { holder: 'local' };
        const remoteVal = { holder: 'remote' };
        const t0 = 1000;

        // 1. Local set at T=1000
        // We'll manually inject to control timestamp if API doesn't allow explicit ts on set (set uses Date.now())
        // But applyRemote allows explicit ts.
        // Let's use applyRemote for "Local" simulation if needed, or just set and see.
        // engine.set() uses Date.now(). We can't mock Date.now easily without library.
        // We can explicitly call applyRemote for the "Local" simulation to ensure TS control?
        // But set() is what clients use.

        // Let's use internal state manipulation for setup if public API is restrictive, 
        // or just rely on applyRemote vs applyRemote.

        await engine.applyRemote(key, encodeVal(localVal), 'peer_local', t0);

        // 2. Remote set at T=1050 (Newer)
        await engine.applyRemote(key, encodeVal(remoteVal), 'peer_remote', t0 + 50);

        const result = engine.get<{ holder: string }>(key);
        expect(result?.holder).toBe('remote');
    });

    test('LWW: Older timestamp should be rejected', async () => {
        const key = 'seat_1';
        const localVal = { holder: 'local' };
        const remoteVal = { holder: 'remote_old' };
        const t0 = 1000;

        await engine.applyRemote(key, encodeVal(localVal), 'peer_local', t0);

        // 2. Remote set at T=950 (Older)
        await engine.applyRemote(key, encodeVal(remoteVal), 'peer_remote', t0 - 50);

        const result = engine.get<{ holder: string }>(key);
        expect(result?.holder).toBe('local');
    });

    test('LWW Tie-Breaking: Higher PeerID should win (if logic is >=)', async () => {
        const key = 'tie_1';
        const valA = { id: 'A' };
        const valB = { id: 'B' };
        const t0 = 1000;

        // peer_A vs peer_B. peer_B > peer_A.

        // Case 1: Existing=A, Incoming=B. 
        // Existing(A) >= Incoming(B) ? "peer_A" >= "peer_B" -> False.
        // So Incoming(B) writes. B wins.
        await engine.applyRemote(key, encodeVal(valA), 'peer_A', t0);
        await engine.applyRemote(key, encodeVal(valB), 'peer_B', t0);
        expect(engine.get<{ id: string }>(key)?.id).toBe('B');

        // Case 2: Existing=B, Incoming=A.
        // Existing(B) >= Incoming(A) ? "peer_B" >= "peer_A" -> True.
        // Returns (rejects incoming). B wins.
        await engine.applyRemote(key, encodeVal(valB), 'peer_B', t0);
        await engine.applyRemote(key, encodeVal(valA), 'peer_A', t0);
        expect(engine.get<{ id: string }>(key)?.id).toBe('B');

        // So "Higher String" wins.
        // 'scalper_X' > '000_ADMIN'. Scalper wins.
        // 'scalper_X' > 'ZZZ_ADMIN'. ZZZ wins.
    });

});

// Helper shim since we can't import encodeValue easily if it's not exported or if we want simple test
import { encode } from '@msgpack/msgpack';
function encodeVal(v: any): Uint8Array {
    return encode(v);
}
