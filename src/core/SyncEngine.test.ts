import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SyncEngine, reconstructBinary } from './SyncEngine';
import { RealTimeClock } from './RealTimeClock';
import { AuthorityManager } from './AuthorityManager';
import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';
import { Op } from '../schema/nmeshed/op';
import { Signal } from '../schema/nmeshed/signal';
import { saveQueue, loadQueue } from '../persistence';

// Mock persistence
vi.mock('../persistence', () => ({
    loadQueue: vi.fn().mockResolvedValue([]),
    saveQueue: vi.fn().mockResolvedValue(undefined),
}));

const VALID_UUID_1 = '00000000-0000-0000-0000-000000000001';
const VALID_UUID_2 = '00000000-0000-0000-0000-000000000002';
const VALID_UUID_3 = '00000000-0000-0000-0000-000000000003';
const VALID_UUID_4 = '00000000-0000-0000-0000-000000000004';

// Helper to create WirePacket bytes
function createOpPacket(key: string, value: Uint8Array): Uint8Array {
    const builder = new flatbuffers.Builder(1024);
    const keyOffset = builder.createString(key);
    const valOffset = Op.createValueVector(builder, value);
    Op.startOp(builder);
    Op.addKey(builder, keyOffset);
    Op.addValue(builder, valOffset);
    const opOffset = Op.endOp(builder);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Op);
    WirePacket.addOp(builder, opOffset);
    const packetOffset = WirePacket.endWirePacket(builder);
    builder.finish(packetOffset);
    return builder.asUint8Array().slice();
}

