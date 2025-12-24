import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        'react/index': 'src/react/index.ts',
        'game/index': 'src/game/index.ts',
        'sync/index': 'src/sync/index.ts',
        'binary/index': 'src/binary/index.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    splitting: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: false,
    external: ['react'],
});
