import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        'react/index': 'src/react/index.ts',
        cli: 'src/cli.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    clean: true,
    // Peer dependencies - consumer provides these
    external: ['react', 'zod'],
    // Bundle internal deps - consumer should never see these
    noExternal: ['@msgpack/msgpack', 'flatbuffers'],
});
