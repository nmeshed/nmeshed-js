import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryAdapter } from '../../src/adapters/InMemoryAdapter';

describe('InMemoryAdapter', () => {
    let adapter: InMemoryAdapter;

    beforeEach(() => {
        adapter = new InMemoryAdapter();
        adapter.init();
    });

    it('should set and get values', async () => {
        await adapter.set('key', new Uint8Array([1]));
        const val = await adapter.get('key');
        expect(val).toEqual(new Uint8Array([1]));
    });

    it('should return undefined for missing keys', async () => {
        const val = await adapter.get('missing');
        expect(val).toBeUndefined();
    });

    it('should delete keys', async () => {
        await adapter.set('key', new Uint8Array([1]));
        await adapter.delete('key');
        const val = await adapter.get('key');
        expect(val).toBeUndefined();
    });

    it('should scan prefix', async () => {
        await adapter.set('p:1', new Uint8Array([1]));
        await adapter.set('p:2', new Uint8Array([2]));
        await adapter.set('o:1', new Uint8Array([3]));

        const results = await adapter.scanPrefix('p:');
        expect(results).toHaveLength(2);
        expect(results[0][0]).toBe('p:1');
    });

    it('should clear specific key', async () => {
        await adapter.set('key', new Uint8Array([1]));
        await adapter.clear('key');
        expect(await adapter.get('key')).toBeUndefined();
    });

    it('should clear all', async () => {
        await adapter.set('a', new Uint8Array([1]));
        await adapter.set('b', new Uint8Array([2]));
        await adapter.clearAll();
        expect(await adapter.get('a')).toBeUndefined();
        expect(await adapter.get('b')).toBeUndefined();
    });

    it('should close', async () => {
        await adapter.close();
        expect(true).toBe(true);
    });
});
