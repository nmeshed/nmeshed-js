import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NMeshedClient } from './client';
import { defineSchema, SchemaSerializer, findSchema, registerGlobalSchema } from './schema/SchemaBuilder';
import { SyncedMap } from './sync/SyncedMap';
// @ts-ignore - testing internal functions
import { unpackMessage, unpackSnapshot } from './sync/SyncedMap';
import { setupTestMocks } from './test-utils/mocks';

// Mock WASM Core
vi.mock('./wasm/nmeshed_core', async () => {
    const mocks = await import('./test-utils/mocks');
    return {
        default: vi.fn().mockResolvedValue(undefined),
        NMeshedClientCore: mocks.MockWasmCore
    };
});

// Mock persistence
vi.mock('./persistence', () => ({
    loadQueue: vi.fn().mockResolvedValue([]),
    saveQueue: vi.fn().mockResolvedValue(undefined),
}));

describe('Coverage Hardening: SDK Core', () => {
    const config = { workspaceId: 'ws-1', token: 'tok', userId: 'user-1' };

    beforeEach(() => {
        setupTestMocks();
    });

    describe('NMeshedClient Edge Cases', () => {
        it('connect() throws if destroyed', async () => {
            const client = new NMeshedClient(config);
            client.destroy();
            await expect(client.connect()).rejects.toThrow(/destroyed/i);
        });

        it('set() returns early if destroyed', () => {
            const client = new NMeshedClient(config);
            client.destroy();
            const spy = vi.spyOn(client.engine, 'set');
            client.set('key', 'val');
            expect(spy).not.toHaveBeenCalled();
        });

        it('set() handles non-existent prefix correctly', () => {
            const client = new NMeshedClient(config);
            const schema = defineSchema({ x: 'int32' });
            // Key without prefix shouldn't register anything or crash
            client.set('noprefix', 1, schema);
            // Key with same prefix as key shouldn't register
            client.set('player', { x: 1 }, schema);
        });

        it('set() handles generic errors in engine.set', () => {
            const client = new NMeshedClient(config);
            const logSpy = vi.spyOn((client as any).logger, 'error');
            vi.spyOn(client.engine, 'set').mockImplementation(() => { throw new Error('Generic failure'); });
            expect(() => client.set('k', 'v')).not.toThrow();
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to set key'), expect.any(Error));
        });

        it('awaitReady handles ERROR status', async () => {
            const client = new NMeshedClient(config);
            const p = client.awaitReady();
            (client as any).setStatus('ERROR');
            await expect(p).rejects.toThrow(/Connection failed: ERROR/);
        });

        it('awaitReady handles DISCONNECTED status', async () => {
            const client = new NMeshedClient(config);
            const p = client.awaitReady();
            (client as any).setStatus('DISCONNECTED');
            await expect(p).rejects.toThrow(/Connection failed: DISCONNECTED/);
        });

        it('connect() returns early if status is READY or SYNCING', async () => {
            const client = new NMeshedClient(config);
            (client as any)._status = 'READY';
            const spy = vi.spyOn((client as any).transport, 'connect');
            await client.connect();
            expect(spy).not.toHaveBeenCalled();

            (client as any)._status = 'SYNCING';
            await client.connect();
            expect(spy).not.toHaveBeenCalled();
        });
    });

    describe('SchemaBuilder Edge Cases', () => {
        it('findSchema returns default if no match', () => {
            const schema = defineSchema({ x: 'int32' });
            registerGlobalSchema('', schema);
            expect(findSchema('anything')).toBe(schema);
        });

        it('decode handles empty or null buffer', () => {
            const schema = defineSchema({ x: 'int32', s: 'string' });
            const result = schema.decode(new Uint8Array(0));
            expect(result.x).toBe(0);
            expect(result.s).toBe('');
        });

        it('decodeValue handles empty buffer', () => {
            const val = SchemaSerializer.decodeValue('int32', new Uint8Array(0));
            expect(val).toBe(0);
        });

        it('encodeField handles invalid array input', () => {
            // @ts-ignore
            const bytes = SchemaSerializer.encodeValue({ type: 'array', itemType: 'int32' }, "not an array");
            expect(bytes.length).toBe(2);
        });

        it('encodeField handles invalid map input', () => {
            // @ts-ignore
            const bytes = SchemaSerializer.encodeValue({ type: 'map', schema: { x: 'int32' } }, "not a map");
            expect(bytes.length).toBe(2);
        });

        it('encodePrimitive returns empty for unknown type', () => {
            // @ts-ignore
            const bytes = SchemaSerializer.encodePrimitive('unknown', 123);
            expect(bytes.length).toBe(0);
        });
    });

    describe('SyncedMap Edge Cases', () => {
        it('unpackMessage returns null for too small buffer', () => {
            // @ts-ignore 
            expect(unpackMessage(new Uint8Array([1, 1]))).toBeNull();
        });

        it('unpackMessage returns null for truncated payload', () => {
            // @ts-ignore
            expect(unpackMessage(new Uint8Array([10, 10, 1, 0, 0, 0]))).toBeNull();
        });

        it('unpackSnapshot returns empty for too small buffer', () => {
            // @ts-ignore
            expect(unpackSnapshot(new Uint8Array([1, 1]))).toEqual(new Map());
        });

        it('applyRemoteUpdate handles deserialization failure', () => {
            const client = new NMeshedClient(config);
            const map = new SyncedMap(client, 'ns', {
                deserialize: () => { throw new Error('Boom'); }
            });
            const spy = vi.spyOn(console, 'error').mockImplementation(() => { });
            // @ts-ignore
            map.applyRemoteUpdate('key', new Uint8Array([1, 2, 3]));
            expect(spy).toHaveBeenCalledWith(expect.stringContaining('Failed to apply remote update'), expect.any(Error));
            spy.mockRestore();
        });

        it('handleSyncMessage ignores wrong namespace in binary Update', () => {
            const client = new NMeshedClient(config);
            const map = new SyncedMap(client, 'right-ns');
            const spy = vi.spyOn(map, 'applyRemoteUpdate' as any);

            const body = new Uint8Array([
                0,
                8,
                1,
                1,
                ...new TextEncoder().encode('wrong-ns'),
                ...new TextEncoder().encode('k'),
                ...new TextEncoder().encode('"v"')
            ]);
            // @ts-ignore
            map.handleSyncMessage(body);
            expect(spy).not.toHaveBeenCalled();
        });

        it('handleSyncMessage handles binary Snapshot', () => {
            const client = new NMeshedClient(config);
            const map = new SyncedMap(client, 'ns');
            const spy = vi.spyOn(map, 'applyRemoteUpdate' as any);

            const nsBytes = new TextEncoder().encode('ns');
            const snapshotContent = new Uint8Array([
                1, 0, 0, 0,
                1,
                ...new TextEncoder().encode('k'),
                1, 0, 0, 0,
                ...new TextEncoder().encode('"v"')
            ]);

            const packet = new Uint8Array(1 + 1 + nsBytes.length + snapshotContent.length);
            packet[0] = 1;
            packet[1] = nsBytes.length;
            packet.set(nsBytes, 2);
            packet.set(snapshotContent, 2 + nsBytes.length);

            // @ts-ignore
            map.handleSyncMessage(packet);
            expect(spy).toHaveBeenCalledWith('k', expect.any(Uint8Array));
        });

        it('isSyncMessage handles binary correctly', () => {
            const client = new NMeshedClient(config);
            const map = new SyncedMap(client, 'ns');
            // @ts-ignore
            expect(map.isSyncMessage(new Uint8Array([0]))).toBe(true);
            // @ts-ignore
            expect(map.isSyncMessage({ type: 'update', namespace: 'ns' })).toBe(true);
            // @ts-ignore
            expect(map.isSyncMessage({ type: 'update', namespace: 'wrong' })).toBe(false);
            // @ts-ignore
            expect(map.isSyncMessage("not a message")).toBe(false);
        });
    });

    describe('NMeshedClient Metrics & Misc', () => {
        it('exhibits correct queue metrics', () => {
            const client = new NMeshedClient(config);
            expect(client.getPendingCount()).toBe(0);
            expect(client.operationQueue.length).toBe(0);

            vi.spyOn((client as any).engine, 'getQueueLength').mockReturnValue(1);
            vi.spyOn((client as any).engine, 'getPendingOps').mockReturnValue([new Uint8Array([1, 2, 3])]);
            vi.spyOn((client as any).engine, 'getAllValues').mockReturnValue({ 'k': 'v' });
            vi.spyOn((client as any).engine, 'isOptimistic').mockReturnValue(true);

            expect(client.getPendingCount()).toBe(1);
            expect(client.operationQueue.length).toBe(1);
            expect(client.getUnconfirmedCount()).toBe(1);
        });

        it('handles flush errors gracefully', async () => {
            const client = new NMeshedClient(config);
            (client as any)._status = 'READY';
            vi.spyOn((client as any).engine, 'getPendingOps').mockImplementation(() => { throw new Error('Flush error'); });
            const spy = vi.spyOn((client as any).logger, 'warn');

            (client as any).flushQueue();
            // Expect either warning string
            expect(spy).toHaveBeenCalledWith(expect.stringMatching(/Failed to (start operation queue flush|flush queue)/), expect.any(Error));
        });
    });
});
