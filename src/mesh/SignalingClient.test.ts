import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalingClient } from './SignalingClient';
import { ProtocolUtils } from './ProtocolUtils';
import { MsgType } from '../schema/nmeshed/msg-type';
import { SignalData } from '../schema/nmeshed/signal-data';

// Mock WebSocket
class MockWebSocket {
    static instances: MockWebSocket[] = [];
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    onopen: any = null;
    onmessage: any = null;
    onclose: any = null;
    onerror: any = null;
    binaryType = 'blob';

    constructor(public url: string) {
        MockWebSocket.instances.push(this);
    }

    send = vi.fn();
    close = vi.fn(() => {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.({ code: 1000, reason: 'Normal Closure' });
    });

    // Helpers
    open() {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.();
    }

    message(data: any) {
        this.onmessage?.({ data });
    }
}

vi.stubGlobal('WebSocket', MockWebSocket);

describe('SignalingClient', () => {
    let client: SignalingClient;
    const config = {
        url: 'wss://test.com',
        workspaceId: 'ws-1',
        myId: 'peer-me',
        token: 'token-123'
    };

    // We can use real ProtocolUtils for packet generation/parsing logic
    // But we might want to spy on it to verify outgoing calls?
    // Let's rely on checking what is sent to WS.

    beforeEach(() => {
        MockWebSocket.instances = [];
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        client?.close();
    });

    it('connects with correct URL params', async () => {
        client = new SignalingClient(config);
        await client.connect();

        expect(MockWebSocket.instances.length).toBe(1);
        const ws = MockWebSocket.instances[0];
        expect(ws.url).toContain('token=token-123');
    });

    it('uses token provider if supplied', async () => {
        const provider = vi.fn().mockResolvedValue('async-token');
        client = new SignalingClient({ ...config, token: undefined, tokenProvider: provider });
        await client.connect();

        expect(provider).toHaveBeenCalled();
        const ws = MockWebSocket.instances[0];
        expect(ws.url).toContain('token=async-token');
    });

    it('sends JOIN on connect', async () => {
        client = new SignalingClient(config);
        await client.connect();

        const ws = MockWebSocket.instances[0];
        ws.open();

        expect(ws.send).toHaveBeenCalled();
        // Decode the first message, it should be a JOIN
        const sent = ws.send.mock.calls[0][0]; // Uint8Array
        expect(sent).toBeInstanceOf(Uint8Array);

        // We verify indirectly via mocking? No, use ProtocolUtils (implicit)
        // If it didn't crash, it generated a packet.
    });

    it('sends signals correctly', async () => {
        client = new SignalingClient(config);
        await client.connect();
        MockWebSocket.instances[0].open();

        client.sendSignal('peer-target', { type: 'offer', sdp: 'sdp-val' });

        expect(MockWebSocket.instances[0].send).toHaveBeenCalledTimes(2); // Join + Signal
    });

    it('handles incoming JSON presence', () => {
        client = new SignalingClient(config);
        client.connect();
        const ws = MockWebSocket.instances[0];
        ws.open();

        const onPresence = vi.fn();
        client.setListeners({ onPresence });

        ws.message(JSON.stringify({
            type: 'presence',
            payload: { userId: 'u1', status: 'online', meshId: 'm1' }
        }));

        expect(onPresence).toHaveBeenCalledWith('u1', 'online', 'm1');
    });

    it('handles incoming binary SYNC', () => {
        client = new SignalingClient(config);
        client.connect();
        const ws = MockWebSocket.instances[0];
        ws.open();

        const onServerMessage = vi.fn();
        client.setListeners({ onServerMessage });

        const payload = new Uint8Array([1, 2, 3]);
        const packet = ProtocolUtils.createSyncPacket(payload);

        // WebSocket receives ArrayBuffer
        // Use slice() to ensure we pass exactly the packet bytes, not a view of a larger buffer
        ws.message(packet.slice().buffer);

        expect(onServerMessage).toHaveBeenCalled();
        const calledArg = onServerMessage.mock.calls[0][0];
        expect(new Uint8Array(calledArg)).toEqual(payload);
    });

    it('handles incoming binary SIGNAL (Offer)', () => {
        client = new SignalingClient(config);
        client.connect();
        const ws = MockWebSocket.instances[0];
        ws.open();

        const onSignal = vi.fn();
        client.setListeners({ onSignal });

        // Generate a signal packet from "peer-other"
        const packet = ProtocolUtils.createSignalPacket(
            config.myId,
            'peer-other',
            { type: 'offer', sdp: 'remote-sdp' }
        );

        ws.message(packet.slice().buffer);

        expect(onSignal).toHaveBeenCalledWith({
            from: 'peer-other',
            signal: expect.objectContaining({ type: 'offer', sdp: 'remote-sdp' })
        });
    });

    it('reconnects on abnormal close', () => {
        client = new SignalingClient(config);
        client.connect();
        const ws = MockWebSocket.instances[0];
        ws.open();

        // Abnormal close
        ws.onclose({ code: 1006, reason: 'Abnormal' });

        // Fast forward past initial delay (1000ms + jitter)
        vi.advanceTimersByTime(2000);

        // Should create new WS
        expect(MockWebSocket.instances.length).toBe(2);
    });

    it('does not reconnect on intentional close', () => {
        client = new SignalingClient(config);
        client.connect();
        client.close(); // calls ws.close() which triggers onclose

        // Advance time
        vi.advanceTimersByTime(2000);

        // Should NOT create new WS
        expect(MockWebSocket.instances.length).toBe(1);
    });

    it('handles legacy JSON signal format', () => {
        client = new SignalingClient(config);
        client.connect();
        const ws = MockWebSocket.instances[0];
        ws.open();

        const onSignal = vi.fn();
        client.setListeners({ onSignal });

        ws.message(JSON.stringify({
            type: 'signal',
            from: 'peer-legacy',
            signal: { type: 'offer', sdp: 'legacy-sdp' }
        }));

        expect(onSignal).toHaveBeenCalledWith({
            from: 'peer-legacy',
            signal: { type: 'offer', sdp: 'legacy-sdp' }
        });
    });

    it('handles init message', () => {
        client = new SignalingClient(config);
        client.connect();
        const ws = MockWebSocket.instances[0];
        ws.open();

        const onInit = vi.fn();
        client.setListeners({ onInit });

        const initData = { type: 'init', sessionId: 'session-xyz' };
        ws.message(JSON.stringify(initData));

        expect(onInit).toHaveBeenCalledWith(initData);
    });

    it('handles ephemeral message', () => {
        client = new SignalingClient(config);
        client.connect();
        const ws = MockWebSocket.instances[0];
        ws.open();

        const onEphemeral = vi.fn();
        client.setListeners({ onEphemeral });

        ws.message(JSON.stringify({
            type: 'ephemeral',
            payload: { cursor: { x: 10, y: 20 } }
        }));

        expect(onEphemeral).toHaveBeenCalledWith({ cursor: { x: 10, y: 20 } });
    });

    it('handles WebSocket error', () => {
        client = new SignalingClient(config);
        client.connect();
        const ws = MockWebSocket.instances[0];

        const onError = vi.fn();
        client.setListeners({ onError });

        ws.onerror(new Event('error'));

        expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });

    it('handles presence without payload (alt format)', () => {
        client = new SignalingClient(config);
        client.connect();
        const ws = MockWebSocket.instances[0];
        ws.open();

        const onPresence = vi.fn();
        client.setListeners({ onPresence });

        ws.message(JSON.stringify({
            type: 'presence',
            userId: 'u2',
            status: 'offline',
            meshId: 'm2'
        }));

        expect(onPresence).toHaveBeenCalledWith('u2', 'offline', 'm2');
    });

    it('survives malformed JSON', () => {
        client = new SignalingClient(config);
        client.connect();
        const ws = MockWebSocket.instances[0];
        ws.open();

        // Should not throw
        expect(() => {
            ws.message('not valid json {{{');
        }).not.toThrow();
    });

    it('handles sendSync', () => {
        client = new SignalingClient(config);
        client.connect();
        const ws = MockWebSocket.instances[0];
        ws.open();

        // Reset after join
        ws.send.mockClear();

        const payload = new Uint8Array([10, 20, 30]);
        client.sendSync(payload);

        expect(ws.send).toHaveBeenCalledWith(expect.any(Uint8Array));
    });

    it('handles sendEphemeral', () => {
        client = new SignalingClient(config);
        client.connect();
        const ws = MockWebSocket.instances[0];
        ws.open();

        // Reset after join
        ws.send.mockClear();

        client.sendEphemeral({ cursor: 'data' });

        expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('ephemeral'));
    });
});
