
import { describe, it, expect, vi } from 'vitest';
import { decodeMessage, encodeOp, MsgType, encodeValue } from '../src/protocol';
import { SyncEngine } from '../src/engine';
import { InMemoryAdapter } from '../src/adapters/InMemoryAdapter';

describe('Coverage - Protocol Edge Cases', () => {
    it('should return null for empty buffer', () => {
        const msg = decodeMessage(new Uint8Array([]));
        expect(msg).toBeNull();
    });

    it('should return null for garbage buffer (invalid FlatBuffer)', () => {
        const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const msg = decodeMessage(garbage);
        expect(msg).toBeNull();
    });

    it('should handle timestamp=0 correctly in encodeOp', () => {
        const op = encodeOp('k', new Uint8Array([1]), 0n);
        const decoded = decodeMessage(op);
        expect(decoded?.timestamp).toBe(0n);
    });
});

describe('Coverage - Engine Compaction', () => {
    it('should prune old tombstones during compaction', async () => {
        const storage = new InMemoryAdapter();
        // Use debug=true to see logs if needed
        const engine = new SyncEngine('peer1', storage, false);

        // Manually inject old tombstone into state
        // 1. Set a value
        await engine.set('old-key', 'val');
        // 2. Delete it (makes it tombstone: value=null)
        await engine.delete('old-key');

        // 3. Hack the timestamp to be very old
        // STABILITY_WINDOW is 5000ms. We go back 10000ms.
        // HLC: (physical << 80).
        const oldTime = BigInt(Date.now() - 10000) << 80n;
        const entry = (engine as any).state.get('old-key');
        if (entry) {
            entry.timestamp = oldTime;
        }

        // 4. Trigger compaction (threshold 1000 ops, or manual call)
        await engine.compact();

        // 5. Verify pruned from memory
        expect((engine as any).state.has('old-key')).toBe(false);

        // 6. Verify pruned from storage
        const stored = await storage.get('old-key');
        expect(stored).toBeUndefined();
    });

    it('should keep recent tombstones', async () => {
        const storage = new InMemoryAdapter();
        const engine = new SyncEngine('peer1', storage, false);

        await engine.set('recent-key', 'val');
        await engine.delete('recent-key');

        // Recent timestamp (default)
        await engine.compact();

        // Should still exist as tombstone
        expect((engine as any).state.has('recent-key')).toBe(true);
        expect(engine.get('recent-key')).toBeNull();
    });
});

describe('Coverage - Engine Causal Graph', () => {
    it('should buffer ops with missing deps', async () => {
        const engine = new SyncEngine('peer1', new InMemoryAdapter());
        const statusSpy = vi.fn();
        engine.on('status', statusSpy);

        // Op 2 depends on Op 1 (hash "op1")
        const payload = encodeValue('val2');
        const ts = BigInt(Date.now()) << 80n;

        // applyRemote with deps=['op1']
        // We haven't seen 'op1'
        await engine.applyRemote('key2', payload, 'peer2', ts, ['op1']);

        // Should be buffered
        expect((engine as any).isGapDetected).toBe(true);
        expect((engine as any).pendingBuffer.length).toBe(1);
        expect(statusSpy).toHaveBeenCalledWith('syncing');

        // Verify NOT applied
        expect(engine.get('key2')).toBeUndefined();
    });

    it('should apply buffered ops when deps arrive', async () => {
        const engine = new SyncEngine('peer1', new InMemoryAdapter());

        // 1. Arrives Op 2 (depends on Op 1)
        const payload2 = encodeValue('val2');
        const ts2 = (BigInt(Date.now()) + 100n) << 80n;
        // Generate a fake hash for op1? 
        // Hash format: key:timestamp:peerId
        const op1Hash = 'key1:1000:peer2';

        await engine.applyRemote('key2', payload2, 'peer2', ts2, [op1Hash]);
        expect(engine.get('key2')).toBeUndefined(); // Buffered

        // 2. Arrives Op 1
        // We must ensure its hash matches `op1Hash`.
        const payload1 = encodeValue('val1');

        // Apply Op 1
        await engine.applyRemote('key1', payload1, 'peer2', 1000n); // Matches hash params

        // Now engine should have processed Op 1 AND Op 2
        // Wait a tick for buffer processing
        await new Promise(r => setTimeout(r, 10));

        expect(engine.get('key1')).toBe('val1');
        expect(engine.get('key2')).toBe('val2');
        expect((engine as any).isGapDetected).toBe(false);
    });
});
