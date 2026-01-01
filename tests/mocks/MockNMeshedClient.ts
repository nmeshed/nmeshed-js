import { vi } from 'vitest';
import { INMeshedClient, ClientEvents } from '../../src/types';

// Note: Using property initializers for dense mock definition.
// Implements interface to ensure strictly typed guard against drift.
export class MockNMeshedClient implements INMeshedClient {
    config: any = {};

    get = vi.fn();
    set = vi.fn();
    delete = vi.fn();
    on = vi.fn();
    getStatus = vi.fn().mockReturnValue('disconnected');
    getPeerId = vi.fn().mockReturnValue('test-peer');
    getAllValues = vi.fn().mockReturnValue({});
    forEach = vi.fn();
    awaitReady = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    store = vi.fn();
    subscribe = vi.fn().mockReturnValue(() => { }); // Returns unsubscribe function
    cas = vi.fn().mockResolvedValue(true); // Default to successful CAS

    // Test util only
    emit(event: keyof ClientEvents, ...args: any[]) { }
}
