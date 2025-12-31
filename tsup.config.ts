import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        'react/index': 'src/react/index.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    clean: true,
    external: ['react'],
});
