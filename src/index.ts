/**
 * nmeshed - Official JavaScript/TypeScript SDK for nMeshed
 * 
 * Real-time sync infrastructure in 5 minutes.
 * 
 * @example
 * ```typescript
 * import { nMeshedClient } from 'nmeshed';
 * 
 * const client = new nMeshedClient({
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

export { nMeshedClient } from './client';

// Types
export type {
    nMeshedConfig,
    ConnectionStatus,
    MessageHandler,
    StatusHandler,
    Operation,
    InitMessage,
    OperationMessage,
    nMeshedMessage,
} from './types';

// Errors
export {
    nMeshedError,
    ConfigurationError,
    ConnectionError,
    AuthenticationError,
    MessageError,
    QueueOverflowError,
} from './errors';

// Utilities (for advanced users)
export { parseMessage, truncate } from './validation';
