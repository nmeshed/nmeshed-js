// React hooks are independent
// import { Snapshot } from './generated/snapshot';

/**
 * Fetches the initial binary snapshot from the nMeshed server via HTTP.
 * This is designed for React Server Components (RSC) or other server-side
 * environments where WebSocket connections are too expensive or not persistent.
 * 
 * @param workspaceId - The UUID of the workspace
 * @param serverUrl - The HTTP URL of the nMeshed server (e.g. http://localhost:9000)
 * @returns Promise<Uint8Array> - The raw binary snapshot
 */
export async function fetchServerSnapshot(workspaceId: string, serverUrl: string): Promise<Uint8Array> {
    // Normalize URL (ensure http/https, remote trailing slash)
    const baseUrl = serverUrl.replace(/\/$/, "");
    // Use generic fetch (available in Node 18+ and Browsers)
    const res = await fetch(`${baseUrl}/snapshot?workspace_id=${workspaceId}`, {
        method: 'GET',
        headers: {
            'Accept': 'application/octet-stream',
        },
        cache: 'no-store', // Always fresh for hydration
    });

    if (!res.ok) {
        throw new Error(`Failed to fetch snapshot: ${res.status} ${res.statusText}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return new Uint8Array(arrayBuffer);
}
