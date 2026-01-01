# AI State Adapter

## The Problem
LLMs are stateless. Multi-user AI applications suffer from "Split Brain": User A asks the AI something, User B doesn't see the context.
Traditional solutions (sending full history to DB) are slow and lack real-time "typing" feels.

## The Zen Solution
We treat the AI Context Window as a **CRDT**.
`nmeshed` becomes the "Long-Term Memory" and "Real-Time Bus" for the Vercel AI SDK.

## Architecture
`useSyncedChat` wraps `useChat`.

1. **Hydration**: `initialMessages` are pulled from `nmeshed` (offline-capable).
2. **Mutation**: When `useChat` adds a user message, we atomically `set` it in `nmeshed`.
3. **Stream Sync**: As the AI response streams in:
   - *Option A (Chatty)*: Sync every N tokens (Real-time).
   - *Option B (Quiet)*: Sync only the final message (Simpler).
   - **Decision**: Option A with `debounce` (Action through Inaction). We want the "ghost" of the AI to appear for everyone.

## Interface
```typescript
import { useChat } from 'ai/react';
import { useSyncedChat } from 'nmeshed/ai';

const { messages, input, handleSubmit } = useSyncedChat({
  workspaceId: '...',
  channel: 'agent-1',
  config: { ...useChatOptions } 
});
```

## Data Model
`chat::{channel}::{timestamp}::{id}` -> `Message` (JSON)
We use the `timestamp` for sorting, `id` for uniqueness.

## Token Efficiency
To prevent "Context Bloat", we implement `SlidingWindowSync`:
- We only sync the last `N` messages to the `useChat` context hook active set.
- Older messages remain in `nmeshed` storage but are not hot-loaded into the prompt unless requested.
