import { describe, it, expect, vi } from 'vitest';
import { NMeshedClient } from './client';
import { SyncEngine } from './core/SyncEngine';
import { renderHook, act } from '@testing-library/react';
import { useStore } from './react/useStore';
import { defineSchema } from './schema/SchemaBuilder';

// Mock SyncEngine.boot to avoid WASM initialization
vi.spyOn(SyncEngine.prototype, 'boot').mockImplementation(async function (this: any) {
    this.core = {
        apply_local_op: vi.fn().mockReturnValue(new Uint8Array([1])),
        merge_remote_delta: vi.fn().mockReturnValue({ type: 'none' }),
        get_state: vi.fn(() => ({})),
    };
});

// Mock NMeshedContext to provide the client
vi.mock('./react/context', () => ({
    useNmeshedContext: () => (globalThis as any).__MOCK_CLIENT__
}));

describe('Coverage Booster', () => {
    describe('SyncEngine Extra Coverage', () => {
        it('getAllValues should merge preConnectState and core state', () => {
            const engine = new SyncEngine('test-ws');
            engine.set('a', 1); // preConnect since core is null

            // Re-mock core for this specific test
            (engine as any).core = {
                state: {
                    'b': new Uint8Array([0x01]),
                },
                get_state: () => ({
                    'b': 1,
                    'c': 'hello'
                })
            };

            const all = engine.getAllValues();
            expect(all.a).toBe(1);
            expect(all.b).toBe(1);
            expect(all.c).toBe('hello');
        });
    });

    describe('NMeshedClient Extra Coverage', () => {
        it('should use fallback userId generation when crypto is unavailable', () => {
            const originalCrypto = globalThis.crypto;
            // @ts-ignore
            delete (globalThis as any).crypto;

            const client = new NMeshedClient({
                workspaceId: 'test',
                apiKey: 'test'
            });

            expect(client.getId()).toMatch(/^user-/);

            (globalThis as any).crypto = originalCrypto;
        });
    });

    describe('useStore Extra Coverage', () => {
        const TestSchema = defineSchema({ title: 'string' });

        it('should support transactions', () => {
            const client = new NMeshedClient({ workspaceId: 't', apiKey: 'k' });
            (globalThis as any).__MOCK_CLIENT__ = client;

            // Mock transport to spy on send
            const sendSpy = vi.spyOn((client as any).transport, 'send').mockImplementation(() => { });
            (client as any)._status = 'CONNECTED';

            // Mock core to return deltas
            (client as any).engine.core = {
                apply_local_op: vi.fn().mockReturnValue(new Uint8Array([1])),
            };

            client.transaction(() => {
                client.set('key1', 'val1');
                client.set('key2', 'val2');
            });

            expect(sendSpy).toHaveBeenCalledTimes(2);
            expect(client.get('key1')).toBe('val1');
            expect(client.get('key2')).toBe('val2');
        });
    });
});
