
import { NMeshedClient } from '../src/client';
import { Transport, TransportStatus, TransportEvents } from '../src/transport/Transport';
import performance from 'perf_hooks';

class MockTransport implements Transport {
    public status: TransportStatus = 'CONNECTED';

    constructor() { }

    async connect(): Promise<void> { }
    disconnect(): void { }

    // Simulate real WebSocket overhead: sending bytes
    send(data: Uint8Array): void {
        // Current WS implementation just sends bytes. 
        // No extra serialization drift here unless we want to simulate network copy.
        // We will just touch the data to ensure it's not compiled away.
        // @ts-ignore
        const _ = data.length;
    }

    broadcast(data: Uint8Array): void {
        this.send(data);
    }

    // Simulate real WebSocket overhead: JSON.stringify wrapped payload
    async sendEphemeral(payload: any, _to?: string): Promise<void> {
        // The real WebSocketTransport does:
        // const msg = JSON.stringify({ type: 'ephemeral', payload, to });
        // this.ws.send(msg);

        const msg = JSON.stringify({ type: 'ephemeral', payload, to: _to });
        // Simulate "sending" string which involves UTF8 encode usually
        new TextEncoder().encode(msg);
        return Promise.resolve();
    }

    on<K extends keyof TransportEvents>(_event: K, _handler: (...args: TransportEvents[K]) => void): () => void {
        return () => { };
    }

    getStatus(): TransportStatus { return 'CONNECTED'; }
    getPeers(): string[] { return []; }
    async ping(_peerId: string): Promise<number> { return 0; }

    simulateLatency(_ms: number): void { }
    simulatePacketLoss(_rate: number): void { }
}

async function benchmark() {
    console.log("\n--- Benchmark Client Overhead (JS) ---");

    const client = new NMeshedClient({
        workspaceId: 'bench',
        token: 'token',
        transport: 'server' // Doesn't matter, we inject mock
    });

    // Inject Mock
    // @ts-ignore
    client['transport'] = new MockTransport();
    // @ts-ignore
    client['_status'] = 'CONNECTED'; // Force connected state
    // @ts-ignore - Avoid initial connect boot overhead for pure throughput test
    client['engine']['core'] = {
        apply_local_op: () => new Uint8Array(10), // Mock WASM
        merge_remote_delta: () => ({ type: 'op' })
    };

    // Warmup
    for (let i = 0; i < 100; i++) client.set("k", { v: i });

    const ITERATIONS = 100000;

    // 1. Benchmark set (Engine Path)
    {
        const start = performance.performance.now();
        for (let i = 0; i < ITERATIONS; i++) {
            client.set("key", { val: i });
        }
        const end = performance.performance.now();
        const elapsed = (end - start) / 1000;
        const ops = ITERATIONS / elapsed;
        console.log(`Client.set: ${ops.toFixed(2)} ops/sec (${(elapsed * 1000000 / ITERATIONS).toFixed(4)} µs/op)`);
    }

    // 2. Benchmark broadcast (Ephemeral Path - simple)
    {
        const payload = { x: 1, y: 2 };
        const start = performance.performance.now();
        for (let i = 0; i < ITERATIONS; i++) {
            client.broadcast(payload);
        }
        const end = performance.performance.now();
        const elapsed = (end - start) / 1000;
        const ops = ITERATIONS / elapsed;
        console.log(`Client.broadcast: ${ops.toFixed(2)} ops/sec (${(elapsed * 1000000 / ITERATIONS).toFixed(4)} µs/op)`);
    }

    // 3. Benchmark SyncedMap (The "Real" heavy path)
    {
        const map = client.getSyncedMap("bench");
        // SyncedMap.set does: Serialize Value -> broadcastUpdate (Base64) -> broadcast -> sendEphemeral (JSON)
        const start = performance.performance.now();
        for (let i = 0; i < ITERATIONS; i++) {
            map.set("key", { val: i });
        }
        const end = performance.performance.now();
        const elapsed = (end - start) / 1000;
        const ops = ITERATIONS / elapsed;
        console.log(`SyncedMap.set: ${ops.toFixed(2)} ops/sec (${(elapsed * 1000000 / ITERATIONS).toFixed(4)} µs/op)`);
    }
}

benchmark().catch(console.error);
