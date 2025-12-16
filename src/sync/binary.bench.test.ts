
import { describe, it, expect } from 'vitest';
import { marshalOp, unmarshalOp } from './binary';
import { Operation } from '../types';

describe('Binary Protocol Benchmarks', () => {
    // Generate a payload typical of a "Move Cursor" or "Type Character" op
    const workspaceId = '12345678-1234-1234-1234-123456789abc';
    const smallPayload: Operation = {
        key: 'cursor-pos',
        value: { x: 1234, y: 5678, id: 'user-123' },
        timestamp: 1627889123000000
    };

    const ITERATIONS = 100_000;

    it('Benchmark: Marshal JSON vs Binary', () => {
        // Warmup
        for (let i = 0; i < 100; i++) {
            marshalOp(workspaceId, smallPayload);
            JSON.stringify(smallPayload);
        }

        // 1. Measure JSON
        const startJson = performance.now();
        let jsonSize = 0;
        for (let i = 0; i < ITERATIONS; i++) {
            const str = JSON.stringify(smallPayload);
            jsonSize = str.length; // Approximate bytes for ASCII
        }
        const endJson = performance.now();
        const jsonTime = (endJson - startJson);

        // 2. Measure Binary
        const startBin = performance.now();
        let binSize = 0;
        for (let i = 0; i < ITERATIONS; i++) {
            const buf = marshalOp(workspaceId, smallPayload);
            binSize = buf.byteLength;
        }
        const endBin = performance.now();
        const binTime = (endBin - startBin);

        console.log(`\n\n=== BENCHMARK MARSHAL (x${ITERATIONS}) ===`);
        console.log(`JSON (Native):  ${jsonTime.toFixed(2)}ms | ${(jsonTime / ITERATIONS * 1000).toFixed(4)}µs/op | Size: ${jsonSize} bytes`);
        console.log(`Binary (JS):    ${binTime.toFixed(2)}ms | ${(binTime / ITERATIONS * 1000).toFixed(4)}µs/op | Size: ${binSize} bytes`);
        console.log(`IMPACT: Binary is ${(binTime / jsonTime).toFixed(2)}x slower CPU wise (Expected for JS)`);
        console.log(`SAVINGS: Binary is ${((1 - binSize / jsonSize) * 100).toFixed(1)}% smaller payload`);
        console.log(`=========================================\n`);

        expect(binSize).toBeLessThan(jsonSize); // Must be smaller
    });

    it('Benchmark: Unmarshal JSON vs Binary', () => {
        // Prepare data
        const jsonStr = JSON.stringify(smallPayload);
        const binBuf = marshalOp(workspaceId, smallPayload);

        // Warmup
        for (let i = 0; i < 100; i++) {
            unmarshalOp(binBuf);
            JSON.parse(jsonStr);
        }

        // 1. Measure JSON Parse
        const startJson = performance.now();
        for (let i = 0; i < ITERATIONS; i++) {
            JSON.parse(jsonStr);
        }
        const endJson = performance.now();
        const jsonTime = (endJson - startJson);

        // 2. Measure Binary Unpack
        const startBin = performance.now();
        for (let i = 0; i < ITERATIONS; i++) {
            unmarshalOp(binBuf);
        }
        const endBin = performance.now();
        const binTime = (endBin - startBin);

        console.log(`\n\n=== BENCHMARK UNMARSHAL (x${ITERATIONS}) ===`);
        console.log(`JSON (Native):  ${jsonTime.toFixed(2)}ms | ${(jsonTime / ITERATIONS * 1000).toFixed(4)}µs/op`);
        console.log(`Binary (JS):    ${binTime.toFixed(2)}ms | ${(binTime / ITERATIONS * 1000).toFixed(4)}µs/op`);
        console.log(`IMPACT: Binary is ${(binTime / jsonTime).toFixed(2)}x slower CPU wise`);
        console.log(`=========================================\n`);
    });
});
