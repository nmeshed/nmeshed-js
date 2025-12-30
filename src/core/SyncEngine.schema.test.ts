
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncEngine } from './SyncEngine';
import { defineSchema } from '../schema/SchemaBuilder';

// Mock dependencies
vi.mock('../utils/Logger');
vi.mock('./AuthorityManager');
vi.mock('./RealTimeClock');

describe('SyncEngine Schema Fallback', () => {
    let engine: SyncEngine;
    const TestSchema = defineSchema({
        name: 'string',
        count: 'int32'
    });

    beforeEach(() => {
        engine = new SyncEngine('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010');
        // Mock core to avoid WASM requirement in this unit test
        (engine as any).core = {
            apply_local_op: vi.fn((k, v, t) => new Uint8Array([1, 2, 3])),
            apply_vessel: vi.fn(),
            get_raw_value: vi.fn(() => new Uint8Array([1, 2])), // Add this
        };
        // Mock internal methods that depend on core
        (engine as any).setInternal = (engine as any).setInternal.bind(engine);
        // Force state to ACTIVE to bypass pre-connect queue
        (engine as any)._state = 'ACTIVE';
        vi.clearAllMocks();
    });

    it('should use registered schema when set() is called without schema arg', () => {
        const spy = vi.spyOn(TestSchema, 'encode');

        // 1. Register schema globally for a prefix
        engine.registerSchema('player_', TestSchema);

        // 2. Call set without explicit schema
        const data = { name: 'Alice', count: 42 };
        engine.set('player_1', data);

        // 3. Verify schema.encode was called
        expect(spy).toHaveBeenCalledWith(data);
    });

    it('should use registered "catch-all" schema if key matches generic pattern', () => {
        const spy = vi.spyOn(TestSchema, 'encode');

        // Register empty string as catch-all
        engine.registerSchema('', TestSchema);

        const data = { name: 'Bob', count: 10 };
        engine.set('random_key_123', data);

        expect(spy).toHaveBeenCalledWith(data);
    });

    it('should fallback to default encoding if no schema matches', () => {
        const schemaSpy = vi.spyOn(TestSchema, 'encode');

        // No registration

        const data = { name: 'Charlie', count: 99 };
        engine.set('unregistered_key', data);

        expect(schemaSpy).not.toHaveBeenCalled();
    });

    it('should skip schema encoding when value is null (deletion)', () => {
        const schemaSpy = vi.spyOn(TestSchema, 'encode');
        engine.registerSchema('del_', TestSchema);

        // Deletion
        engine.set('del_1', null);

        // Should NOT call schema.encode, but should still process
        expect(schemaSpy).not.toHaveBeenCalled();
        // Core should receive a deletion (empty buffer or specific marker, likely from encodeValue(null))
    });
});
