
import * as flatbuffers from 'flatbuffers';
import { Op } from '../src/schema/nmeshed/op';
import { ColumnarOpBatch, ColumnarOpBatchT } from '../src/schema/nmeshed/columnar-op-batch';
import { WirePacket } from '../src/schema/nmeshed/wire-packet';
import { MsgType } from '../src/schema/nmeshed/msg-type';
import { ActorRegistry } from '../src/schema/nmeshed/actor-registry';
import { ActorMapping } from '../src/schema/nmeshed/actor-mapping';
import { ValueBlob, ValueBlobT } from '../src/schema/nmeshed/value-blob';

// --- Utils ---

function createOp(builder: flatbuffers.Builder, i: number, actorId: string): flatbuffers.Offset {
    const wsId = builder.createString('ws-123');
    const key = builder.createString(`key:${i}`);
    const valVec = Op.createValueVector(builder, new Uint8Array([1, 2, 3, 4]));
    const actor = builder.createString(actorId);

    return Op.createOp(
        builder,
        wsId,
        key,
        BigInt(Date.now() * 1000 + i),
        valVec,
        actor,
        BigInt(i),
        false
    );
}

function measureOps(count: number): number {
    let totalSize = 0;
    const actorId = 'actor-uuid-1234-5678';

    // Measure sum of individual Op packets (like current protocol)
    for (let i = 0; i < count; i++) {
        const builder = new flatbuffers.Builder(1024);
        const opOffset = createOp(builder, i, actorId);

        WirePacket.startWirePacket(builder);
        WirePacket.addMsgType(builder, MsgType.Op);
        WirePacket.addOp(builder, opOffset);
        const wp = WirePacket.endWirePacket(builder);
        builder.finish(wp);

        totalSize += builder.asUint8Array().length;
    }
    return totalSize;
}


function measureBatch(count: number): number {
    const builder = new flatbuffers.Builder(1024 * 1024);
    const actorId = 'actor-uuid-1234-5678';

    // 1. Create Actor Registry Packet (One time cost)
    const actorStr = builder.createString(actorId);
    ActorMapping.startActorMapping(builder);
    ActorMapping.addIdx(builder, 1);
    ActorMapping.addId(builder, actorStr);
    const mapping = ActorMapping.endActorMapping(builder);

    const mappingsVec = ActorRegistry.createMappingsVector(builder, [mapping]);
    const regOffset = ActorRegistry.createActorRegistry(builder, mappingsVec);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.ActorRegistry);
    WirePacket.addActorRegistry(builder, regOffset);
    const regWp = WirePacket.endWirePacket(builder);
    builder.finish(regWp);

    let totalSize = builder.asUint8Array().length;

    // 2. Create Columnar Batch
    builder.clear();

    const wsId = builder.createString('ws-123');

    const keys: flatbuffers.Offset[] = [];
    const timestamps: bigint[] = [];
    const values: ValueBlobT[] = [];
    const actorIdxs: number[] = [];
    const seqs: bigint[] = [];
    const isDeletes: boolean[] = [];

    const baseTs = BigInt(Date.now() * 1000);

    for (let i = 0; i < count; i++) {
        keys.push(builder.createString(`key:${i}`));
        timestamps.push(BigInt(i)); // Delta from base? The schema says delta, TS impl expects delta

        const blob = new ValueBlobT();
        blob.data = [1, 2, 3, 4];
        values.push(blob);

        actorIdxs.push(1); // Mapped to index 1
        seqs.push(BigInt(1)); // Delta seq?
        isDeletes.push(false);
    }

    // Pack vectors
    const keysVec = ColumnarOpBatch.createKeysVector(builder, keys);
    const tsVec = ColumnarOpBatch.createTimestampsVector(builder, timestamps);
    // values objects need packing
    // But wait, createObjList in generated code handles T objects? 
    // Nope, for constructing we need offsets.

    const blobOffsets = values.map(v => {
        const d = ValueBlob.createDataVector(builder, v.data);
        ValueBlob.startValueBlob(builder);
        ValueBlob.addData(builder, d);
        return ValueBlob.endValueBlob(builder);
    });
    const blobsVec = ColumnarOpBatch.createValueBlobsVector(builder, blobOffsets);

    const actorsVec = ColumnarOpBatch.createActorIdxsVector(builder, new Uint32Array(actorIdxs));
    const seqsVec = ColumnarOpBatch.createSeqsVector(builder, seqs);
    const delVec = ColumnarOpBatch.createIsDeletesVector(builder, isDeletes);

    ColumnarOpBatch.startColumnarOpBatch(builder);
    ColumnarOpBatch.addWorkspaceId(builder, wsId);
    ColumnarOpBatch.addKeys(builder, keysVec);
    ColumnarOpBatch.addTimestamps(builder, tsVec);
    ColumnarOpBatch.addValueBlobs(builder, blobsVec);
    ColumnarOpBatch.addActorIdxs(builder, actorsVec);
    ColumnarOpBatch.addSeqs(builder, seqsVec);
    ColumnarOpBatch.addIsDeletes(builder, delVec);
    const batchOffset = ColumnarOpBatch.endColumnarOpBatch(builder);

    WirePacket.startWirePacket(builder);
    WirePacket.addMsgType(builder, MsgType.ColumnarBatch);
    WirePacket.addBatch(builder, batchOffset);
    const wp = WirePacket.endWirePacket(builder);
    builder.finish(wp);

    totalSize += builder.asUint8Array().length;

    return totalSize;
}

console.log('--- Benchmarking Columnar Compression ---');

const counts = [100, 1000, 10000];

for (const c of counts) {
    const opSize = measureOps(c);
    const batchSize = measureBatch(c);
    const ratio = (batchSize / opSize) * 100;

    console.log(`\nCount: ${c}`);
    console.log(`  Individual Ops: ${(opSize / 1024).toFixed(2)} KB`);
    console.log(`  Columnar Batch: ${(batchSize / 1024).toFixed(2)} KB`);
    console.log(`  Ratio: ${ratio.toFixed(2)}% (Compression: ${(100 - ratio).toFixed(2)}%)`);
}
