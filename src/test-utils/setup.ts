import { MockWebSocket, defaultMockServer } from './mocks';
import { vi } from 'vitest';

export function createMockWebSocketClass(options: { autoConnect?: boolean } = {}) {
    return class TestMockWebSocket extends MockWebSocket {
        constructor(url: string, _protocols?: string | string[]) {
            super(url, defaultMockServer);
            if (options.autoConnect) {
                Promise.resolve().then(() => {
                    this.simulateOpen();
                });
            }
        }
    };
}

export function installGlobalMockWebSocket(options: { autoConnect?: boolean } = {}) {
    const MockWS = createMockWebSocketClass(options);
    const originalWebSocket = (globalThis as any).WebSocket;

    vi.stubGlobal('WebSocket', MockWS);
    (global as any).WebSocket = MockWS;
    (globalThis as any).WebSocket = MockWS;

    if (typeof window !== 'undefined') {
        (window as any).WebSocket = MockWS;
    }

    return () => {
        vi.stubGlobal('WebSocket', originalWebSocket);
        (global as any).WebSocket = originalWebSocket;
        (globalThis as any).WebSocket = originalWebSocket;
        if (typeof window !== 'undefined') {
            (window as any).WebSocket = originalWebSocket;
        }
    };
}
