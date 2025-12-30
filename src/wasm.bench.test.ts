import { describe, it, expect, beforeAll } from 'vitest';
import init, { NMeshedClientCore } from './wasm/nmeshed_core';

// NOTE: This benchmark requires the actual WASM file to be present and loadable.
describe('WASM Core Benchmarks', () => {
    let wasmBuffer: Buffer;
    const workspaceId = '12345678-1234-1234-1234-123456789abc';
    const ITERATIONS = 1_000;

    beforeAll(async () => {
        try {
            const fs = await import('fs/promises');
            const path = await import('path');
            const { fileURLToPath } = await import('url');

            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);
            const wasmPath = path.resolve(__dirname, './wasm/nmeshed_core/nmeshed_core_bg.wasm');

            wasmBuffer = await fs.readFile(wasmPath);
            await init(wasmBuffer);
        } catch (e) {
            console.error('Skipping WASM benchmarks: Failed to load WASM module', e);
        }
    });

    describe('Automerge Core', () => {
        let core: NMeshedClientCore;

        beforeAll(() => {
            if (wasmBuffer) {
                core = new NMeshedClientCore(workspaceId);
            }
        });

        it('Benchmark: apply_local_op', () => {
            if (!core) return;
            const key = 'bench-key';
            const value = { x: 1, y: 2, note: 'benchmark' };
            const valBytes = new TextEncoder().encode(JSON.stringify(value));
            const timestamp = BigInt(Date.now() * 1000);

            // Warmup
            for (let i = 0; i < 100; i++) {
                core.apply_local_op(key, valBytes, timestamp, 'bench', BigInt(i), false);
            }

            const start = performance.now();
            for (let i = 0; i < ITERATIONS; i++) {
                core.apply_local_op(key, valBytes, timestamp, 'bench', BigInt(i), false);
            }
            const end = performance.now();
            const time = end - start;
            const perOp = (time / ITERATIONS * 1000);

            console.log(`[Automerge] apply_local_op: ${perOp.toFixed(2)} µs/op (${(ITERATIONS / (time / 1000)).toFixed(0)} ops/s)`);
            expect(time).toBeGreaterThan(0);
        });

        it('Benchmark: get_state', () => {
            if (!core) return;

            // Populate
            for (let i = 0; i < 100; i++) {
                const valBytes = new TextEncoder().encode(JSON.stringify({ index: i }));
                core.apply_local_op(`item-${i}`, valBytes, BigInt(Date.now() * 1000), 'bench', BigInt(i), false);
            }

            const start = performance.now();
            for (let i = 0; i < 100; i++) { // Fewer iterations for full snapshot
                core.get_all_values();
            }
            const end = performance.now();
            const time = end - start;
            const perOp = (time / 100 * 1000);

            console.log(`[Automerge] get_state (100 items): ${perOp.toFixed(2)} µs/op`);
        });

        it('Benchmark: merge_remote_delta', () => {
            if (!core) return;

            // Create a packet to merge
            const key = 'merge-bench';
            const value = { x: 1, y: 2, note: 'benchmark' };
            const valBytes = new TextEncoder().encode(JSON.stringify(value));
            const timestamp = BigInt(Date.now() * 1000);

            // apply_local_op returns the Flatbuffer packet!
            const packet = core.apply_local_op(key, valBytes, timestamp, 'bench', BigInt(1), false);

            const start = performance.now();
            for (let i = 0; i < ITERATIONS; i++) {
                core.apply_vessel(packet);
            }
            const end = performance.now();
            const time = end - start;
            const perOp = (time / ITERATIONS * 1000);

            console.log(`[Automerge] merge_remote_delta: ${perOp.toFixed(2)} µs/op (${(ITERATIONS / (time / 1000)).toFixed(0)} ops/s)`);
        });
    });
});
