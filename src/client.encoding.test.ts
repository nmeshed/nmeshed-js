import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NMeshedClient } from './client';
import { WebSocketTransport } from './transport/WebSocketTransport';

// Explicitly mock the transport class
const mockSendEphemeral = vi.fn();
const mockGetStatus = vi.fn().mockReturnValue('READY');

vi.mock('./transport/WebSocketTransport', () => {
    return {
        WebSocketTransport: vi.fn(function () {
            return {
                sendEphemeral: mockSendEphemeral,
                getStatus: mockGetStatus,
                on: vi.fn(), // EventEmitter
                connect: vi.fn(),
                disconnect: vi.fn(),
                getMetrics: vi.fn(),
                simulateLatency: vi.fn(),
                simulatePacketLoss: vi.fn(),
                ping: vi.fn().mockResolvedValue(0),
                getLatency: vi.fn().mockReturnValue(0)
            };
        })
    };
});

// Mock dependencies
vi.mock('./core/SyncEngine', () => ({
    SyncEngine: class {
        boot = vi.fn().mockResolvedValue(undefined);
        getHeads = vi.fn().mockReturnValue([]);
        authority = { trackKey: vi.fn(), getPeers: vi.fn().mockReturnValue([]) };
        on = vi.fn();
        getQueueSize = vi.fn().mockReturnValue(0);
        getPendingOps = vi.fn().mockReturnValue([]);
        stop = vi.fn();
        destroy = vi.fn();
        set = vi.fn();
        get = vi.fn();
        getAllValues = vi.fn();
        registerSchema = vi.fn();
        // EventEmitter mocks
        emit = vi.fn();
        addListener = vi.fn();
        removeListener = vi.fn();
        removeAllListeners = vi.fn();
    }
}));

describe('NMeshedClient Message Encoding', () => {
    let client: NMeshedClient;

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetStatus.mockReturnValue('READY');
        client = NMeshedClient.dev('test-workspace');
    });

    it('should pass Uint8Array through unchanged', () => {
        const payload = new Uint8Array([1, 2, 3]);
        client.sendMessage(payload);
        expect(mockSendEphemeral).toHaveBeenCalledWith(payload, undefined);
    });

    it('should encode JSON object to Uint8Array', () => {
        const payload = { foo: 'bar', num: 123 };
        client.sendMessage(payload);

        const expectedJson = JSON.stringify(payload);

        expect(mockSendEphemeral).toHaveBeenCalled();
        const sentBytes = mockSendEphemeral.mock.calls[0][0];

        // Check if it's byte-like enough to decode (Buffer or Uint8Array)
        const sentBytesRaw = mockSendEphemeral.mock.calls[0][0];
        expect(sentBytesRaw).toBeTruthy();
        expect(new TextDecoder().decode(sentBytesRaw)).toBe(expectedJson);
    });

    it('should encode simple types to binary representation of JSON', () => {
        const payload = "hello world";
        client.sendMessage(payload);

        const expectedBytes = new TextEncoder().encode(JSON.stringify(payload));
        expect(mockSendEphemeral).toHaveBeenCalled();
        expect(mockSendEphemeral.mock.calls[0][0]).toEqual(expectedBytes);
    });
});
