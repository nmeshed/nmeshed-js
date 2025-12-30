import { describe, it, expect, vi, afterEach } from 'vitest';
import { NMeshedClient } from './client';

describe('NMeshedClient URL Derivation', () => {
    const originalWindow = global.window;

    afterEach(() => {
        global.window = originalWindow;
    });

    it('should derive localhost:9000 URL when hostname is localhost', () => {
        // Mock window.location
        vi.stubGlobal('window', {
            location: {
                hostname: 'localhost'
            }
        });

        const client = new NMeshedClient({
            workspaceId: '550e8400-e29b-41d4-a716-446655440000',
            apiKey: 'test-key'
        });

        // We can inspect the transport's URL (needs casting or access to private, 
        // but easier to check if we can spy on WebSocketTransport or check a public property if exposed)
        // Since transport is public readonly:
        expect((client.transport as any).url).toContain('ws://127.0.0.1:9000/ws?workspace_id=550e8400-e29b-41d4-a716-446655440000');
    });

    it('should use production URL when not localhost', () => {
        vi.stubGlobal('window', {
            location: {
                hostname: 'example.com'
            }
        });

        const client = new NMeshedClient({ workspaceId: '550e8400-e29b-41d4-a716-446655440000', token: 'mock-token' });
        expect((client as any).config.relayUrl).toBe('wss://api.nmeshed.com');


    });
});
