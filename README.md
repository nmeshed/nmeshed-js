# nMeshed JavaScript/TypeScript SDK

The official browser-ready client for [nMeshed](https://nmeshed.com). Now powered by **nmeshed-core (WASM)**, providing industry-standard Automerge CRDTs for robust, offline-first multiplayer sync. Add collaborative state to any JavaScript application in minutes.

[![npm version](https://img.shields.io/npm/v/nmeshed)](https://www.npmjs.com/package/nmeshed)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/npm/l/nmeshed)](./LICENSE)

---

## ⚡️ Quick Start (React)

### 1. Installation

```bash
npm install nmeshed
# or
yarn add nmeshed
```

### 2. Setup the Provider

Wrap your application root. You will need a JWT signed by your backend (see [Authentication Guide](https://docs.nmeshed.com/guides/authentication)).

```tsx
// App.tsx
import { NMeshedProvider } from 'nmeshed/react';

const config = {
  workspaceId: 'room-123',
  token: 'YOUR_JWT_TOKEN', // Fetch this from your backend
};

export default function App() {
  return (
    <NMeshedProvider config={config}>
      <GameCanvas />
    </NMeshedProvider>
  );
}
```

### 3. Use Shared State

Use `useDocument` to sync data that needs to be persisted (like a document or game score).

```tsx
// ScoreBoard.tsx
import { useDocument } from 'nmeshed/react';

export function ScoreBoard() {
  // 1. Read & Subscription
  const { value: score, setValue: setScore } = useDocument<number>({
    key: 'player_score',
    initialValue: 0
  });

  // 2. Write (Optimistic UI)
  return (
    <button onClick={() => setScore((score || 0) + 1)}>
      Score: {score}
    </button>
  );
}
```

---

## 🧠 Core Concepts

### State vs. Signal

To scale to 1,000+ users, choose the right tool:

| Feature | Tool | Persistence | Use Case |
|---|---|---|---|
| **Inventory, Documents, Chat** | `useDocument()` | ✅ Yes | Needs history and offline sync. |
| **Cursors, Typing, Selection** | `useBroadcast()` | ❌ No | High frequency (60fps), okay to drop. |
| **Online Status** | `usePresence()` | ❌ No | "Who is online?" |

---

## 🛠 Advanced Usage

### Schema-Driven State with `useStore`

For complex applications, use `defineSchema` and `useStore` for type-safe, auto-serialized state:

```tsx
import { defineSchema } from 'nmeshed';
import { useStore } from 'nmeshed/react';

const BoardSchema = defineSchema({
  title: 'string',
  tasks: { type: 'map', schema: { id: 'string', title: 'string' } }
});

function KanbanBoard() {
  const [board, setBoard] = useStore(BoardSchema);
  
  // Update state - automatically encoded and synced
  setBoard({ title: 'My Board' });
  
  return <h1>{board.title}</h1>;
}
```

### Local Development (No Cloud)

Use the `nm_local_` prefix for zero-config local development:

```tsx
const config = {
  workspaceId: 'my-room',
  apiKey: 'nm_local_dev',  // Auto-routes to localhost:8080
};
```

Or specify the URL manually:

```tsx
const config = {
  workspaceId: 'dev-room',
  token: 'dev-token',
  serverUrl: 'ws://localhost:8080/v1/sync'
};
```

### Direct Client Access (Vanilla JS / Game Engines)

For Phaser, Three.js, or non-React apps:

```typescript
import { NMeshedClient } from 'nmeshed';

const client = new NMeshedClient({
  workspaceId: 'game-lobby',
  token: 'TOKEN'
});

await client.connect();

// Listen for updates
client.onMessage((msg) => {
  if (msg.type === 'op') {
    console.log(`Key ${msg.payload.key} changed to`, msg.payload.value);
  }
});
```

---

## 🚨 Troubleshooting ("What If It Fails?")

### `WebSocket connection to 'ws://...' failed`
*   **Cause**: The server is down or unreachable.
*   **Fix 1**: If local, run `curl http://localhost:8080/healthz` to verify it's up.
*   **Fix 2**: Check if you are mixing `ws://` (insecure) with `https://` (secure site). Browsers block this. Use `wss://` on production.

### `auth_rejected`
*   **Cause**: The token signature is invalid.
*   **Fix**: Ensure your backend uses the same `NMESHED_SECRET` as the one configured in the Dashboard.

### `useEffect` Double Connections
*   **Cause**: React Strict Mode mounts components twice in dev.
*   **Fix**: `NMeshedProvider` handles this safely. If using `NMeshedClient` manually, ensure you call `.disconnect()` in the cleanup function.

---

## 📚 API Reference

For full API documentation, visit [docs.nmeshed.com](https://docs.nmeshed.com).
