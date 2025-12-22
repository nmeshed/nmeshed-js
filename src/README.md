# nMeshed JS/TS SDK Source

This directory contains the source code for the `nmeshed` npm package.

## Structure
*   `client.ts`: The main `NMeshedClient` class.
*   `mesh/`: P2P networking logic (WebRTC DataChannels).
*   `react/`: React Context and Hooks (`useDocument`, `usePresence`).
*   `wasm/`: The Rust Core bindings (via `wasm-pack`).
*   `types.ts`: Shared TypeScript interfaces.

## Build Flow
The `wasm/` directory must be compiled before the TS code can run.
```bash
# Build WASM
cd ../../../platform/core/rust
wasm-pack build --target web --out-dir ../../../sdks/javascript/src/wasm/pkg
```
