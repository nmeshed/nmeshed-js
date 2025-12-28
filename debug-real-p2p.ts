
import { NMeshedClient } from './src/client';
import { ServerController } from './src/test-utils/server-controller';
import wrtc from '@roamhq/wrtc';
import WebSocket from 'ws';

// POLYFILLS
globalThis.RTCPeerConnection = wrtc.RTCPeerConnection;
globalThis.RTCSessionDescription = wrtc.RTCSessionDescription;
globalThis.RTCIceCandidate = wrtc.RTCIceCandidate;
globalThis.WebSocket = WebSocket as any;

async function run() {
    console.log('--- STARTING DEBUG SCRIPT ---');
    const PORT = 9192;
    const server = new ServerController(PORT);

    try {
        await server.start();

        const clients: NMeshedClient[] = [];
        const CLIENT_COUNT = 3;

        for (let i = 0; i < CLIENT_COUNT; i++) {
            const client = new NMeshedClient({
                workspaceId: '00000000-0000-0000-0000-000000000001',
                userId: `user-${i}`,
                token: 'tok',
                transport: 'p2p',
                serverUrl: `ws://localhost:${PORT}/v1/sync`,
                iceServers: [],
                debug: true
            });

            client.on('peerJoin', (pid) => console.log(`[CLIENT ${i}] PEER JOIN: ${pid}`));
            client.on('status', (s) => console.log(`[CLIENT ${i}] STATUS: ${s}`));

            clients.push(client);
            console.log(`[CLIENT ${i}] Connecting...`);
            await client.connect();
        }

        console.log('Waiting 5s...');
        await new Promise(r => setTimeout(r, 5000));

        console.log('--- FINISHED ---');
    } catch (e) {
        console.error('FATAL:', e);
    } finally {
        await server.stop();
        process.exit(0);
    }
}

run();
