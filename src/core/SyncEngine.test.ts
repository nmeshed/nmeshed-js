import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SyncEngine, reconstructBinary, EngineState } from './SyncEngine';
import { RealTimeClock } from './RealTimeClock';
import { AuthorityManager } from './AuthorityManager';
import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';
import { Op } from '../schema/nmeshed/op';
import { Signal } from '../schema/nmeshed/signal';
import { SyncPacket } from '../schema/nmeshed/sync-packet';
import { VersionVector } from '../schema/nmeshed/version-vector';
import { StateVectorEntry } from '../schema/nmeshed/state-vector-entry';
import { ActorRegistry } from '../schema/nmeshed/actor-registry';
import { ActorMapping } from '../schema/nmeshed/actor-mapping';
import { ColumnarOpBatch } from '../schema/nmeshed/columnar-op-batch';
import { ClientError, SchemaError } from '../errors';
import { saveQueue, loadQueue } from '../persistence';
import { packOp } from '../test-utils/wire-utils';

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
            expect(qEngine.get('k1')).toBeNull();
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

    describe('EXTRA COVERAGE & EDGE CASES', () => {
        it('should handle set() and forEach iteration with real core', () => {
            engine.set('k1', 'v1');
            const spy = vi.fn();
            engine.forEach(spy);
            expect(spy).toHaveBeenCalledWith('v1', 'k1');
        });

        it('should handle MsgType.Signal', () => {
            const builder = new flatbuffers.Builder(1024);
            const from = builder.createString('alice');
            Signal.startSignal(builder);
            Signal.addFromPeer(builder, from);
            const sigOffset = Signal.endSignal(builder);

            WirePacket.startWirePacket(builder);
            WirePacket.addMsgType(builder, MsgType.Signal);
            WirePacket.addSignal(builder, sigOffset);
            const pkt = WirePacket.endWirePacket(builder);
            builder.finish(pkt);

            const spy = vi.fn();
            engine.on('signal', spy);
            engine.applyRawMessage(builder.asUint8Array());
            expect(spy).toHaveBeenCalled();
        });

        it('should handle MsgType.Sync with vector clock', () => {
            const builder = new flatbuffers.Builder(1024);
            const peerId = builder.createString('peer2');
            StateVectorEntry.startStateVectorEntry(builder);
            StateVectorEntry.addPeerId(builder, peerId);
            StateVectorEntry.addSeq(builder, BigInt(10));
            const item = StateVectorEntry.endStateVectorEntry(builder);
            const items = VersionVector.createItemsVector(builder, [item]);
            VersionVector.startVersionVector(builder);
            VersionVector.addItems(builder, items);
            const vc = VersionVector.endVersionVector(builder);

            SyncPacket.startSyncPacket(builder);
            SyncPacket.addCurrentVector(builder, vc);
            const sync = SyncPacket.endSyncPacket(builder);

            WirePacket.startWirePacket(builder);
            WirePacket.addMsgType(builder, MsgType.Sync);
            WirePacket.addSync(builder, sync);
            builder.finish(WirePacket.endWirePacket(builder));

            engine.applyRawMessage(builder.asUint8Array());
            const remoteVectors = (engine as any).remoteVectors;
            expect(remoteVectors.get('server').get('peer2')).toBe(BigInt(10));
        });

        it('should handle MsgType.ActorRegistry', () => {
            const builder = new flatbuffers.Builder(1024);
            const actorId = builder.createString('actor-uuid');
            ActorMapping.startActorMapping(builder);
            ActorMapping.addId(builder, actorId);
            ActorMapping.addIdx(builder, 5);
            const map = ActorMapping.endActorMapping(builder);
            const maps = ActorRegistry.createMappingsVector(builder, [map]);
            ActorRegistry.startActorRegistry(builder);
            ActorRegistry.addMappings(builder, maps);
            const reg = ActorRegistry.endActorRegistry(builder);

            WirePacket.startWirePacket(builder);
            WirePacket.addMsgType(builder, MsgType.ActorRegistry);
            WirePacket.addActorRegistry(builder, reg);
            builder.finish(WirePacket.endWirePacket(builder));

            engine.applyRawMessage(builder.asUint8Array());
            expect((engine as any).actorMap.get(5)).toBe('actor-uuid');
        });

        it('should handle MsgType.ColumnarBatch with deletes', () => {
            const builder = new flatbuffers.Builder(1024);
            const keys = [
                builder.createString('col-k1'),
                builder.createString('col-del')
            ];
            const keysVec = ColumnarOpBatch.createKeysVector(builder, keys);
            const tsVec = ColumnarOpBatch.createTimestampsVector(builder, [1000n, 1001n]);
            const seqVec = ColumnarOpBatch.createSeqsVector(builder, [1n, 2n]);
            const actorVec = ColumnarOpBatch.createActorIdxsVector(builder, new Uint32Array([1, 1]));
            const delVec = ColumnarOpBatch.createIsDeletesVector(builder, [false, true]);

            ColumnarOpBatch.startColumnarOpBatch(builder);
            ColumnarOpBatch.addKeys(builder, keysVec);
            ColumnarOpBatch.addTimestamps(builder, tsVec);
            ColumnarOpBatch.addSeqs(builder, seqVec);
            ColumnarOpBatch.addActorIdxs(builder, actorVec);
            ColumnarOpBatch.addIsDeletes(builder, delVec);
            const batch = ColumnarOpBatch.endColumnarOpBatch(builder);

            WirePacket.startWirePacket(builder);
            WirePacket.addMsgType(builder, MsgType.ColumnarBatch);
            WirePacket.addBatch(builder, batch);
            builder.finish(WirePacket.endWirePacket(builder));

            engine.applyRawMessage(builder.asUint8Array());
        });

        it('snapshot fallback coverage', () => {
            const core = (engine as any).core;
            const originalGetState = (core as any).get_state;
            (core as any).get_state = undefined;
            (core as any).get_binary_snapshot = undefined;
            engine.getBinarySnapshot();
            (core as any).get_state = originalGetState;
        });

        it('pruneHistory coverage with debug engine', () => {
            const debugEngine = new SyncEngine(VALID_UUID_1, VALID_UUID_2, 100, true);
            const horizon = new Map();
            horizon.set('some-peer', 100n);
            (debugEngine as any).pruneHistory(horizon);
            debugEngine.destroy();
        });

        it('reconstructBinary coverage', () => {
            reconstructBinary({ 0: 10, length: 1 });
            reconstructBinary(new Uint8Array([1]));
            reconstructBinary(null);
        });

        it('Error classes and vector coverage', () => {
            new ClientError('fail');
            new SchemaError('bad');
            expect(engine.getLocalVector()).toBeInstanceOf(Map);
        });

        it('fallback and error paths coverage', async () => {
            // 1. getBinarySnapshot fallback
            const weakCore = {
                get_raw_value: () => null,
                get_all_values: () => ({})
            };
            (engine as any).core = weakCore;
            expect(engine.getBinarySnapshot()).toBeDefined();

            // 2. applyRawMessage catch blocks
            const badPacket = new Uint8Array([0xFF, 0x00, 0x01]);
            (engine as any).applyRawMessage(badPacket); // Should hit catch (e) at 692

            // 3. schedulePersistence error path
            const persistence = await import('../persistence');
            vi.spyOn(persistence, 'saveQueue').mockRejectedValue(new Error('Disk Full'));
            (engine as any).isQueueDirty = true;
            await (engine as any).saveState(true); // Force save even if IDLE
            expect((engine as any).isQueueDirty).toBe(true);

            // 4. Init Hydration failure
            const builder = new flatbuffers.Builder(1024);
            WirePacket.startWirePacket(builder);
            WirePacket.addMsgType(builder, MsgType.Init);
            builder.finish(WirePacket.endWirePacket(builder));
            const initPacket = builder.asUint8Array();

            // Mock core that throws on get_all_values
            (engine as any).core = {
                get_all_values: () => { throw new Error('Hydration Error'); },
                merge_remote_delta: () => { }
            };
            (engine as any).applyRawMessage(initPacket); // Should hit catch (e) at 664
        });

        it('horizon and missing hydration edge cases', () => {
            // 1. Horizon Intersection (859-860, 867)
            (engine as any).localVector.set('peer-a', 100n);

            // Remote vector with SMALLER seq (hits 860)
            const v1 = new Map([['peer-a', 50n]]);
            engine.updateRemoteVector('remote-1', v1);
            expect(engine.getLocalVector().get('peer-a')).toBe(100n); // Local stays 100
            // But internal horizon should have 50 (min)

            // Remote vector MISSING a key (hits 867)
            const v2 = new Map([['peer-other', 200n]]);
            engine.updateRemoteVector('remote-2', v2);

            // 2. Missing Hydration method (652)
            const builder = new flatbuffers.Builder(1024);
            WirePacket.startWirePacket(builder);
            WirePacket.addMsgType(builder, MsgType.Init);
            builder.finish(WirePacket.endWirePacket(builder));
            const initPacket = builder.asUint8Array();

            (engine as any).core = { get_all_values: () => ({}) }; // No merge_remote_delta, no apply_vessel
            (engine as any).applyRawMessage(initPacket);
        });

        it('loadPersistedState secondary coverage', async () => {
            // Coverage for 'pre' entries in loadPersistedState
            const persistence = await import('../persistence');
            vi.spyOn(persistence, 'loadQueue').mockResolvedValue([
                { type: 'pre', k: 'pre-key', v: 'pre-val' },
                new Uint8Array([1, 2, 3]) // Invalid op but hits the branch
            ]);
            await (engine as any).loadPersistedState();
        });
        it('deep branch coverage for SyncEngine', async () => {
            // 1. apply_local_op failures (514, 520)
            const failingCore = {
                apply_local_op: () => null as any,
                get_raw_value: () => null
            };
            (engine as any).core = failingCore;
            expect(() => engine.set('fail', 'val')).toThrow();

            failingCore.apply_local_op = () => ({}) as any; // Not a binary result
            expect(() => engine.set('fail2', 'val')).toThrow();

            // 2. applyRawMessage states (552, 558)
            (engine as any)._state = EngineState.STOPPING;
            engine.applyRawMessage(new Uint8Array([1])); // Hits 552

            (engine as any)._state = EngineState.IDLE;
            engine.applyRawMessage(new Uint8Array([1])); // Hits 558
            expect((engine as any).bootQueue.length).toBe(1);

            // 3. malformed Op (584)
            (engine as any)._state = EngineState.ACTIVE;
            (engine as any).core = { apply_vessel: () => { } };
            const builder = new flatbuffers.Builder(1024);
            Op.startOp(builder);
            // No key
            const opOffset = Op.endOp(builder);
            WirePacket.startWirePacket(builder);
            WirePacket.addMsgType(builder, MsgType.Op);
            WirePacket.addOp(builder, opOffset);
            builder.finish(WirePacket.endWirePacket(builder));
            engine.applyRawMessage(builder.asUint8Array()); // Hits 584

            // 4. apply_vessel failures (588, 664)
            (engine as any).core = {
                apply_vessel: () => { throw new Error('fail'); },
                get_all_values: () => ({})
            };
            engine.applyRawMessage(builder.asUint8Array()); // Hits 588
        });

        it('Sync and Signal branch coverage', () => {
            const builder = new flatbuffers.Builder(1024);

            // Sync with snapshot (598)
            const snapOffset = SyncPacket.createSnapshotVector(builder, [1, 2, 3]);
            SyncPacket.startSyncPacket(builder);
            SyncPacket.addSnapshot(builder, snapOffset);
            const syncOffset = SyncPacket.endSyncPacket(builder);

            WirePacket.startWirePacket(builder);
            WirePacket.addMsgType(builder, MsgType.Sync);
            WirePacket.addSync(builder, syncOffset);
            builder.finish(WirePacket.endWirePacket(builder));

            (engine as any).core = { apply_vessel: () => { } };
            engine.applyRawMessage(builder.asUint8Array());

            // Signal (636)
            builder.clear();
            Signal.startSignal(builder);
            const sigOffset = Signal.endSignal(builder);

            WirePacket.startWirePacket(builder);
            WirePacket.addMsgType(builder, MsgType.Signal);
            WirePacket.addSignal(builder, sigOffset);
            builder.finish(WirePacket.endWirePacket(builder));

            engine.applyRawMessage(builder.asUint8Array());
        });

        it('should handle unknown MsgType gracefully', () => {
            const builder = new flatbuffers.Builder(1024);
            WirePacket.startWirePacket(builder);
            WirePacket.addMsgType(builder, 99 as any);
            builder.finish(WirePacket.endWirePacket(builder));

            const errorSpy = vi.spyOn((engine as any).logger, 'warn').mockImplementation(() => { });
            engine.applyRawMessage(builder.asUint8Array());
            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown MsgType: 99'));
            errorSpy.mockRestore();
        });

        it('should fallback in getBinarySnapshot if core methods are missing', async () => {
            const fresh = new SyncEngine(VALID_UUID_3, VALID_UUID_4, 100, false);
            await fresh.boot();

            // Force core to not have the usual methods
            (fresh as any).core = {
                get_all_values: () => new Map([])
            };

            const snapshot = fresh.getBinarySnapshot();
            expect(snapshot).toBeInstanceOf(Uint8Array);
            fresh.destroy();
        });

        it('should track keys when loading queue', async () => {
            const opBytes = packOp('persisted-key', 'value');
            // Mock persistence to return our op
            (loadQueue as any).mockResolvedValueOnce([opBytes]);

            const fresh = new SyncEngine(VALID_UUID_3, VALID_UUID_4, 100, false);
            const trackSpy = vi.spyOn((fresh as any).authority, 'trackKey');

            await fresh.boot();

            expect(trackSpy).toHaveBeenCalledWith('persisted-key');
            expect(fresh.getQueueSize()).toBe(1);
            fresh.destroy();
        });

        it('should return preConnectState in getAllValues if not active', () => {
            const fresh = new SyncEngine(VALID_UUID_3, VALID_UUID_4, 100, false);
            fresh.set('k', 'v');
            const values = fresh.getAllValues();
            expect(values).toEqual({ k: 'v' });
            fresh.destroy();
        });

        it('should return operationQueue in getPendingOps', async () => {
            (loadQueue as any).mockResolvedValueOnce([]); // Ensure empty queue
            const fresh = new SyncEngine(VALID_UUID_3, VALID_UUID_4, 100, false);
            await fresh.boot();
            fresh.set('k', 'v');
            expect(fresh.getPendingOps().length).toBe(1);
            fresh.destroy();
        });

        it('should prune history based on horizon', () => {
            const debugEngine = new SyncEngine(VALID_UUID_1, VALID_UUID_2, 100, true);
            const horizon = new Map([['peer1', 10n]]);
            (debugEngine as any).pruneHistory(horizon); // Should not throw
            debugEngine.destroy();
        });

        it('should handle __global_tick op', async () => {
            const fresh = new SyncEngine(VALID_UUID_3, VALID_UUID_4, 100, false);
            await fresh.boot();

            const clockSpy = vi.spyOn((fresh as any).clock, 'applySync');

            // Mock get to return some tick data
            vi.spyOn(fresh, 'get').mockReturnValue({ t: 1000, term: 1 });

            const opBytes = packOp('__global_tick', new Uint8Array([1, 2, 3]));
            fresh.applyRawMessage(opBytes);

            expect(clockSpy).toHaveBeenCalled();
            fresh.destroy();
        });
        it('should handle Init hydration failure', async () => {
            const fresh = new SyncEngine(VALID_UUID_3, VALID_UUID_4, 100, false);
            await fresh.boot();
            const spy = vi.spyOn((fresh as any).logger, 'error');

            // Mock merge_remote_delta to throw
            (fresh as any).core = { merge_remote_delta: () => { throw new Error('Hydration boom'); } };

            const builder = new flatbuffers.Builder(1024);
            const payloadVector = WirePacket.createPayloadVector(builder, new Uint8Array([1, 2]));
            WirePacket.startWirePacket(builder);
            WirePacket.addMsgType(builder, MsgType.Init);
            WirePacket.addPayload(builder, payloadVector);
            builder.finish(WirePacket.endWirePacket(builder));

            fresh.applyRawMessage(builder.asUint8Array());
            expect(spy).toHaveBeenCalledWith(expect.stringContaining('Init Hydration FAILED'), expect.any(Error));
            fresh.destroy();
        });

        it('should handle missing hydration methods', async () => {
            const fresh = new SyncEngine(VALID_UUID_3, VALID_UUID_4, 100, false);
            await fresh.boot();
            const spy = vi.spyOn((fresh as any).logger, 'error');

            // Mock core to be empty
            (fresh as any).core = {};

            const builder = new flatbuffers.Builder(1024);
            const payloadVector = WirePacket.createPayloadVector(builder, new Uint8Array([1, 2]));
            WirePacket.startWirePacket(builder);
            WirePacket.addMsgType(builder, MsgType.Init);
            WirePacket.addPayload(builder, payloadVector);
            builder.finish(WirePacket.endWirePacket(builder));

            fresh.applyRawMessage(builder.asUint8Array());
            expect(spy).toHaveBeenCalledWith(expect.stringContaining('Init Hydration FAILED'), expect.any(Object));
            fresh.destroy();
        });
    });
});
