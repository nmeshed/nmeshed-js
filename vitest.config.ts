import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json-summary'],
            include: ['src/**/*.ts', 'src/**/*.tsx'],
            exclude: [
                'src/wasm/**',
                'src/index.ts',
                'src/types.ts',
                'src/react/index.ts',
                'src/schema/**',
                // Index files (re-exports only)
                'src/adapters/index.ts',
                'src/ai/index.ts',
                // Debug utilities (not production code)
                'src/debug/**',
                // Testing utilities (consumers test with these, they don't need tests themselves)
                'src/testing.ts',
                // Requires SharedArrayBuffer environment which is complex to set up in tests
                'src/utils/buffers.ts',
                // Suspense hook requires complex React Suspense testing setup with multiple async handlers
                'src/react/suspense.ts',
                // Presence hook requires complex mocking of timer-based cleanup
                'src/react/presence.ts',
            ],
            thresholds: {
                perFile: true,
                lines: 85,
                branches: 60,
                functions: 80,
                statements: 85,
            },
        },
    },
});
