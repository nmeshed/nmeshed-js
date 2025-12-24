import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NMeshedClient } from './client';
import { SyncEngine } from './core/SyncEngine';
import { renderHook, act } from '@testing-library/react';
import { useStore } from './react/useStore';
import { defineSchema } from './schema/SchemaBuilder';
import React from 'react';

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

        it('applyRemoteDelta should handle JSON array of operations', () => {
            const engine = new SyncEngine('test-ws');
            // We need to return something that is NOT an object with 'type'
            // OR returns an object that matches the manual fallback (Uint8Array)
            (engine as any).core = {
                merge_remote_delta: vi.fn((d: any) => {
                    // Return the delta itself, and we must ensure it doesn't have a 'type' property
                    // that matches 'op' or 'init'.
                    return d;
                })
            };

            const ops = [
                { key: 'k1', value: 'v1' },
                { key: 'k2', value: 'v2' }
            ];
            const delta = new Uint8Array(new TextEncoder().encode(JSON.stringify(ops)));

            const emitted: any[] = [];
            engine.on('op', (k, v, isOpt) => emitted.push({ k, v, isOpt }));

            engine.applyRemoteDelta(delta);

            expect(emitted).toHaveLength(2);
            expect(emitted[0]).toEqual({ k: 'k1', v: 'v1', isOpt: false });
        });

        it('applyRemoteDelta should handle single JSON operation', () => {
            const engine = new SyncEngine('test-ws');
            (engine as any).core = {
                merge_remote_delta: vi.fn((d: any) => d)
            };

            const op = { key: 'k1', value: 'v1' };
            const delta = new Uint8Array(new TextEncoder().encode(JSON.stringify(op)));

            const emitted: any[] = [];
            engine.on('op', (k, v, isOpt) => emitted.push({ k, v, isOpt }));

            engine.applyRemoteDelta(delta);

            expect(emitted).toHaveLength(1);
            expect(emitted[0]).toEqual({ k: 'k1', v: 'v1', isOpt: false });
        });
    });

    describe('NMeshedClient Extra Coverage', () => {
        it('should handle debug logging when enabled', () => {
            const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
            const client = new NMeshedClient({
                workspaceId: 'test',
                apiKey: 'test',
                debug: true
            });

            // Trigger status change to log
            (client as any).setStatus('CONNECTED');
            expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[nMeshed] Status: IDLE -> CONNECTED'));

            consoleLogSpy.mockRestore();
        });

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

        it('should handle decoding failure gracefully', () => {
            const client = new NMeshedClient({ workspaceId: 't', apiKey: 'k' });
            (globalThis as any).__MOCK_CLIENT__ = client;

            // Mock a bad value in client state
            (client as any)._state.set('title', new Uint8Array([0xFF])); // Invalid encoding

            const { result } = renderHook(() => useStore(TestSchema));
            expect(result.current[0].title).toBeUndefined();
        });

        it('should track pending state for optimistic updates', async () => {
            const client = new NMeshedClient({ workspaceId: 't', apiKey: 'k' });
            (globalThis as any).__MOCK_CLIENT__ = client;

            // Mock engine to not actually do WASM stuff but emit events
            const engine = (client as any).engine;
            engine.core = {
                apply_local_op: vi.fn().mockReturnValue(new Uint8Array([1])),
                merge_remote_delta: vi.fn().mockReturnValue({ type: 'none' })
            };

            const { result } = renderHook(() => useStore(TestSchema));

            expect(result.current[2].pending.has('title')).toBe(false);

            act(() => {
                result.current[1]({ title: 'New' });
            });

            expect(result.current[2].pending.has('title')).toBe(true);

            // Simulate confirmation
            act(() => {
                engine.core.merge_remote_delta.mockReturnValue({
                    type: 'op',
                    key: 'title',
                    value: 'New'
                });
                engine.applyRemoteDelta(new Uint8Array([1]));
            });

            expect(result.current[2].pending.has('title')).toBe(false);
        });

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