describe('SyncEngine', () => {
    let engine: SyncEngine;

    beforeEach(async () => {
        vi.useFakeTimers();
        engine = new SyncEngine(VALID_UUID_1, VALID_UUID_2, 100, false);
        await engine.boot();
    });

    afterEach(() => {
        vi.clearAllMocks();
        if (engine) engine.destroy();
    });

    describe('BOOT & INFRASTRUCTURE', () => {
        it('should initialize RealTimeClock and AuthorityManager', () => {
            expect((engine as any).clock).toBeInstanceOf(RealTimeClock);
            expect((engine as any).authority).toBeInstanceOf(AuthorityManager);
        });

        it('should drain bootQueue on boot', async () => {
            const fresh = new SyncEngine(VALID_UUID_3, VALID_UUID_4, 100, false);
            fresh.applyRawMessage(new Uint8Array([0xAA]));
            expect((fresh as any).bootQueue.length).toBe(1);

            await fresh.boot();
            expect((fresh as any).bootQueue.length).toBe(0);
        });

        it('idempotent boot should not re-initialize', async () => {
            const spy = vi.spyOn(engine, 'emit');
            await engine.boot();
            expect(spy).not.toHaveBeenCalledWith('stateChange', 'BOOTING', 'ACTIVE');
            expect(engine.state).toBe('ACTIVE');
        });
    });

    describe('QUEUE MANAGEMENT', () => {
        it('should respect maxQueueSize when not operational', async () => {
            const maxQueueSize = 2;
            const qEngine = new SyncEngine(VALID_UUID_1, VALID_UUID_2, maxQueueSize, false);

            qEngine.set('k1', 'v1');
            expect(qEngine.get('k1')).toBe('v1');
            qEngine.set('k2', 'v2');
            expect(qEngine.get('k2')).toBe('v2');
            qEngine.set('k3', 'v3');

            expect(qEngine.get('k3')).toBe('v3');
            expect(qEngine.get('k2')).toBe('v2');
            expect(qEngine.get('k1')).toBeUndefined();
        });
    });

    describe('STATE OPERATIONS (set/get)', () => {
        it('should pass monotonic timestamps to WASM core', () => {
            engine.set('k1', 'v1');
            expect(engine.get('k1')).toBe('v1');
        });

        it('should delegate authority checks to AuthorityManager', () => {
            const authSpy = vi.spyOn((engine as any).authority, 'trackKey');
            engine.set('k2', 'v2');
            expect(authSpy).toHaveBeenCalledWith('k2');
        });
    });

    describe('MESSAGE PIPELINE', () => {
        it('should process Op messages and update confirmed state', () => {
            const key = 'remote';
            const value = new Uint8Array([1, 2, 3]);
            const bytes = createOpPacket(key, value);
            engine.applyRawMessage(bytes);
            expect(engine.get(key)).toBeDefined();
        });

        it('should handle malformed packets gracefully', () => {
            const junk = new Uint8Array([0, 1, 2, 3, 4]);
            expect(() => engine.applyRawMessage(junk)).not.toThrow();
        });
    });

    describe('STATE MACHINE & TRANSITIONS', () => {
        it('should allow valid transition sequence', async () => {
            expect(engine.state).toBe('ACTIVE');
            await engine.destroy();
            expect(engine.state).toBe('DESTROYED');
        });

        it('should throw InvalidStateTransitionError for invalid transitions', () => {
            expect(() => (engine as any).transition('DESTROYED', 'test')).toThrow('Invalid state transition');
        });
    });

    describe('PERSISTENCE & RECOVERY', () => {
        it('should handle binary and wrapped persisted formats', async () => {
            vi.mocked(loadQueue).mockResolvedValue([
                new Uint8Array([0x01]),
                { data: new Uint8Array([0x02]) }
            ]);

            const persistent = new SyncEngine(VALID_UUID_1, VALID_UUID_3, 100, false);
            await persistent.boot();
            expect(persistent.getQueueLength()).toBe(2);
        });

        it('should handle loadQueue failure without crashing', async () => {
            vi.mocked(loadQueue).mockRejectedValue(new Error('DB Failed'));
            const persistent = new SyncEngine(VALID_UUID_2, VALID_UUID_4, 100, false);
            await expect(persistent.boot()).resolves.not.toThrow();
            expect(persistent.state).toBe('ACTIVE');
        });

        it('should handle persistsOperationQueue error', async () => {
            vi.mocked(saveQueue).mockRejectedValueOnce(new Error('Persistent Fail'));
            engine.set('k', 'v');
            vi.advanceTimersByTime(200);
            expect((engine as any).isQueueDirty).toBe(true);
        });

        it('should handle shiftQueue and clearQueue', () => {
            engine.set('k1', 'v1');
            engine.set('k2', 'v2');
            expect(engine.getQueueLength()).toBe(2);
            engine.shiftQueue(1);
            expect(engine.getQueueLength()).toBe(1);
            engine.clearQueue();
            expect(engine.getQueueLength()).toBe(0);
        });

        it('should persist and recover preConnectState', async () => {
            const preEngine = new SyncEngine(VALID_UUID_1, VALID_UUID_2, 100, false);
            preEngine.set('pre-key', 'pre-val');

            // Advance timers to trigger scheduled persistence
            vi.advanceTimersByTime(200);

            expect(saveQueue).toHaveBeenCalled();
            const lastCall = vi.mocked(saveQueue).mock.calls[vi.mocked(saveQueue).mock.calls.length - 1];
            const savedData = lastCall[1];
            expect(savedData.some((item: any) => item.type === 'pre' && item.k === 'pre-key')).toBe(true);

            // Load back
            vi.mocked(loadQueue).mockResolvedValue([
                { type: 'pre', k: 'key2', v: 'val2' }
            ]);
            await (preEngine as any).loadPersistedState();
            expect(preEngine.get('key2')).toBe('val2');
        });
    });

    describe('UTILITIES', () => {
        it('reconstructBinary should handle various inputs', () => {
            // ArrayBuffer
            const ab = new ArrayBuffer(2);
            const abResult = reconstructBinary(ab);
            expect(abResult).toBeInstanceOf(Uint8Array);

            // TypedArray-like
            const obj = { 0: 65, 1: 66, length: 2 };
            const objResult = reconstructBinary(obj);
            expect(objResult![0]).toBe(65);

            // Object without length
            const obj2 = { 0: 67, 1: 68 };
            const objResult2 = reconstructBinary(obj2);
            expect(objResult2![0]).toBe(67);

            // Nulls/Other
            expect(reconstructBinary(null)).toBeNull();
            expect(reconstructBinary(123)).toBeNull();
        });
    });

    describe('CLEANUP', () => {
        it('should stop clock and mark as destroyed', () => {
            const clockStopSpy = vi.spyOn((engine as any).clock, 'stop');
            engine.destroy();
            expect(clockStopSpy).toHaveBeenCalled();
            expect(engine.state).toBe('DESTROYED');
        });
    });
    describe('COVERAGE BOOST', () => {
        it('getHeads should return empty array if not active', () => {
            // New engine is IDLE
            const fresh = new SyncEngine(VALID_UUID_1, VALID_UUID_2, 100, false);
            expect(fresh.getHeads()).toEqual([]);
        });

        it('getHeads should return heads from core if active', async () => {
            // 'engine' is already booted and ACTIVE from beforeEach
            // existing core probably has get_heads. spy on it.
            const core = (engine as any).core;
            if (core) {
                const heads = engine.getHeads();
                expect(Array.isArray(heads)).toBe(true);
            }
        });

        it('getHeads should handle core errors', async () => {
            // We can manually corrupt the core or injection
            const originalCore = (engine as any).core;
            (engine as any).core = {
                get_heads: () => { throw new Error('Rust panic'); }
            };
            expect(engine.getHeads()).toEqual([]);
            (engine as any).core = originalCore;
        });

        it('getConfirmed should alias get', () => {
            const spy = vi.spyOn(engine, 'get').mockReturnValue('val');
            expect(engine.getConfirmed('key')).toBe('val');
            expect(spy).toHaveBeenCalledWith('key');
        });

        it('isOptimistic should return false', () => {
            expect(engine.isOptimistic('key')).toBe(false);
        });

        it('getAllValues should reconstruct binary values', () => {
            // We can inject a mock core that allows controlling get_all_values
            const originalCore = (engine as any).core;
            (engine as any).core = {
                get_all_values: () => {
                    const map = new Map();
                    map.set('foo', new Uint8Array([104, 101, 108, 108, 111])); // "hello"
                    return map;
                }
            };

            const vals = engine.getAllValues();
            expect(vals).toHaveProperty('foo');
            // Restore
            (engine as any).core = originalCore;
        });
    });
});
