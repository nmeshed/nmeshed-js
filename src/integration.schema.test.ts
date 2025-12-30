
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncEngine } from './core/SyncEngine';
import { defineSchema, registerGlobalSchema, SchemaRegistry } from './schema/SchemaBuilder';

// Mock dependencies to avoid full WASM stack relative to test environment
vi.mock('./core/AuthorityManager');
vi.mock('./core/RealTimeClock');
vi.mock('./utils/Logger');

describe('SyncEngine Global Schema Integration', () => {

    const GlobalTestSchema = defineSchema({
        foo: 'string'
    });

    beforeEach(() => {
        // Clear registry to avoid pollution
        SchemaRegistry.clear();
        vi.clearAllMocks();
    });

    it('should inherit globally registered schemas upon initialization', () => {
        // 1. Register schema globally
        registerGlobalSchema('global_test', GlobalTestSchema);

        // 2. Instantiate Engine
        const engine = new SyncEngine('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010');

        // Mock internal set to intercept
        const setInternalSpy = vi.spyOn(engine as any, 'setInternal');
        // Force state to active
        (engine as any)._state = 'ACTIVE';

        // 3. Check if validation/encoding works without explicit schema
        // We can inspect the private registry or try to set

        // Private registry inspection (white-box)
        const registry = (engine as any).schemaRegistry as Map<string, any>;
        expect(registry.has('global_test')).toBe(true);
        expect(registry.get('global_test')).toBe(GlobalTestSchema);
    });

    it('should use inherited schema for encoding', () => {
        registerGlobalSchema('auto_', GlobalTestSchema);

        const engine = new SyncEngine('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010');

        // Mock core to avoid runtime errors during set
        (engine as any).core = {
            apply_local_op: vi.fn(() => new Uint8Array([])),
            get_raw_value: vi.fn(),
        };
        (engine as any)._state = 'ACTIVE';

        const encodeSpy = vi.spyOn(GlobalTestSchema, 'encode');

        // Call set WITHOUT schema
        engine.set('auto_123', { foo: 'bar' });

        expect(encodeSpy).toHaveBeenCalledWith({ foo: 'bar' });
    });
});
