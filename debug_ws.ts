
import WebSocket from 'ws';

// Minimal WS test
async function test() {
    console.log("Connecting to ws://127.0.0.1:9091/v1/sync/test-ws-id?userId=debug-user");
    const ws = new WebSocket('ws://127.0.0.1:9091/v1/sync/test-ws-id?userId=debug-user&apiKey=nm_local_debug');

    ws.on('open', () => {
        console.log("OPEN");
        ws.send(JSON.stringify({ type: 'hello' }));
        setTimeout(() => ws.close(), 1000);
    });

    ws.on('error', (err) => {
        console.error("ERROR:", err);
    });

    ws.on('close', (code, reason) => {
        console.log("CLOSE:", code, reason.toString());
    });

    ws.on('message', (data) => {
        console.log("MSG:", data.toString());
    });
}

test();
