# nMeshed JavaScript/TypeScript SDK

The high-performance synchronization layer for modern distributed applications.

## DNA & Architecture

The nMeshed SDK is designed with **Zen Architecture** principles: API stillness, non-resistance to data flow, and zero perceived latency.

### Core Components

1.  **`NMeshedClient`**: The primary entry point. Orchestrates auth, transport (WebSocket), and identity. It maintains a **Collection Registry** to ensure singleton instance efficiency.
2.  **`SyncEngine`**: The heart of the SDK. A high-performance WASM core (Rust) that handles CRDT merging, operation queueing, and state consistency.
3.  **`SyncedCollection`**: A high-level abstraction for managing entity sets (e.g., `tasks:*`). It implements **Lazy Snapshots** and **Fluid Identity** to minimize GC pressure.
4.  **React Hooks**: Standard-compliant hooks (React 18+) like `useCollection` and `useDocument` that provide "Tear-Free" atomic rendering via `useSyncExternalStore`.

## Project Structure

*   `src/client.ts`: `NMeshedClient` orchestration.
*   `src/sync/SyncedCollection.ts`: Managed entity sets.
*   `src/core/SyncEngine.ts`: WASM core bridge.
*   `src/react/`: Reactive bindings and UI context.
*   `src/transport/`: Network encapsulation (currently supporting `WebSocketTransport`).

## Development

### Prerequisites
The WASM core must be compiled before the TypeScript code can be built or tested.

```bash
# From platform/core/rust
wasm-pack build --target web --out-dir ../../../sdks/javascript/src/wasm/pkg
```

### Testing
We maintain a >90% coverage mandate.

```bash
cd sdks/javascript
npm install
npm test
```

## Best Practices

*   **Singleton Collections**: `client.collection(prefix)` returns a cached singleton. Avoid manually instantiating `SyncedCollection`.
*   **Defensive Auth**: Use specialized `AuthProvider` adapters (Clerk, Auth0, Supabase) for robust production security.
*   **React Performance**: Destructure only what you need from the `[items, actions]` tuple to leverage React's optimization paths.
