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
            exclude: ['src/wasm/**', 'src/index.ts', 'src/types.ts', 'src/react/index.ts'],
            thresholds: {
                perFile: true,
                lines: 91,
                branches: 75,
                functions: 91,
                statements: 91,
            },
        },
    },
});
