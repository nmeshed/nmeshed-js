
import { ByteBuffer, Builder } from 'flatbuffers';
import { WirePacket } from './schema/nmeshed/wire-packet';
import { MsgType } from './schema/nmeshed/msg-type';
import { Op } from './schema/nmeshed/op';
import { encodeValue, decodeValue } from './codec';

// Mock MockWasmCore behavior
class MockWasmCoreV2 {
    state: Record<string, any> = {};

    apply_local_op(key: string, value: Uint8Array) {
        // Construct WirePacket for the op to return to Client
        const builder = new Builder(1024);
        const valBytes = value; // Already encoded FBC

        // --- KEY LOGIC START ---
        // WORKAROUND: Write value to payload field
        const payloadOffset = WirePacket.createPayloadVector(builder, valBytes);

        WirePacket.startWirePacket(builder);
        WirePacket.addMsgType(builder, MsgType.Op);
        WirePacket.addPayload(builder, payloadOffset); // Add payload
        const packetOffset = WirePacket.endWirePacket(builder);
        builder.finish(packetOffset);
        // --- KEY LOGIC END ---

        return builder.asUint8Array();
    }
}

async function run() {
    console.log("--- Reproduction Script V2 Start ---");

    // 1. Test encodeValue directly
    const val = 123;
    const fbcBytes = encodeValue(val);
    console.log(`Encoded ${val} to FBC bytes:`, Array.from(fbcBytes));

    // 2. Test MockWasmCore Logic
    const mockWasm = new MockWasmCoreV2();
    const key = "test-key";

    // apply_local_op returns Uint8Array (the WirePacket bytes)
    const packetBytes = mockWasm.apply_local_op(key, fbcBytes);

    console.log(`Packet bytes length: ${packetBytes.length}`);

    // 3. Test Parsing
    const buf = new ByteBuffer(packetBytes);
    const wire = WirePacket.getRootAsWirePacket(buf);
    const msgType = wire.msgType();
    console.log(`Parsed MsgType: ${msgType}`);

    // Check Payload
    const payloadBytes = wire.payloadArray();
    if (payloadBytes) {
        console.log(`Extracted payloadBytes length: ${payloadBytes.length}`);
        console.log(`Extracted payloadBytes:`, Array.from(payloadBytes));

        // Should match FBC bytes
        try {
            const decoded = decodeValue(payloadBytes);
            console.log(`Decoded payload value:`, decoded);
        } catch (e) { console.error("Decode failed", e); }
    } else {
        console.error("Payload is null!");
    }
}

run().catch(e => console.error(e));
