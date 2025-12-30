/**
 * @file ConsistentHashRing.test.ts
 * @brief Tests for consistent hash ring implementation.
 */

import { describe, it, expect } from 'vitest';
import { ConsistentHashRing } from './ConsistentHashRing';

describe('ConsistentHashRing', () => {
    describe('basic operations', () => {
        it('returns null for empty ring', () => {
            const ring = new ConsistentHashRing();
            expect(ring.getNode('key')).toBeNull();
        });

        it('returns the only node for any key', () => {
            const ring = new ConsistentHashRing();
            ring.addNode('node1');

            expect(ring.getNode('key1')).toBe('node1');
            expect(ring.getNode('key2')).toBe('node1');
            expect(ring.getNode('any-key')).toBe('node1');
        });

        it('distributes keys across multiple nodes', () => {
            const ring = new ConsistentHashRing();
            ring.addNode('node1');
            ring.addNode('node2');
            ring.addNode('node3');

            const assigned = new Set<string>();
            for (let i = 0; i < 100; i++) {
                const node = ring.getNode(`key-${i}`);
                if (node) assigned.add(node);
            }

            // All nodes should have some keys
            expect(assigned.size).toBeGreaterThan(1);
        });
    });

    describe('addNode', () => {
        it('ignores duplicate nodes', () => {
            const ring = new ConsistentHashRing();
            ring.addNode('node1');
            ring.addNode('node1'); // duplicate

            expect(ring.getNodes()).toEqual(['node1']);
        });
    });

    describe('removeNode', () => {
        it('ignores removing non-existent node', () => {
            const ring = new ConsistentHashRing();
            ring.addNode('node1');
            ring.removeNode('non-existent');

            expect(ring.getNodes()).toEqual(['node1']);
        });

        it('removes node and redistributes keys', () => {
            const ring = new ConsistentHashRing();
            ring.addNode('node1');
            ring.addNode('node2');

            const keyNode = ring.getNode('test-key');
            expect(keyNode).toBeDefined();

            // Remove the node that was handling the key
            ring.removeNode(keyNode!);

            // Key should now be handled by remaining node
            const newNode = ring.getNode('test-key');
            expect(newNode).not.toBeNull();
            expect(newNode).not.toBe(keyNode);
        });
    });

    describe('hash edge cases', () => {
        it('handles null/undefined values in hash', () => {
            const ring = new ConsistentHashRing();
            ring.addNode('node1');

            // These should not throw
            expect(ring.getNode(null as any)).toBe('node1');
            expect(ring.getNode(undefined as any)).toBe('node1');
        });

        it('handles empty string', () => {
            const ring = new ConsistentHashRing();
            ring.addNode('node1');

            expect(ring.getNode('')).toBe('node1');
        });
    });

    describe('getNodes', () => {
        it('returns copy of nodes array', () => {
            const ring = new ConsistentHashRing();
            ring.addNode('a');
            ring.addNode('b');

            const nodes = ring.getNodes();
            nodes.push('c'); // Should not affect internal state

            expect(ring.getNodes()).toEqual(['a', 'b']);
        });
    });

    describe('replication factor', () => {
        it('uses custom replication factor', () => {
            const ring = new ConsistentHashRing(5);
            ring.addNode('node1');

            // Should still work with custom factor
            expect(ring.getNode('key')).toBe('node1');
        });
    });
});
