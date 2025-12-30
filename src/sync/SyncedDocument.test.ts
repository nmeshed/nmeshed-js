import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncedDocument } from './SyncedDocument';
import { EventEmitter } from '../utils/EventEmitter';
import { defineSchema } from '../schema/SchemaBuilder';

// Mock SyncEngine
class MockSyncEngine extends EventEmitter<any> {
    public get = vi.fn();
    public set = vi.fn();

    public simulateOp(key: string, value: any) {
        this.emit('op', key, value, false);
    }
}

describe('SyncedDocument', () => {
    let mockEngine: MockSyncEngine;

    beforeEach(() => {
        mockEngine = new MockSyncEngine();
    });

    const TestSchema = defineSchema({
        title: 'string',
        count: 'int32'
    });

    it('should maintain stable data reference if no relevant fields change', () => {
        mockEngine.get.mockReturnValue(undefined);
        const doc = new SyncedDocument(mockEngine as any, 'doc', TestSchema);

        const data1 = doc.data;
        const data2 = doc.data;
        expect(data1).toBe(data2);

        // Unrelated op
        mockEngine.simulateOp('other', 'val');
        expect(doc.data).toBe(data1);

        // Validation: Ensure no change event emitted
        const onChange = vi.fn();
        doc.on('change', onChange);
        mockEngine.simulateOp('other', 'val');
        expect(onChange).not.toHaveBeenCalled();
    });

    it('should update data reference only on relevant field change', () => {
        mockEngine.get.mockReturnValue(undefined);
        const doc = new SyncedDocument(mockEngine as any, 'doc', TestSchema);
        const data1 = doc.data;

        // Only mock get returning new value alone is not enough, 
        // SyncedDocument.updateField calls get() inside.
        mockEngine.get.mockImplementation((k) => k === 'title' ? 'New Title' : undefined);

        mockEngine.simulateOp('title', 'New Title');

        expect(doc.data).not.toBe(data1);
        expect(doc.data.title).toBe('New Title');
    });

    it('should NOT update data reference if value is logically same (primitive)', () => {
        mockEngine.get.mockReturnValue('Same Title');
        const doc = new SyncedDocument(mockEngine as any, 'doc', TestSchema);
        const data1 = doc.data;

        // Trigger op with SAME value
        mockEngine.get.mockReturnValue('Same Title');
        mockEngine.simulateOp('title', 'Same Title');

        const data2 = doc.data;
        expect(data2).toBe(data1); // Should be same reference because value didn't strictly change?
        // SyncedDocument implementation:
        // if ((this._data as any)[field] !== nextVal) { copy... }
        // Strict equality check.
    });
});
