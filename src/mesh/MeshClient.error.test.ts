import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshClient } from './MeshClient';
import { MeshErrorCode } from './types';
import { MeshError } from '../errors';

// Mock the dependencies
const mockSignaling = {
    connect: vi.fn(),
    close: vi.fn(),
    sendSignal: vi.fn(),
    sendSync: vi.fn(),
    sendEphemeral: vi.fn(),
    updateToken: vi.fn(),
    setListeners: vi.fn(),
};

const mockConnections = {
    broadcast: vi.fn(),
    sendToPeer: vi.fn(),
    initiateConnection: vi.fn(),
    handleOffer: vi.fn(),
    handleAnswer: vi.fn(),
    handleCandidate: vi.fn(),
    closeAll: vi.fn(),
    getPeerIds: vi.fn().mockReturnValue([]),
    isDirect: vi.fn().mockReturnValue(false),
    setListeners: vi.fn(),
};

vi.mock('./SignalingClient', () => ({
    SignalingClient: class {
        constructor() { return mockSignaling; }
    },
}));

vi.mock('./ConnectionManager', () => ({
    ConnectionManager: class {
        constructor() { return mockConnections; }
    },
}));

describe('MeshClient Structured Errors', () => {
    let signalingHandlers: any;
    let connectionHandlers: any;
    let mesh: MeshClient;

    beforeEach(() => {
        vi.clearAllMocks();
        mockSignaling.setListeners.mockImplementation((handlers) => { signalingHandlers = handlers; });
        mockConnections.setListeners.mockImplementation((handlers) => { connectionHandlers = handlers; });

        mesh = new MeshClient({
            workspaceId: 'test-ws',
            token: 'test-token'
        });
    });

    it('should emit MeshError when signaling fails', () => {
        const errorListener = vi.fn();
        mesh.on('error', errorListener);

        const internalError = new Error('Socket hang up');
        signalingHandlers.onError(internalError);

        expect(errorListener).toHaveBeenCalledWith(expect.any(MeshError));
        const emittedError = errorListener.mock.calls[0][0] as MeshError;
        expect(emittedError.code).toBe(MeshErrorCode.SIGNALING_FAILED);
        expect(emittedError.diagnostics).toMatchObject({
            url: expect.any(String),
            cause: internalError
        });
    });

    it('should emit MeshError when P2P handshake fails', () => {
        const errorListener = vi.fn();
        mesh.on('error', errorListener);

        const internalError = new Error('SDP negotiation failed');
        connectionHandlers.onError('peer-1', internalError);

        expect(errorListener).toHaveBeenCalledWith(expect.any(MeshError));
        const emittedError = errorListener.mock.calls[0][0] as MeshError;
        expect(emittedError.code).toBe(MeshErrorCode.P2P_HANDSHAKE_FAILED);
        expect(emittedError.diagnostics).toMatchObject({
            peerId: 'peer-1',
            cause: internalError
        });
    });

    it('should emit MeshError when WASM initialization fails', async () => {
        const errorListener = vi.fn();
        mesh.on('error', errorListener);

        const wasmError = new Error('WASM binary not found');
        const wasmInit = vi.fn().mockRejectedValue(wasmError);

        await mesh.connect(wasmInit);

        expect(errorListener).toHaveBeenCalledWith(expect.any(MeshError));
        const emittedError = errorListener.mock.calls[0][0] as MeshError;
        expect(emittedError.code).toBe(MeshErrorCode.WASM_INIT_FAILED);
        expect(emittedError.diagnostics).toMatchObject({
            cause: wasmError
        });
    });
});
