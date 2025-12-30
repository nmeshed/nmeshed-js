
import { SyncEngine, EngineState } from '../src/core/SyncEngine';
import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../src/schema/nmeshed/wire-packet';
import { MsgType } from '../src/schema/nmeshed/msg-type';
import { Op } from '../src/schema/nmeshed/op';

// Helpers
function createWireOp(key: string, value: Uint8Array, timestamp: bigint = BigInt(0)): Uint8Array {
    const builder = new flatbuffers.Builder(1024);
    const keyOffset = builder.createString(key);
    const valOffset = Op.createValueVector(builder, value);
    Op.startOp(builder);
    Op.addKey(builder, keyOffset);
    Op.addValue(builder, valOffset);
    Op.addTimestamp(builder, timestamp);
    const opOffset = Op.endOp(builder);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.Op);
    WirePacket.addOp(builder, opOffset);
    const packetOffset = WirePacket.endWirePacket(builder);
    builder.finish(packetOffset);
    return builder.asUint8Array().slice();
}

class MockWasmCore {
    public state: Map<string, Uint8Array> = new Map();
    public timestamps: Map<string, bigint> = new Map();

    constructor(public workspaceId: string, public mode: string) { }

    apply_remote_delta(delta: Uint8Array) {
        return [delta];
    }

    apply_local_op(key: string, value: Uint8Array, timestamp: bigint) {
        this.state.set(key, value);
        this.timestamps.set(key, timestamp);
        return createWireOp(key, value, timestamp);
    }

    // Simplifed for mem test
    apply_vessel(bytes: Uint8Array): void { }
    merge_remote_delta(packet_data: Uint8Array) { return []; }
    receive_sync_message(_message: Uint8Array) { return Promise.resolve(); }
    load_snapshot(snapshot: Uint8Array): void { }
    get_state() { return {}; }
    get_all_values() { return {}; }
    get(key: string) { return this.state.get(key); }
    set(key: string, value: Uint8Array) { this.state.set(key, value); }
    get_raw_value(key: string) { return this.state.get(key); }
    get_heads() { return []; }
    prune(horizon: any) { console.log("Pruning called"); }
}

async function runMemoryStress() {
    console.log("Starting Memory Stress Test...");

    // Config
    const PEER_COUNT = 10;
    const OPS_PER_PEER = 1000;

    const engines: SyncEngine[] = [];

    // Setup
    for (let i = 0; i < PEER_COUNT; i++) {
        const engine = new SyncEngine('mem-test', `peer-${i}`);
        const core = new MockWasmCore('mem-test', 'crdt');
        (engine as any).core = core;
        (engine as any)._state = EngineState.ACTIVE;
        engines.push(engine);
    }

    const startUsage = process.memoryUsage().heapUsed;
    console.log(`Start Heap: ${(startUsage / 1024 / 1024).toFixed(2)} MB`);

    // Run Ops
    for (let j = 0; j < OPS_PER_PEER; j++) {
        for (let i = 0; i < PEER_COUNT; i++) {
            engines[i].set(`key-${j}`, `value-${j}`);

            // Periodically clear queues to simulate processing
            const q = (engines[i] as any).operationQueue;
            if (q) {
                if (typeof q.clear === 'function') q.clear();
                else if (typeof q.shift === 'function') while (q.length > 0) q.shift();
            } else {
                if (j === 0 && i === 0) console.log("opQueue undefined on engine:", Object.keys(engines[i]));
            }
        }

        if (j % 100 === 0) {
            global.gc?.();
        }
    }

    global.gc?.();
    const endUsage = process.memoryUsage().heapUsed;
    console.log(`End Heap: ${(endUsage / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Delta: ${((endUsage - startUsage) / 1024 / 1024).toFixed(2)} MB`);

    const vectorSize = (engines[0] as any).localVector.size;
    console.log(`Local Vector Size: ${vectorSize}`);
}

runMemoryStress();
