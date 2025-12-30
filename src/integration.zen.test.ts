import { vi, describe, it, expect } from 'vitest';
import { SyncedCollection } from './sync/SyncedCollection';
import { defineSchema } from './schema/SchemaBuilder';

describe('Zen Integration (Simulated Stream)', () => {
    const TaskSchema = defineSchema({
        id: 'string',
        title: 'string',
        status: 'string'
    });

    it('should reconcile n-users using fluid IDs', () => {
        // Non-Resistance: We mock the engine to simulate the "Stream"
        const mockEngine = {
            on: vi.fn(),
            registerSchema: vi.fn(),
            getAllValues: vi.fn().mockReturnValue({}),
            set: vi.fn(),
            apply: vi.fn(),
            subscribe: vi.fn()
        };

        const collection = new SyncedCollection(mockEngine as any, 'tasks:', TaskSchema);

        // Act: Simulating a network packet arriving for 'tasks:1'
        // In SyncedCollection, this is handled via engine.on('op', ...)
        const opHandler = (mockEngine.on as any).mock.calls.find((call: any) => call[0] === 'op')[1];
        opHandler('tasks:1', { title: 'Achieve Satori', status: 'pending' });

        // Assert: The ID is stripped, the Satori is reached.
        expect(collection.get('1')).toEqual({ title: 'Achieve Satori', status: 'pending' });
        expect(collection.asArray()).toContainEqual(
            expect.objectContaining({ id: '1', title: 'Achieve Satori' })
        );
    });

    it('should handle collection removals with clean IDs', () => {
        const mockEngine = {
            on: vi.fn(),
            registerSchema: vi.fn(),
            getAllValues: vi.fn().mockReturnValue({}),
            set: vi.fn()
        };
        const collection = new SyncedCollection(mockEngine as any, 'users:');
        const opHandler = (mockEngine.on as any).mock.calls.find((call: any) => call[0] === 'op')[1];

        opHandler('users:kevin', { status: 'online' });
        expect(collection.size).toBe(1);

        opHandler('users:kevin', null);
        expect(collection.size).toBe(0);
    });
});
