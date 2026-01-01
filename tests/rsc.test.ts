import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchServerSnapshot } from '../src/rsc';

describe('fetchServerSnapshot', () => {
    const mockWorkspaceId = 'test-workspace';
    const mockServerUrl = 'http://localhost:9000';
    const mockSnapshot = new Uint8Array([1, 2, 3, 4]);

    beforeEach(() => {
        global.fetch = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should fetch snapshot successfully', async () => {
        (global.fetch as any).mockResolvedValue({
            ok: true,
            arrayBuffer: () => Promise.resolve(mockSnapshot.buffer),
        });

        const result = await fetchServerSnapshot(mockWorkspaceId, mockServerUrl);
        expect(result).toBeInstanceOf(Uint8Array);
        expect(result).toEqual(mockSnapshot);
        expect(global.fetch).toHaveBeenCalledWith(
            'http://localhost:9000/snapshot?workspace_id=test-workspace',
            expect.objectContaining({
                method: 'GET',
                headers: { 'Accept': 'application/octet-stream' },
                cache: 'no-store'
            })
        );
    });

    it('should handle trailing slash in server URL', async () => {
        (global.fetch as any).mockResolvedValue({
            ok: true,
            arrayBuffer: () => Promise.resolve(mockSnapshot.buffer),
        });

        await fetchServerSnapshot(mockWorkspaceId, 'http://localhost:9000/');
        expect(global.fetch).toHaveBeenCalledWith(
            'http://localhost:9000/snapshot?workspace_id=test-workspace',
            expect.anything()
        );
    });

    it('should throw error on non-200 response', async () => {
        (global.fetch as any).mockResolvedValue({
            ok: false,
            status: 404,
            statusText: 'Not Found',
        });

        await expect(fetchServerSnapshot(mockWorkspaceId, mockServerUrl))
            .rejects.toThrow('Failed to fetch snapshot: 404 Not Found');
    });

    it('should throw error on network failure', async () => {
        (global.fetch as any).mockRejectedValue(new Error('Network Error'));

        await expect(fetchServerSnapshot(mockWorkspaceId, mockServerUrl))
            .rejects.toThrow('Network Error');
    });
});
