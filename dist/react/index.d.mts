import { a as NMeshedConfig, C as ConnectionStatus, N as NMeshedClient, P as PresenceUser } from '../client-D1LKSk-Q.mjs';
import * as react_jsx_runtime from 'react/jsx-runtime';
import { ReactNode } from 'react';

/**
 * Options for the useNmeshed hook.
 */
interface UseNmeshedOptions extends NMeshedConfig {
    /**
     * Callback when connected.
     */
    onConnect?: () => void;
    /**
     * Callback when disconnected.
     */
    onDisconnect?: () => void;
    /**
     * Callback when an error occurs.
     */
    onError?: (error: Error) => void;
}
/**
 * Return value of the useNmeshed hook.
 */
interface UseNmeshedReturn {
    /**
     * Current state of the workspace as a reactive object.
     */
    state: Record<string, unknown>;
    /**
     * Set a value in the workspace.
     */
    set: (key: string, value: unknown) => void;
    /**
     * Get a value from the workspace.
     */
    get: <T = unknown>(key: string) => T | undefined;
    /**
     * Current connection status.
     */
    status: ConnectionStatus;
    /**
     * Whether the client is connected.
     */
    isConnected: boolean;
    /**
     * The underlying nMeshed client instance.
     */
    client: NMeshedClient;
    /**
     * Manually connect to the server.
     */
    connect: () => Promise<void>;
    /**
     * Manually disconnect from the server.
     */
    disconnect: () => void;
    /**
     * Number of queued operations.
     */
    queueSize: number;
}
/**
 * React hook for real-time synchronization with nMeshed.
 *
 * This hook creates and manages an nMeshed client, provides reactive
 * state, and handles connection lifecycle automatically.
 *
 * @param options - Configuration and callbacks
 * @returns Object with state, setters, and connection status
 *
 * @example Basic Usage
 * ```tsx
 * function CollaborativeEditor() {
 *   const { state, set, status } = useNmeshed({
 *     workspaceId: 'my-doc',
 *     token: 'jwt-token'
 *   });
 *
 *   return (
 *     <div>
 *       <p>Status: {status}</p>
 *       <textarea
 *         value={state.content as string || ''}
 *         onChange={(e) => set('content', e.target.value)}
 *       />
 *     </div>
 *   );
 * }
 * ```
 *
 * @example With Callbacks
 * ```tsx
 * const { state, set } = useNmeshed({
 *   workspaceId: 'my-doc',
 *   token: 'jwt-token',
 *   onConnect: () => console.log('Connected!'),
 *   onDisconnect: () => console.log('Disconnected'),
 *   onError: (err) => console.error('Error:', err)
 * });
 * ```
 */
declare function useNmeshed(options: UseNmeshedOptions): UseNmeshedReturn;

/**
 * Options for the useDocument hook.
 */
interface UseDocumentOptions<T> {
    /**
     * The key to sync.
     */
    key: string;
    /**
     * Initial value before server state is received.
     */
    initialValue?: T;
}
/**
 * Return value of the useDocument hook.
 */
interface UseDocumentReturn<T> {
    /**
     * Current value of the document.
     */
    value: T | undefined;
    /**
     * Update the value.
     */
    setValue: (newValue: T) => void;
    /**
     * Whether the value has been loaded from the server.
     */
    isLoaded: boolean;
}
/**
 * Hook to sync a single key with nMeshed.
 *
 * Provides a simple useState-like interface for a single synchronized value.
 * Must be used within an nMeshedProvider.
 *
 * @param options - Configuration options
 * @returns Object with value, setter, and loading state
 *
 * @example
 * ```tsx
 * function Counter() {
 *   const { value, setValue, isLoaded } = useDocument<number>({
 *     key: 'counter',
 *     initialValue: 0
 *   });
 *
 *   if (!isLoaded) return <div>Loading...</div>;
 *
 *   return (
 *     <div>
 *       <p>Count: {value}</p>
 *       <button onClick={() => setValue((value || 0) + 1)}>
 *         Increment
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 *
 * @example With Complex Objects
 * ```tsx
 * interface Todo {
 *   id: string;
 *   text: string;
 *   done: boolean;
 * }
 *
 * function TodoItem({ id }: { id: string }) {
 *   const { value, setValue } = useDocument<Todo>({
 *     key: `todo:${id}`
 *   });
 *
 *   if (!value) return null;
 *
 *   return (
 *     <div>
 *       <input
 *         type="checkbox"
 *         checked={value.done}
 *         onChange={() => setValue({ ...value, done: !value.done })}
 *       />
 *       <span>{value.text}</span>
 *     </div>
 *   );
 * }
 * ```
 */
