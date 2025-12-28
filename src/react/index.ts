/**
 * React hooks for nMeshed
 *
 * @example
 * ```tsx
 * import { useSyncSession } from 'nmeshed/react';
 *
 * function App() {
 *   // 1. Auto-connect
 *   const { client, isReady, status } = useSyncSession({
 *     workspaceId: 'my-workspace',
 *     apiKey: 'nm_live_xyz'
 *   });
 *
 *   if (!isReady) return <div>Status: {status}</div>;
 *
 *   // 2. Use Client
 *   return (
 *     <button onClick={() => client.set('clicked', true)}>
 *       Click Me
 *     </button>
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
export { useSyncSession } from './useSyncSession';

// Components
export { LiveCursors } from './LiveCursors';
export { AvatarStack } from './AvatarStack';
export { NMeshedHUD } from './NMeshedHUD';

// Context
export { NMeshedProvider, useNmeshedContext, useNmeshedStatus } from './context';
export { MockNMeshedProvider, createMockClient } from './testing';

// UI Layer Constants
export { UI_LAYERS } from './layers';
export type { UILayerKey } from './layers';

// Types
export type { UseNmeshedOptions, UseNmeshedReturn } from './useNmeshed';
export type { UseDocumentOptions, UseDocumentReturn } from './useDocument';
export type { UseCursorResult } from './useCursor';
export type { NMeshedProviderProps } from './context';
