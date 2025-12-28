import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalingClient } from './SignalingClient';
import { MockWebSocket, setupTestMocks, teardownTestMocks } from '../../test-utils/mocks';
import { ProtocolUtils } from './ProtocolUtils';
import { logger } from '../../utils/Logger';
import { WirePacket } from '../../schema/nmeshed/wire-packet';

// Stub logger to avoid noise - inline to fix hoisting issues
vi.mock('../../utils/Logger', () => {
    const mockLoggerInstance = {
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        child: vi.fn(),
        setLogLevel: vi.fn(),
    };
    // Logger must be a class that returns mockLoggerInstance when instantiated
    class MockLogger {
        debug = mockLoggerInstance.debug;
        error = mockLoggerInstance.error;
        warn = mockLoggerInstance.warn;
        info = mockLoggerInstance.info;
        child = mockLoggerInstance.child;
        setLogLevel = mockLoggerInstance.setLogLevel;
    }
    return {
        Logger: MockLogger,
        logger: mockLoggerInstance
    };
});

describe('SignalingClient', () => {
    let client: SignalingClient;
    const config = {
        url: 'ws://test.com',
        workspaceId: 'ws1',
        myId: 'user1',
        token: 'auth-token'
    };

    beforeEach(() => {
        setupTestMocks();
        // Use real timers but shorten the delay for testing
        (SignalingClient as any).BASE_RECONNECT_DELAY_MS = 10;
        client = new SignalingClient(config);
    });

    afterEach(() => {
        teardownTestMocks();
        vi.clearAllMocks();
    });

    it('should connect to the correct URL with token', async () => {
        client.connect();

        expect(MockWebSocket.instances.length).toBe(1);
        const ws = MockWebSocket.instances[0];
        expect(ws.url).toBe('ws://test.com?token=auth-token');
    });

    it('should use token provider if available', async () => {
        const provider = vi.fn().mockResolvedValue('dynamic-token');
        client = new SignalingClient({ ...config, token: undefined, tokenProvider: provider });

        await client.connect();

        expect(provider).toHaveBeenCalled();
        expect(MockWebSocket.instances[0].url).toBe('ws://test.com?token=dynamic-token');
    });

    it('should emit onConnect when WebSocket opens', () => {
        const onConnect = vi.fn();
        client.setListeners({ onConnect });
        client.connect();

        MockWebSocket.instances[0].simulateOpen();
        expect(onConnect).toHaveBeenCalled();
    });

    it('should handle reconnection on accidental disconnect', async () => {
        client.connect();
        const ws = MockWebSocket.instances[0];
        ws.simulateOpen();

        // Simulate accidental close
        ws.simulateClose(1006, 'Abnormal');

        // Wait for reconnect (base delay 10ms + jitter)
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(MockWebSocket.instances.length).toBe(2);
    });

    it('should NOT reconnect on intentional close', async () => {
        client.connect();
        const ws = MockWebSocket.instances[0];

        client.close(); // Intentionally close

        await new Promise(resolve => setTimeout(resolve, 50));

        // Should not have created a new instance
        expect(MockWebSocket.instances.length).toBe(1);
    });

    it('should send signal packets', () => {
        client.connect();
        const ws = MockWebSocket.instances[0];
        ws.simulateOpen();

        const sendSpy = vi.spyOn(ws, 'send');
        const signal = { type: 'offer' as const, sdp: 'sdp-data' };

        client.sendSignal('peer2', signal);

        expect(sendSpy).toHaveBeenCalled();
        const sentData = sendSpy.mock.calls[0][0] as Uint8Array;
        expect(sentData).toBeInstanceOf(Uint8Array);
    });

    it('should emit onSignal when receiving valid binary signal', () => {
        const onSignal = vi.fn();
        client.setListeners({ onSignal });
        client.connect();
        const ws = MockWebSocket.instances[0];

        // Create a fake incoming signal packet
        const signalPacket = ProtocolUtils.createSignalPacket('user1', 'peer2', { type: 'answer', sdp: 'ans-sdp' });
        ws.simulateBinaryMessage(signalPacket);

        expect(onSignal).toHaveBeenCalledWith({
            from: 'peer2',
            signal: { type: 'answer', sdp: 'ans-sdp' }
        });
    });

    it('should emit onInit when receiving sync packet with snapshot', () => {
        const onInit = vi.fn();
        client.setListeners({ onInit });
        client.connect();
        const ws = MockWebSocket.instances[0];

        // Create a sync packet that acts as init (specialized sync packet)
        const snapshot = new Uint8Array([1, 2, 3]);
        const syncPacket = ProtocolUtils.createStateSyncPacket({ snapshot });
        ws.simulateBinaryMessage(syncPacket);

        expect(onInit).toHaveBeenCalled();
        // The argument is a FlatBuffers sync object, verify it has the snapshot
        const syncObj = onInit.mock.calls[0][0];
        expect(syncObj.snapshotArray()).toEqual(snapshot);
    });

    it('should emit onSignal for Candidate', () => {
        const onSignal = vi.fn();
        client.setListeners({ onSignal });
        client.connect();
        const ws = MockWebSocket.instances[0];

        const candidate = { candidate: 'cand', sdpMid: 'mid', sdpMLineIndex: 0 };
        const signalPacket = ProtocolUtils.createSignalPacket('me', 'remote', { type: 'candidate', candidate });
        ws.simulateBinaryMessage(signalPacket);

        expect(onSignal).toHaveBeenCalledWith({
            from: 'remote',
            signal: { type: 'candidate', candidate }
        });
    });

    it('should emit onSignal for Relay', () => {
        const onSignal = vi.fn();
        client.setListeners({ onSignal });
        client.connect();
        const ws = MockWebSocket.instances[0];

        const relayData = new Uint8Array([1, 2, 3]);
        const signalPacket = ProtocolUtils.createSignalPacket('me', 'remote', { type: 'relay', data: relayData });
        ws.simulateBinaryMessage(signalPacket);

        expect(onSignal).toHaveBeenCalledWith({
            from: 'remote',
            signal: { type: 'relay', data: expect.anything() }
        });
        const calledArg = onSignal.mock.calls[0][0].signal;
        expect(calledArg.data).toEqual(relayData);
    });

    it('should emit onError on WebSocket error', () => {
        const onError = vi.fn();
        client.setListeners({ onError });
        client.connect();
        const ws = MockWebSocket.instances[0];

        ws.simulateError(new Error('WS Error'));
        expect(onError).toHaveBeenCalled();
    });

    it('should log error on malformed binary message', () => {
        const originalGetRoot = WirePacket.getRootAsWirePacket;
        // Check if WirePacket is writable (it might be a class constructor or similar)
        // If it's a class with static method, we can spy on it or replace it.
        // Assuming it's writable in jsdom/node test environment.
        WirePacket.getRootAsWirePacket = vi.fn().mockImplementation(() => {
            throw new Error('Parse error');
        });

        client.connect();
        const ws = MockWebSocket.instances[0];

        // Send garbage binary
        ws.simulateBinaryMessage(new Uint8Array([0, 1, 2, 3]));

        expect(logger.error).toHaveBeenCalled();

        WirePacket.getRootAsWirePacket = originalGetRoot;
    });
});
