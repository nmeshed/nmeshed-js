
import { defineSchema } from '../src/schema/SchemaBuilder';
import { performance } from 'perf_hooks';

function benchmarkSimpleSchema() {
    console.log("\n--- Benchmarking Simple Schema (Flat Object) ---");

    const schema = defineSchema({
        id: 'uint32',
        x: 'float64',
        y: 'float64',
        active: 'boolean',
        name: 'string'
    });

    const data = {
        id: 123456,
        x: 10.5,
        y: -20.123,
        active: true,
        name: 'PlayerOne'
    };

    const ITERATIONS = 100_000;

    // Measure Encode
    let start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
        schema.encode(data);
    }
    let end = performance.now();
    let encodeTime = end - start;
    console.log(`Schema Encode: ${(ITERATIONS / (encodeTime / 1000)).toFixed(2)} ops/sec (${(encodeTime / ITERATIONS).toFixed(4)} ms/op)`);

    const encoded = schema.encode(data);

    // Measure Decode
    start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
        schema.decode(encoded);
    }
    end = performance.now();
    let decodeTime = end - start;
    console.log(`Schema Decode: ${(ITERATIONS / (decodeTime / 1000)).toFixed(2)} ops/sec (${(decodeTime / ITERATIONS).toFixed(4)} ms/op)`);

    // Baseline JSON
    start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
        JSON.stringify(data);
    }
    end = performance.now();
    let jsonTime = end - start;
    console.log(`JSON Stringify (Baseline): ${(ITERATIONS / (jsonTime / 1000)).toFixed(2)} ops/sec`);

    console.log(`Binary Size: ${encoded.byteLength} bytes`);
    console.log(`JSON Size: ${Buffer.byteLength(JSON.stringify(data))} bytes`);
}

function benchmarkComplexSchema() {
    console.log("\n--- Benchmarking Complex Schema (Array of Objects) ---");

    const schema = defineSchema({
        entities: {
            type: 'array',
            itemType: {
                type: 'object',
                schema: {
                    id: 'uint16',
                    pos: {
                        type: 'object',
                        schema: { x: 'float32', y: 'float32' }
                    }
                }
            }
        }
    });

    const entities = [];
    for (let i = 0; i < 50; i++) {
        entities.push({
            id: i,
            pos: { x: i, y: i * 2 }
        });
    }
    const data = { entities };

    const ITERATIONS = 10_000;

    // Measure Encode
    let start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
        schema.encode(data);
    }
    let end = performance.now();
    let encodeTime = end - start;
    console.log(`Schema Encode: ${(ITERATIONS / (encodeTime / 1000)).toFixed(2)} ops/sec`);

    const encoded = schema.encode(data);

    // Measure Decode
    start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
        schema.decode(encoded);
    }
    end = performance.now();
    let decodeTime = end - start;
    console.log(`Schema Decode: ${(ITERATIONS / (decodeTime / 1000)).toFixed(2)} ops/sec`);

    console.log(`Binary Size: ${encoded.byteLength} bytes`);
    console.log(`JSON Size: ${Buffer.byteLength(JSON.stringify(data))} bytes`);
}

benchmarkSimpleSchema();
benchmarkComplexSchema();
