# nmeshed

Real-time sync infrastructure for multiplayer apps. **Mesh n users together.**

[![npm version](https://img.shields.io/npm/v/nmeshed)](https://www.npmjs.com/package/nmeshed)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/npm/l/nmeshed)](./LICENSE)

## Features

- 🚀 **5-minute integration** — Add real-time sync to any app
- 🎮 **Built for games** — Sync player state, inventories, world data
- ⚛️ **React hooks** — First-class React support with `useNmeshed` and `useDocument`
- 🔄 **Automatic reconnection** — Exponential backoff, operation queueing
- 📦 **Tiny bundle** — Tree-shakeable, zero dependencies
- 🔒 **Type-safe** — Full TypeScript support

## Installation

```bash
npm install nmeshed
```

## Quick Start

### Vanilla JavaScript/TypeScript

```typescript
import { NMeshedClient } from 'nmeshed';

// 1. Create a client
const client = new NMeshedClient({
  workspaceId: 'my-game-room',
  token: 'your-jwt-token'
});

// 2. Connect
await client.connect();

// 3. Listen for updates
client.onMessage((msg) => {
  if (msg.type === 'init') {
    console.log('Initial state:', msg.data);
  }
  if (msg.type === 'op') {
    console.log('Update:', msg.payload.key, '=', msg.payload.value);
  }
});

// 4. Send updates
client.set('player.position', { x: 100, y: 200 });
client.set('player.health', 100);
```

### React

```tsx
import { useNmeshed } from 'nmeshed/react';

function MultiplayerGame() {
  const { state, set, status } = useNmeshed({
    workspaceId: 'game-room',
    token: 'your-jwt-token'
  });

  return (
    <div>
      <div>Status: {status === 'CONNECTED' ? '🟢' : '🔴'} {status}</div>
      <button onClick={() => set('score', (state.score || 0) + 1)}>
        Score: {state.score || 0}
      </button>
    </div>
  );
}
```

### React with Context (Recommended)

```tsx
import { NMeshedProvider, useDocument } from 'nmeshed/react';

function App() {
  return (
    <NMeshedProvider
      config={{
        workspaceId: 'my-game',
        token: 'your-jwt-token'
      }}
    >
      <GameUI />
    </NMeshedProvider>
  );
}

function GameUI() {
  const { value: score, setValue: setScore } = useDocument<number>({
    key: 'score',
    initialValue: 0
  });

  return (
    <button onClick={() => setScore((score || 0) + 1)}>
      Score: {score}
    </button>
  );
}
```

## API Reference

### `NMeshedClient`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `workspaceId` | `string` | **required** | Room/workspace ID |
| `token` | `string` | **required** | JWT auth token |
| `serverUrl` | `string` | `wss://api.nmeshed.com` | Server URL |
| `autoReconnect` | `boolean` | `true` | Auto-reconnect on disconnect |
| `debug` | `boolean` | `false` | Enable console logging |

### Methods

| Method | Description |
|--------|-------------|
| `connect()` | Connect to the server |
| `disconnect()` | Disconnect from the server |
| `set(key, value)` | Set/update a value |
| `get<T>(key)` | Get a value from local state |
| `getState()` | Get entire local state |
| `onMessage(handler)` | Subscribe to messages |
| `onStatusChange(handler)` | Subscribe to status changes |

## Use Cases

- **Multiplayer Games** — Sync player positions, game state, inventories
- **Collaborative Apps** — Real-time document editing, whiteboards
- **Live Dashboards** — Push updates to connected clients
- **Chat & Presence** — Who's online, typing indicators

## License

MIT © nMeshed

## Links

- [Website](https://nmeshed.com)
- [GitHub](https://github.com/nmeshed/nmeshed)
