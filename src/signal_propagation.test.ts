import { describe, it, expect, vi } from 'vitest';
import { WebSocketTransport } from './transport/WebSocketTransport';
import { EventEmitter } from './utils/EventEmitter';

// Mock WebSocket
class MockWebSocket {
    onopen: () => void = () => { };
    onmessage: (event: any) => void = () => { };
    onclose: (event: any) => void = () => { };
    send: (data: any) => void = () => { };
    close: () => void = () => { };
    binaryType = 'blob';

    constructor(public url: string) {
        setTimeout(() => this.onopen(), 10);
    }
}

global.WebSocket = MockWebSocket as any;

describe('Signal Propagation', () => {
    it('should emit peerJoin when receiving Presence(Join) packet', async () => {
        const transport = new WebSocketTransport('ws://localhost:9000', {
            workspaceId: 'test-ws',
            peerId: 'p1',
            token: 'test-token',
            autoReconnect: false
        });

        const onPeerJoin = vi.fn();
        transport.on('peerJoin', onPeerJoin);

        await transport.connect();

        // Construct Presence(0x03) Packet
        // [MsgType(1)] [Len(4)] [WsUUID(16)] [UserLen(4)] [User(?)] [Status(1)]
        const userId = "user-123";
        const userIdBytes = new TextEncoder().encode(userId);

        const payloadLen = 16 + 4 + userIdBytes.length + 1; // 21 + N
        const packetSize = 1 + 4 + payloadLen;

        const buffer = new Uint8Array(packetSize);
        const view = new DataView(buffer.buffer);
        let offset = 0;

        // Header
        view.setUint8(offset++, 0x03); // MsgType::Presence
        view.setUint32(offset, payloadLen, true); // Payload Len (LE)
        offset += 4;

        // Payload
        // Skip Workspace UUID (fill with 0s)
        offset += 16;

        view.setUint32(offset, userIdBytes.length, true); // UserLen
        offset += 4;

        buffer.set(userIdBytes, offset); // UserId
        offset += userIdBytes.length;

        view.setUint8(offset, 0); // Status = 0 (Join)

        // Inject message
        (transport as any).ws.onmessage({ data: buffer });

        expect(onPeerJoin).toHaveBeenCalledWith(userId);
    });

    it('should emit peerDisconnect when receiving Presence(Leave) packet', async () => {
        const transport = new WebSocketTransport('ws://localhost:9000', {
            workspaceId: 'test-ws',
            peerId: 'p1',
            token: 'test-token',
            autoReconnect: false
        });

        const onPeerDisconnect = vi.fn();
        transport.on('peerDisconnect', onPeerDisconnect);

        await transport.connect();

        // Construct Presence(0x03) Packet - Leave
        const userId = "user-456";
        const userIdBytes = new TextEncoder().encode(userId);
        const payloadLen = 16 + 4 + userIdBytes.length + 1;
        const packetSize = 1 + 4 + payloadLen;

        const buffer = new Uint8Array(packetSize);
        const view = new DataView(buffer.buffer);
        let offset = 0;

        view.setUint8(offset++, 0x03);
        view.setUint32(offset, payloadLen, true);
        offset += 4;
        offset += 16;
        view.setUint32(offset, userIdBytes.length, true);
        offset += 4;
        buffer.set(userIdBytes, offset);
        offset += userIdBytes.length;
        view.setUint8(offset, 1); // Status = 1 (Leave)

        (transport as any).ws.onmessage({ data: buffer });

        expect(onPeerDisconnect).toHaveBeenCalledWith(userId);
    });

    it('should emit ephemeral event when receiving Signal packet', async () => {
        const transport = new WebSocketTransport('ws://localhost:9000', {
            workspaceId: 'test-ws',
            peerId: 'p1',
            token: 'test-token',
            autoReconnect: false
        });

        const onEphemeral = vi.fn();
        transport.on('ephemeral', onEphemeral);

        await transport.connect();

        const senderId = "sender-1";
        const senderIdBytes = new TextEncoder().encode(senderId);
        const data = new Uint8Array([1, 2, 3, 4]);

        // Signal Payload: [SenderLen(4)] [Sender] [ValLen(4)] [Value]
        const signalPayloadLen = 4 + senderIdBytes.length + 4 + data.length;
        const packetSize = 1 + 4 + signalPayloadLen; // [MsgType] [PayloadLen] [Payload]

        const buffer = new Uint8Array(packetSize);
        const view = new DataView(buffer.buffer);
        let offset = 0;

        view.setUint8(offset++, 0x04); // MsgType::Signal
        view.setUint32(offset, signalPayloadLen, true);
        offset += 4;

        // Signal Payload
        view.setUint32(offset, senderIdBytes.length, true);
        offset += 4;
        buffer.set(senderIdBytes, offset);
        offset += senderIdBytes.length;

        view.setUint32(offset, data.length, true);
        offset += 4;
        buffer.set(data, offset);

        (transport as any).ws.onmessage({ data: buffer });

        expect(onEphemeral).toHaveBeenCalledWith(data, senderId);
    });
});
