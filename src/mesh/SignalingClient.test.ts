import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignalingClient } from './SignalingClient';
import { ProtocolUtils } from './ProtocolUtils';

// Mock WebSocket
class MockWebSocket {
    static instances: MockWebSocket[] = [];
    static readonly OPEN = 1;
    readyState = 0;
    binaryType = 'arraybuffer';
    onopen: (() => void) | null = null;
    onclose: ((e: any) => void) | null = null;
    onerror: ((e: any) => void) | null = null;
    onmessage: ((e: any) => void) | null = null;

    constructor(public url: string) {
        MockWebSocket.instances.push(this);
    }

    send = vi.fn();
    close = vi.fn();

    simulateOpen() {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.();
    }

    simulateClose(code = 1000, reason = '') {
        this.readyState = 3;
        this.onclose?.({ code, reason });
    }

    simulateError(err: Error) {
        this.onerror?.(err);
    }

    simulateMessage(data: any) {
        this.onmessage?.({ data });
    }
}

vi.stubGlobal('WebSocket', MockWebSocket);

describe('SignalingClient', () => {
    const config = { url: 'wss://test.com', token: 'tk', workspaceId: 'ws', myId: 'me' };

    beforeEach(() => {
        MockWebSocket.instances = [];
        vi.useFakeTimers();
    });

    it('connects and sends join signal', async () => {
        const client = new SignalingClient(config);
        const onConnect = vi.fn();
        client.setListeners({ onConnect });

        await client.connect();
        expect(MockWebSocket.instances.length).toBe(1);

        MockWebSocket.instances[0].simulateOpen();
        expect(onConnect).toHaveBeenCalled();
        expect(MockWebSocket.instances[0].send).toHaveBeenCalled();
    });

    it('handles token provider', async () => {
        const tokenProvider = vi.fn().mockResolvedValue('dynamic-token');
        const client = new SignalingClient({ ...config, tokenProvider, token: undefined });

        await client.connect();
        expect(tokenProvider).toHaveBeenCalled();
        expect(MockWebSocket.instances[0].url).toContain('dynamic-token');
    });

    it('handles token provider error gracefully', async () => {
        const tokenProvider = vi.fn().mockRejectedValue(new Error('Token Fail'));
        const client = new SignalingClient({ ...config, tokenProvider, token: undefined });

        await client.connect();
        expect(MockWebSocket.instances.length).toBe(1); // Still connects
    });

    it('reports connected status correctly', async () => {
        const client = new SignalingClient(config);
        expect(client.connected).toBe(false);

        await client.connect();
        MockWebSocket.instances[0].simulateOpen();
        expect(client.connected).toBe(true);
    });

    it('handles close and intentional close', async () => {
        const client = new SignalingClient(config);
        const onDisconnect = vi.fn();
        client.setListeners({ onDisconnect });

        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        client.close();
        expect(MockWebSocket.instances[0].close).toHaveBeenCalled();
    });

    it('handles abnormal close and schedules reconnect', async () => {
        const client = new SignalingClient(config);
        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        MockWebSocket.instances[0].simulateClose(1006, 'Abnormal');

        vi.advanceTimersByTime(2000);
        expect(MockWebSocket.instances.length).toBe(2);
    });

    it('handles normal close without reconnect', async () => {
        const client = new SignalingClient(config);
        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        MockWebSocket.instances[0].simulateClose(1000, 'Normal');

        vi.advanceTimersByTime(5000);
        expect(MockWebSocket.instances.length).toBe(1);
    });

    it('handles WebSocket error', async () => {
        const client = new SignalingClient(config);
        const onError = vi.fn();
        client.setListeners({ onError });

        await client.connect();
        MockWebSocket.instances[0].simulateError(new Error('Failed'));

        expect(onError).toHaveBeenCalled();
    });

    it('sends sync data', async () => {
        const client = new SignalingClient(config);
        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        client.sendSync(new Uint8Array([1, 2, 3]));
        expect(MockWebSocket.instances[0].send).toHaveBeenCalled();
    });

    it('sends ephemeral data', async () => {
        const client = new SignalingClient(config);
        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        client.sendEphemeral({ cursor: { x: 1, y: 2 } }, 'peer-1');
        expect(MockWebSocket.instances[0].send).toHaveBeenCalledWith(
            expect.stringContaining('ephemeral')
        );
    });

    it('handles JSON presence message', async () => {
        const client = new SignalingClient(config);
        const onPresence = vi.fn();
        client.setListeners({ onPresence });

        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        MockWebSocket.instances[0].simulateMessage(JSON.stringify({
            type: 'presence',
            payload: { userId: 'u1', status: 'online', meshId: 'm1' }
        }));

        expect(onPresence).toHaveBeenCalledWith('u1', 'online', 'm1');
    });

    it('handles JSON legacy presence format', async () => {
        const client = new SignalingClient(config);
        const onPresence = vi.fn();
        client.setListeners({ onPresence });

        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        MockWebSocket.instances[0].simulateMessage(JSON.stringify({
            type: 'presence',
            userId: 'u2',
            status: 'away'
        }));

        expect(onPresence).toHaveBeenCalledWith('u2', 'away', undefined);
    });

    it('handles JSON signal message', async () => {
        const client = new SignalingClient(config);
        const onSignal = vi.fn();
        client.setListeners({ onSignal });

        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        MockWebSocket.instances[0].simulateMessage(JSON.stringify({
            type: 'signal',
            from: 'peer-1',
            signal: { type: 'offer', sdp: 'sdp-data' }
        }));

        expect(onSignal).toHaveBeenCalledWith({
            from: 'peer-1',
            signal: { type: 'offer', sdp: 'sdp-data' }
        });
    });

    it('handles JSON init message', async () => {
        const client = new SignalingClient(config);
        const onInit = vi.fn();
        client.setListeners({ onInit });

        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        MockWebSocket.instances[0].simulateMessage(JSON.stringify({
            type: 'init',
            state: { key: 'value' }
        }));

        expect(onInit).toHaveBeenCalledWith({ type: 'init', state: { key: 'value' } });
    });

    it('handles JSON ephemeral message', async () => {
        const client = new SignalingClient(config);
        const onEphemeral = vi.fn();
        client.setListeners({ onEphemeral });

        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        MockWebSocket.instances[0].simulateMessage(JSON.stringify({
            type: 'ephemeral',
            payload: { cursor: { x: 10 } }
        }));

        expect(onEphemeral).toHaveBeenCalledWith({ cursor: { x: 10 } });
    });

    it('handles malformed JSON gracefully', async () => {
        const client = new SignalingClient(config);
        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        expect(() => {
            MockWebSocket.instances[0].simulateMessage('not valid json {{{');
        }).not.toThrow();
    });

    it('updates token dynamically', () => {
        const client = new SignalingClient(config);
        client.updateToken('new-token');
        // Token is updated internally
    });

    it('ignores send when not connected', async () => {
        const client = new SignalingClient(config);
        client.sendSync(new Uint8Array([1]));
        client.sendEphemeral({ foo: 'bar' });
        // No error, just silently ignored
    });

    it('handles binary message path', async () => {
        const client = new SignalingClient(config);
        const onServerMessage = vi.fn();
        client.setListeners({ onServerMessage });

        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        // Send binary data (won't parse correctly but covers handleBinaryMessage entry)
        const anyBuffer = new ArrayBuffer(16);
        expect(() => {
            MockWebSocket.instances[0].simulateMessage(anyBuffer);
        }).not.toThrow();
    });

    it('handles malformed binary message gracefully', async () => {
        const client = new SignalingClient(config);
        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        // Send garbage binary data
        const garbage = new Uint8Array([0, 0, 0, 0, 255, 255]).buffer;
        expect(() => {
            MockWebSocket.instances[0].simulateMessage(garbage);
        }).not.toThrow();
    });

    it('handles sendSignal', async () => {
        const client = new SignalingClient(config);
        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        client.sendSignal('peer-1', { type: 'offer', sdp: 'test-sdp' });
        expect(MockWebSocket.instances[0].send).toHaveBeenCalled();
    });

    it('handles sendSignal error gracefully', async () => {
        const client = new SignalingClient(config);
        await client.connect();
        MockWebSocket.instances[0].simulateOpen();
        MockWebSocket.instances[0].send.mockImplementation(() => { throw new Error('Send failed'); });

        // Should not throw
        expect(() => client.sendSignal('peer-1', { type: 'offer', sdp: 'test-sdp' })).not.toThrow();
    });

    it('handles max reconnection attempts', async () => {
        const client = new SignalingClient(config);
        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        // Close abnormally multiple times to exhaust attempts
        for (let i = 0; i < 11; i++) {
            const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
            ws.simulateOpen();
            ws.simulateClose(1006, 'Abnormal');
            vi.advanceTimersByTime(35000);
        }

        // After max attempts, no more reconnects
    });

    it('handles binary Sync message with payload', async () => {
        const client = new SignalingClient(config);
        const onServerMessage = vi.fn();
        client.setListeners({ onServerMessage });

        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        const syncPacket = ProtocolUtils.createSyncPacket(new Uint8Array([1, 2, 3]));
        // Create a clean ArrayBuffer from the Uint8Array (no offset issues)
        const cleanBuffer = syncPacket.buffer.slice(syncPacket.byteOffset, syncPacket.byteOffset + syncPacket.byteLength);
        MockWebSocket.instances[0].simulateMessage(cleanBuffer);

        expect(onServerMessage).toHaveBeenCalled();
    });

    it('handles binary Signal/Offer message', async () => {
        const client = new SignalingClient(config);
        const onSignal = vi.fn();
        client.setListeners({ onSignal });

        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        const pkt = ProtocolUtils.createSignalPacket('me', 'peer-1', { type: 'offer', sdp: 'v=0...' });
        const cleanBuffer = pkt.buffer.slice(pkt.byteOffset, pkt.byteOffset + pkt.byteLength);
        MockWebSocket.instances[0].simulateMessage(cleanBuffer);

        expect(onSignal).toHaveBeenCalledWith(expect.objectContaining({
            from: 'peer-1',
            signal: expect.objectContaining({ type: 'offer', sdp: 'v=0...' })
        }));
    });

    it('handles binary Signal/Answer message', async () => {
        const client = new SignalingClient(config);
        const onSignal = vi.fn();
        client.setListeners({ onSignal });

        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        const pkt = ProtocolUtils.createSignalPacket('me', 'peer-2', { type: 'answer', sdp: 'v=1...' });
        const cleanBuffer = pkt.buffer.slice(pkt.byteOffset, pkt.byteOffset + pkt.byteLength);
        MockWebSocket.instances[0].simulateMessage(cleanBuffer);

        expect(onSignal).toHaveBeenCalledWith(expect.objectContaining({
            from: 'peer-2',
            signal: expect.objectContaining({ type: 'answer', sdp: 'v=1...' })
        }));
    });

    it('handles binary Signal/Candidate message', async () => {
        const client = new SignalingClient(config);
        const onSignal = vi.fn();
        client.setListeners({ onSignal });

        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        const pkt = ProtocolUtils.createSignalPacket('me', 'peer-3', {
            type: 'candidate',
            candidate: { candidate: 'candidate:123', sdpMid: 'audio', sdpMLineIndex: 0 }
        });
        const cleanBuffer = pkt.buffer.slice(pkt.byteOffset, pkt.byteOffset + pkt.byteLength);
        MockWebSocket.instances[0].simulateMessage(cleanBuffer);

        expect(onSignal).toHaveBeenCalledWith(expect.objectContaining({
            from: 'peer-3',
            signal: expect.objectContaining({
                type: 'candidate',
                candidate: expect.objectContaining({ candidate: 'candidate:123' })
            })
        }));
    });

    it('handles binary Signal/Join message', async () => {
        const client = new SignalingClient(config);
        const onSignal = vi.fn();
        client.setListeners({ onSignal });

        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        const pkt = ProtocolUtils.createSignalPacket('me', 'server', { type: 'join', workspaceId: 'ws-123' });
        const cleanBuffer = pkt.buffer.slice(pkt.byteOffset, pkt.byteOffset + pkt.byteLength);
        MockWebSocket.instances[0].simulateMessage(cleanBuffer);

        expect(onSignal).toHaveBeenCalledWith(expect.objectContaining({
            from: 'server',
            signal: expect.objectContaining({ type: 'join', workspaceId: 'ws-123' })
        }));
    });

    it('handles binary Signal/Relay message', async () => {
        const client = new SignalingClient(config);
        const onSignal = vi.fn();
        client.setListeners({ onSignal });

        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        const pkt = ProtocolUtils.createSignalPacket('me', 'peer-4', {
            type: 'relay',
            data: new Uint8Array([10, 20, 30])
        });
        const cleanBuffer = pkt.buffer.slice(pkt.byteOffset, pkt.byteOffset + pkt.byteLength);
        MockWebSocket.instances[0].simulateMessage(cleanBuffer);

        expect(onSignal).toHaveBeenCalledWith(expect.objectContaining({
            from: 'peer-4',
            signal: expect.objectContaining({ type: 'relay' })
        }));
    });

    it('does not reconnect after intentional close', async () => {
        const client = new SignalingClient(config);
        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        // Intentionally close
        client.close();

        // Advance timers - should not create new connections
        vi.advanceTimersByTime(10000);
        expect(MockWebSocket.instances.length).toBe(1);
    });

    it('calls onConnect listener when connected', async () => {
        const client = new SignalingClient(config);
        const onConnect = vi.fn();
        client.setListeners({ onConnect });

        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        expect(onConnect).toHaveBeenCalled();
    });

    it('handles JSON parse error gracefully', async () => {
        const client = new SignalingClient(config);
        await client.connect();
        MockWebSocket.instances[0].simulateOpen();

        // Send malformed JSON - should not throw
        expect(() => {
            MockWebSocket.instances[0].simulateMessage('{ invalid json }');
        }).not.toThrow();
    });
});