declare function useDocument<T = unknown>(options: UseDocumentOptions<T>): UseDocumentReturn<T>;

type UsePresenceOptions = {
    /**
     * @deprecated Polling is no longer needed; presence is real-time.
     */
    interval?: number;
};
/**
 * Hook to get the current presence list for the workspace.
 * Uses real-time WebSocket events.
 *
 * @param options - Configuration options
 * @returns Array of active users
 */
declare function usePresence(options?: UsePresenceOptions): PresenceUser[];

type BroadcastHandler = (payload: unknown) => void;
/**
 * Hook to consume and send ephemeral broadcast messages.
 *
 * @param handler - Optional callback for received messages.
 * @returns Function to broadcast messages.
 */
declare function useBroadcast(handler?: BroadcastHandler): (payload: unknown) => void;

/**
 * A drop-in component that renders live multiplayer cursors.
 * Optimized for 60fps+ by bypassing React render cycle for movement.
 * Uses requestAnimationFrame and direct DOM manipulation.
 */
declare function LiveCursors({ selfId }: {
    selfId?: string;
}): react_jsx_runtime.JSX.Element;

/**
 * A horizontal stack of avatars showing online users.
 */
declare function AvatarStack(): react_jsx_runtime.JSX.Element | null;

/**
 * Props for NMeshedProvider.
 */
interface NMeshedProviderProps {
    /**
     * Configuration for the nMeshed client.
     */
    config: NMeshedConfig;
    /**
     * Child components that will have access to the client.
     */
    children: ReactNode;
    /**
     * Whether to automatically connect on mount.
     * @default true
     */
    autoConnect?: boolean;
}
/**
 * Provider component that creates and manages an nMeshed client.
 *
 * Wrap your app (or a portion of it) with this provider to share
 * a single client instance across multiple components.
 *
 * @example
 * ```tsx
 * import { NMeshedProvider } from 'nmeshed/react';
 *
 * function App() {
 *   return (
 *     <NMeshedProvider
 *       config={{
 *         workspaceId: 'my-workspace',
 *         token: 'jwt-token'
 *       }}
 *     >
 *       <MyCollaborativeApp />
 *     </NMeshedProvider>
 *   );
 * }
 * ```
 */
declare function NMeshedProvider({ config, children, autoConnect, }: NMeshedProviderProps): react_jsx_runtime.JSX.Element;
/**
 * Hook to access the nMeshed client from context.
 *
 * Must be used within an NMeshedProvider.
 *
 * @returns The nMeshed client instance
 * @throws {Error} If used outside of NMeshedProvider
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const client = useNmeshedContext();
 *
 *   const handleClick = () => {
 *     client.set('clicked', true);
 *   };
 *
 *   return <button onClick={handleClick}>Click me</button>;
 * }
 * ```
 */
declare function useNmeshedContext(): NMeshedClient;

export { AvatarStack, LiveCursors, NMeshedProvider, type NMeshedProviderProps, type UseDocumentOptions, type UseDocumentReturn, type UseNmeshedOptions, type UseNmeshedReturn, type UsePresenceOptions, useBroadcast, useDocument, useNmeshed, useNmeshedContext, usePresence };
