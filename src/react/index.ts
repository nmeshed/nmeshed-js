/**
 * React hooks for nMeshed
 *
 * @example
 * ```tsx
 * import { useNmeshed, usePresence } from 'nmeshed/react';
 *
 * function App() {
 *   const { state, set, status } = useNmeshed({
 *     workspaceId: 'my-workspace',
 *     token: 'jwt-token'
 *   });
 *
 *   const users = usePresence();
 *
 *   return (
 *     <div>
 *       <p>Status: {status}</p>
 *       <p>Title: {state.title}</p>
 *       <input onChange={(e) => set('title', e.target.value)} />
 *       <p>{users.length} users online</p>
 *     </div>
 *   );
 * }
 * ```
 *
 * @packageDocumentation
 */

// Hooks
export { useNmeshed } from './useNmeshed';
export { useDocument } from './useDocument';
export { usePresence, generateStableColor } from './usePresence';
export { useBroadcast } from './useBroadcast';
export { useCursor } from './useCursor';
export { useStore } from './useStore';
export { usePeers } from './usePeers';
export { useConnectionState } from './useConnectionState';
export { useSyncSession } from './useSyncSession';

// Components
export { LiveCursors } from './LiveCursors';
export { AvatarStack } from './AvatarStack';
export { NMeshedHUD } from './NMeshedHUD';

// Context
export { NMeshedProvider, useNmeshedContext, useNmeshedStatus } from './context';

// UI Layer Constants
export { UI_LAYERS } from './layers';
export type { UILayerKey } from './layers';

// Types
export type { UseNmeshedOptions, UseNmeshedReturn } from './useNmeshed';
export type { UseDocumentOptions, UseDocumentReturn } from './useDocument';
export type { UsePresenceOptions } from './usePresence';
export type { UseCursorResult } from './useCursor';
export type { NMeshedProviderProps } from './context';
