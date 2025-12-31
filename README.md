# nMeshed JavaScript SDK

> **Real-time state synchronization for React applications.**
> Sub-16ms latency. Zero backend configuration. Type-safe by default.

[![npm version](https://badge.fury.io/js/nmeshed.svg)](https://www.npmjs.com/package/nmeshed)

---

## Installation

```bash
npm install nmeshed zod
```

**Expected output:**
```
added 2 packages in 1.2s
```

> [!NOTE]
> `zod` is a peer dependency used for schema validation. It's required for type-safe synchronization.

---

## Quick Start (React)

### Step 1: Wrap your app with the Provider

```tsx
// main.tsx
import { NMeshedProvider } from 'nmeshed/react';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <NMeshedProvider
    workspaceId="my-workspace-123"
    token="nm_local_dev" // Use real token in production
  >
    <App />
  </NMeshedProvider>
);
```

### Step 2: Use synchronized state

```tsx
// Counter.tsx
import { useSyncedValue } from 'nmeshed/react';

export function Counter() {
  const [count, setCount] = useSyncedValue('counter', 0);

  return (
    <button onClick={() => setCount(count + 1)}>
      Count: {count}
    </button>
  );
}
```

### Step 3: Open two browser windows

Changes in one window appear instantly in the other. That's it.

---

## Core Concepts

### The Provider

`NMeshedProvider` initializes the WebSocket connection and provides context to all hooks.

| Prop | Type | Required | Description |
|:-----|:-----|:--------:|:------------|
| `workspaceId` | `string` | ✅ | Unique identifier for the sync room |
| `token` | `string` | ✅ | Authentication token (`nm_local_dev` for local development) |
| `serverUrl` | `string` | ❌ | Custom server URL (default: cloud) |
| `schemas` | `Record<string, ZodSchema>` | ❌ | Schema definitions for `useStore` |

### Hooks Reference

| Hook | Purpose | Example |
|:-----|:--------|:--------|
| `useSyncedValue(key, default)` | Sync a single value | Counters, toggles |
| `useStore<T>(storeKey)` | Sync a schema-validated object | Complex state |
| `useSyncedMap(key, default)` | Sync a key-value map | User lists |
| `useSyncedList(key, default)` | Sync an ordered list | Task lists |
| `useConnectionStatus()` | Get connection state | Status indicators |
| `useOnChange(key, callback)` | React to remote changes | Notifications |

---

## Schema-Driven State (Recommended)

For complex applications, define your state shape with Zod:

```tsx
// schema.ts
import { z } from 'zod';

export const BoardSchema = z.object({
  columns: z.record(z.object({
    id: z.string(),
    title: z.string(),
    taskIds: z.array(z.string())
  })),
  tasks: z.record(z.object({
    id: z.string(),
    content: z.string(),
    assignee: z.string().optional()
  }))
});
```

```tsx
// main.tsx
<NMeshedProvider
  workspaceId="board-123"
  token="nm_local_dev"
  schemas={{ board: BoardSchema }}
>
  <KanbanBoard />
</NMeshedProvider>
```

```tsx
// KanbanBoard.tsx
import { useStore } from 'nmeshed/react';

export function KanbanBoard() {
  const board = useStore<z.infer<typeof BoardSchema>>('board');

  // Direct mutation — the SDK handles sync automatically
  const addTask = (columnId: string, content: string) => {
    const id = crypto.randomUUID();
    board.tasks[id] = { id, content };
    board.columns[columnId].taskIds.push(id);
  };

  return (/* render columns and tasks */);
}
```

---

## Connection Status

Monitor the WebSocket connection state:

```tsx
import { useConnectionStatus } from 'nmeshed/react';

function StatusIndicator() {
  const status = useConnectionStatus();
  // Returns: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

  return (
    <span style={{ color: status === 'connected' ? 'green' : 'red' }}>
      {status}
    </span>
  );
}
```

---

## Troubleshooting

### "WebSocket connection failed"

**Cause:** The sync server isn't running or is unreachable.

**Fix (Local Development):**
```bash
cd platform/server
cargo run
```

**Expected output:**
```
INFO listening on 0.0.0.0:9000
```

---

### "Property 'x' does not exist on type '{}'"

**Cause:** TypeScript doesn't know the shape of your store.

**Fix:** Pass a type parameter to `useStore`:
```tsx
// Before (error)
const board = useStore('board');

// After (correct)
const board = useStore<BoardState>('board');
```

---

### "Module not found: nmeshed/react"

**Cause:** Your bundler isn't resolving the subpath export.

**Fix:** Ensure you're using a modern bundler (Vite, webpack 5+, esbuild). If using Next.js, add to `next.config.js`:
```js
transpilePackages: ['nmeshed']
```

---

## Advanced: Vanilla JavaScript

For non-React applications:

```javascript
import { NMeshedClient } from 'nmeshed';

const client = new NMeshedClient({
  workspaceId: 'my-workspace',
  token: 'nm_local_dev',
  serverUrl: 'ws://localhost:9000'
});

await client.connect();

// Set a value
client.set('counter', 42);

// Listen for changes
client.on('op', (key, value) => {
  console.log(`${key} changed to:`, value);
});
```

---

## API Reference

Full TypeScript API documentation is auto-generated:

- [Core Exports](./docs/api/index.md)
- [React Hooks](./docs/api/react.md)

---

## Examples

| Example | Description | Directory |
|:--------|:------------|:----------|
| **Cursors** | Multi-user cursor presence | [`examples/cursors`](../../examples/cursors) |
| **Kanban** | Collaborative task board | [`examples/kanban`](../../examples/kanban) |
| **Next.js** | Server Components + Client Sync | [`examples/next-app-router`](../../examples/next-app-router) |

---

## License

MIT
