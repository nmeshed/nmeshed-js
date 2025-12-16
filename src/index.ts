/**
 * nmeshed - Official JavaScript/TypeScript SDK for nMeshed
 * 
 * Real-time sync infrastructure in 5 minutes.
 * 
 * @example
 * ```typescript
 * import { NMeshedClient } from 'nmeshed';
 * 
 * const client = new NMeshedClient({
 *   workspaceId: 'my-workspace',
 *   token: 'your-jwt-token'
 * });
 * 
 * await client.connect();
 * client.set('greeting', 'Hello, world!');
 * ```
 * 
 * @packageDocumentation
 */

export { NMeshedClient } from './client';

// Types
export type {
    NMeshedConfig,
    ConnectionStatus,
    MessageHandler,
    StatusHandler,
    Operation,
    InitMessage,
    OperationMessage,
    NMeshedMessage,
} from './types';

// Errors
export {
    NMeshedError,
    ConfigurationError,
    ConnectionError,
    AuthenticationError,
    MessageError,
    QueueOverflowError,
} from './errors';

// Utilities (for advanced users)
export { parseMessage, truncate } from './validation';
