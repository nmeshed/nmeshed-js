
import { ByteBuffer, Builder } from 'flatbuffers';
import { WirePacket } from './schema/nmeshed/wire-packet';
import { MsgType } from './schema/nmeshed/msg-type';
import { Op } from './schema/nmeshed/op';
import { encodeValue, decodeValue } from './codec';
import { MockWasmCore } from './test-utils/mocks';

async function run() {
    console.log("--- Reproduction Script Start ---");

    // 1. Test encodeValue directly
    const val = 123;
    const fbcBytes = encodeValue(val);
    console.log(`Encoded ${val} to FBC bytes:`, Array.from(fbcBytes));
    // Expected: [3, ... 8 bytes float ...]
    // Tag 3 = TAG_NUMBER.

    // 2. Test MockWasmCore.apply_local_op
    const mockWasm = new MockWasmCore("token");
    const key = "test-key";

    // apply_local_op returns Uint8Array (the WirePacket bytes)
    const packetBytes = mockWasm.apply_local_op(key, fbcBytes);

    console.log(`Packet bytes length: ${packetBytes.length}`);
    // console.log(`Packet bytes:`, Array.from(packetBytes));

    // 3. Test Parsing (Logic from MockWebSocket.send)
    const buf = new ByteBuffer(packetBytes);
    const wire = WirePacket.getRootAsWirePacket(buf);
    const msgType = wire.msgType();

    console.log(`Parsed MsgType: ${msgType} (Expected ${MsgType.Op})`);

    if (msgType === MsgType.Op) {
        const op = wire.op();
        if (op) {
            console.log(`Op found. Key: ${op.key()}`);

            const valBytes = op.valueArray();
            if (valBytes) {
                console.log(`Extracted valBytes length: ${valBytes.length}`);
                console.log(`Extracted valBytes:`, Array.from(valBytes));

                try {
                    const decoded = decodeValue(valBytes);
                    console.log(`Decoded value:`, decoded);
                } catch (e) {
                    console.error("DECODE ERROR:", e);
                }
            } else {
                console.error("valBytes is null!");
            }
        } else {
            console.error("Op is null!");
        }
    } else {
        console.error("MsgType is not Op!");
    }
}

run().catch(e => console.error(e));
