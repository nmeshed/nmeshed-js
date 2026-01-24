
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncEngine } from '../src/engine';
import { InMemoryAdapter } from '../src/adapters/InMemoryAdapter';

describe('Engine Coverage Gaps', () => {
    let engine: SyncEngine;
    let storage: InMemoryAdapter;

    beforeEach(() => {
        storage = new InMemoryAdapter();
        engine = new SyncEngine('test-peer', storage, true);
    });

    it('should buffer remote ops with missing dependencies (Gap Detection)', async () => {
        const payload = new Uint8Array([1, 2, 3]);

        // Apply op dependent on 'unknown-parent'
        await engine.applyRemote('child', payload, 'remote-1', 100n, ['unknown-parent']);

        // Assert buffering logic
        // Use any to access private members for whitebox verification
        expect((engine as any).isGapDetected).toBe(true);
        expect((engine as any).pendingBuffer.length).toBe(1);

        // Should not apply yet
        expect(engine.get('child')).toBeUndefined();
    });

    it('should process buffer when missing deps arrive', async () => {
        const payload = new Uint8Array([1]);

        // 1. Receive Child (Buffered)
        await engine.applyRemote('child', payload, 'remote-1', 200n, ['parent']);
        expect(engine.get('child')).toBeUndefined();

        // 2. Receive Parent (Unblocks)
        // Note: We need parent op to generate the hash 'parent:100:remote-1' presumably? 
        // Or we manually inject the dep hash into receivedOps?
        // Let's force the parent op. 
        // engine.set() generates a hash but locally.
        // applyRemote generates hash.

        // We need to know EXACTLY what string the engine expects for 'parent'.
        // In getOpHash: `${key}:${timestamp}:${peerId}`.
        // If the dependency string passed in 'deps' matches that hash, it unblocks.

        // Let's manually simulate the 'parent' hash existing in receivedOps
        (engine as any).receivedOps.add('parent');

        // Trigger re-evaluation (usually happens on next applyRemote)
        // Send a dummy op to trigger buffer check or call private method?
        // applyRemote triggers buffer processing at the end.
        await engine.applyRemote('dummy', payload, 'remote-1', 300n, []);

        // Now child should be applied
        // Wait for async recursion
        await new Promise(r => setTimeout(r, 10));
        expect(engine.get('child')).toBeDefined();
        expect((engine as any).isGapDetected).toBe(false);
    });

    it('should prune old tombstones during compaction', async () => {
        // Set up old deleted item
        await engine.set('old-key', 'val');
        await engine.delete('old-key'); // Tombstone

        // Mock timestamps: Entry timestamp is now (high). 
        // We need to trick compaction into thinking it's OLD.
        // Access state map directly
        const state = (engine as any).state;
        state.get('old-key').timestamp = 0n; // Very old

        // Run compaction
        await (engine as any).compact();

        // Should be gone
        expect(engine.get('old-key')).toBeUndefined();
        expect(state.has('old-key')).toBe(false);
    });
});
