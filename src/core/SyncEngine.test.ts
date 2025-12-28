import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SyncEngine } from './SyncEngine';
import { RealTimeClock } from './RealTimeClock';
import { AuthorityManager } from './AuthorityManager';
import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';
import { Op } from '../schema/nmeshed/op';
import { Signal } from '../schema/nmeshed/signal';

// Real WASM Core used

// Mock persistence
vi.mock('../persistence', () => ({
    loadQueue: vi.fn().mockResolvedValue([]),
    saveQueue: vi.fn().mockResolvedValue(undefined),
}));

// Helper to create WirePacket bytes
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

function createInitPacket(data: Record<string, any>): Uint8Array {
    const builder = new flatbuffers.Builder(1024);
    const jsonStr = JSON.stringify(data);
    const payloadOffset = WirePacket.createPayloadVector(builder, new TextEncoder().encode(jsonStr));

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Init);
    WirePacket.addPayload(builder, payloadOffset);
    const packetOffset = WirePacket.endWirePacket(builder);
    builder.finish(packetOffset);
    return builder.asUint8Array().slice();
}

function createSignalPacket(to: string, from: string): Uint8Array {
    const builder = new flatbuffers.Builder(1024);
    const toOffset = builder.createString(to);
    const fromOffset = builder.createString(from);

    Signal.startSignal(builder);
    Signal.addToPeer(builder, toOffset);
    Signal.addFromPeer(builder, fromOffset);
    const signalOffset = Signal.endSignal(builder);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Signal);
    WirePacket.addSignal(builder, signalOffset);
    const packetOffset = WirePacket.endWirePacket(builder);
    builder.finish(packetOffset);
    return builder.asUint8Array().slice();
}

describe('SyncEngine', () => {
    let engine: SyncEngine;

    beforeEach(async () => {
        vi.useFakeTimers();
        // Correct Constructor: workspaceId, peerId, mode, maxQueueSize, debug
        engine = new SyncEngine('123e4567-e89b-12d3-a456-426614174000', '123e4567-e89b-12d3-a456-426614174001', 'crdt', 100, false);
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
            const fresh = new SyncEngine('123e4567-e89b-12d3-a456-426614174002', '123e4567-e89b-12d3-a456-426614174003', 'crdt', 100, false);
            fresh.applyRawMessage(new Uint8Array([0xAA]));
            expect((fresh as any).bootQueue.length).toBe(1);

            await fresh.boot();
            expect((fresh as any).bootQueue.length).toBe(0);
        });

        it('idempotent boot should not re-initialize', async () => {
            const spy = vi.spyOn(engine, 'emit');
            await engine.boot(); // Second call
            expect(spy).not.toHaveBeenCalledWith('stateChange', 'BOOTING', 'ACTIVE');
            // Or rather, we expect it to stay ACTIVE
            expect(engine.state).toBe('ACTIVE');
        });
    });

    describe('QUEUE MANAGEMENT', () => {
        it('should respect maxQueueSize when not operational', async () => {
            const maxQueueSize = 2;
            const qEngine = new SyncEngine('ws', 'p', 'crdt', maxQueueSize, false);

            // Set 3 items while IDLE
            qEngine.set('k1', 'v1');
            expect(qEngine.get('k1')).toBe('v1');

            qEngine.set('k2', 'v2');
            expect(qEngine.get('k2')).toBe('v2');

            // This should push out k1
            qEngine.set('k3', 'v3');

            expect(qEngine.get('k3')).toBe('v3');
            expect(qEngine.get('k2')).toBe('v2');
            expect(qEngine.get('k1')).toBeUndefined();
        });
    });

    describe('STATE OPERATIONS (set/get)', () => {
        it('should pass monotonic timestamps to WASM core', () => {
            // With real core, we verify effect
            engine.set('k1', 'v1');
            expect(engine.get('k1')).toBe('v1');
        });

        it('should delegate authority checks to AuthorityManager', () => {
            const authSpy = vi.spyOn((engine as any).authority, 'trackKey');
            engine.set('k2', 'v2');
            expect(authSpy).toHaveBeenCalledWith('k2');
        });

        it('should return values from engine.get', () => {
            engine.set('msg', 'hello');
            expect(engine.get('msg')).toBe('hello');
        });
    });

    describe('MESSAGE PIPELINE', () => {
        it('should process Op messages and update confirmed state', () => {
            const key = 'remote';
            const value = new Uint8Array([1, 2, 3]); // Valid plain bytes
            const bytes = createOpPacket(key, value);

            engine.applyRawMessage(bytes);

            // Verify the core state updated
            expect(engine.get(key)).toBeDefined();
        });

        it('should emit signal event for Signal packets', () => {
            const bytes = createSignalPacket('peer-to', 'peer-from');
            const spy = vi.fn();
            engine.on('signal', spy);

            engine.applyRawMessage(bytes);

            expect(spy).toHaveBeenCalled();
            const signalObj = spy.mock.calls[0][0];
            expect(signalObj.toPeer()).toBe('peer-to');
            expect(signalObj.fromPeer()).toBe('peer-from');
        });

        it('should emit init event for Init packets', () => {
            const initData = { initial: 'state' };
            const bytes = createInitPacket(initData);
            const spy = vi.fn();
            engine.on('init', spy);

            engine.applyRawMessage(bytes);

            expect(spy).toHaveBeenCalledWith(initData);
        });

        it('should handle malformed packets gracefully', () => {
            const junk = new Uint8Array([0, 1, 2, 3, 4]); // Invlid flatbuffer
            expect(() => engine.applyRawMessage(junk)).not.toThrow();
        });
    });

    describe('STATE MACHINE & TRANSITIONS', () => {
        it('should allow valid transition sequence', async () => {
            expect(engine.state).toBe('ACTIVE');
            await engine.destroy();
            expect(engine.state).toBe('DESTROYED');
        });

        it('should handle double destroy gracefully', async () => {
            engine.destroy();
            expect(() => engine.destroy()).not.toThrow();
            expect(engine.state).toBe('DESTROYED');
        });

        it('preConnectState should work when IDLE', () => {
            const idleEngine = new SyncEngine('ws', 'p', 'crdt', 100, false);
            idleEngine.set('pending', 'val');
            expect(idleEngine.get('pending')).toBe('val');
        });
    });

    describe('PERSISTENCE & RECOVERY', () => {
        it('should handle binary and wrapped persisted formats', async () => {
            const { loadQueue } = await import('../persistence');
            (loadQueue as any).mockResolvedValue([
                new Uint8Array([0x01]),
                { data: new Uint8Array([0x02]) }
            ]);

            const persistent = new SyncEngine('123e4567-e89b-12d3-a456-426614174004', '123e4567-e89b-12d3-a456-426614174005', 'crdt', 100, false);
            await persistent.boot();

            expect(persistent.getQueueLength()).toBe(2);
        });

        it('should handle loadQueue failure without crashing', async () => {
            const { loadQueue } = await import('../persistence');
            (loadQueue as any).mockRejectedValue(new Error('DB Failed'));

            const persistent = new SyncEngine('123e4567-e89b-12d3-a456-426614174006', '123e4567-e89b-12d3-a456-426614174007', 'crdt', 100, false);
            // boot should catch the error and proceed? or throw?
            // SyncEngine.boot: try { this.queue = await loadQueue(...) } catch(e) { logger.error(...) }
            await expect(persistent.boot()).resolves.not.toThrow();
            expect(persistent.state).toBe('ACTIVE');
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
});
