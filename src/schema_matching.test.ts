import { describe, it, expect, vi } from 'vitest';
import { SyncEngine } from './core/SyncEngine';
import { defineSchema } from './schema/SchemaBuilder';

describe('SyncEngine Regression Tests', () => {
    describe('Schema Matching', () => {
        it('should match catch-all schema with empty string prefix', () => {
            const engine = new SyncEngine('test-ws');
            const FallbackSchema = defineSchema({ type: 'string', value: 'int32' });

            // Register as catch-all
            engine.registerSchema('', FallbackSchema);

            // Should match numeric key
            const schema = engine.getSchemaForKey('131072');
            expect(schema).toBe(FallbackSchema);

            // Should match random string key
            const schema2 = engine.getSchemaForKey('random_key_123');
            expect(schema2).toBe(FallbackSchema);
        });

        it('should prefer specific prefix over catch-all', () => {
            const engine = new SyncEngine('test-ws');
            const SpecificSchema = defineSchema({ a: 'int32' });
            const FallbackSchema = defineSchema({ b: 'int32' });

            engine.registerSchema('prefix_', SpecificSchema);
            engine.registerSchema('', FallbackSchema);

            expect(engine.getSchemaForKey('prefix_123')).toBe(SpecificSchema);
            expect(engine.getSchemaForKey('other_123')).toBe(FallbackSchema);
        });

        it('should decode snapshot data using catch-all schema', () => {
            const engine = new SyncEngine('test-ws');
            const EntitySchema = defineSchema({ type: 'string', x: 'int32' });
            engine.registerSchema('', EntitySchema);

            // Mock core for merge_remote_delta to return whatever it receives
            (engine as any).core = {
                merge_remote_delta: vi.fn((d: any) => d)
            };

            const data = { type: 'miner', x: 100 };
            const encoded = EntitySchema.encode(data);

            const emitted: any[] = [];
            engine.on('op', (k, v) => emitted.push({ k, v }));

            // Simulate init message with snapshot data
            // We pass an object because our mock returns it directly to SyncEngine logic
            engine.applyRemoteDelta({
                type: 'init',
                data: {
                    '12345': encoded
                }
            } as any);

            expect(emitted).toHaveLength(1);
            expect(emitted[0].k).toBe('12345');
            expect(emitted[0].v).toEqual(data);
        });
    });

    describe('Initialization Snapshot', () => {
        it('should handle snapshot map correctly', () => {
            const engine = new SyncEngine('test-ws');
            (engine as any).core = {
                merge_remote_delta: vi.fn((d: any) => d)
            };

            const emitted: any[] = [];
            engine.on('op', (k, v) => emitted.push({ k, v }));

            engine.applyRemoteDelta({
                type: 'init',
                data: {
                    'key1': 'val1',
                    'key2': 'val2'
                }
            } as any);

            expect(emitted).toHaveLength(2);
            expect(emitted).toContainEqual({ k: 'key1', v: 'val1' });
            expect(emitted).toContainEqual({ k: 'key2', v: 'val2' });
        });
    });
});
