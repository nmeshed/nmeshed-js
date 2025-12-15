import { n as nMeshedMessage } from './client-BAB1wtLZ.js';
export { C as ConnectionStatus, I as InitMessage, M as MessageHandler, O as Operation, c as OperationMessage, S as StatusHandler, a as nMeshedClient, b as nMeshedConfig } from './client-BAB1wtLZ.js';

/**
 * Error types for nMeshed SDK.
 *
 * Using typed errors allows consumers to handle specific failure modes.
 */
/**
 * Base class for all nMeshed errors.
 */
declare class nMeshedError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
/**
 * Thrown when configuration is invalid.
 */
declare class ConfigurationError extends nMeshedError {
    constructor(message: string);
}
/**
 * Thrown when connection fails or times out.
 */
declare class ConnectionError extends nMeshedError {
    readonly cause?: Error | undefined;
    readonly isRetryable: boolean;
    constructor(message: string, cause?: Error | undefined, isRetryable?: boolean);
}
/**
 * Thrown when authentication fails.
 */
declare class AuthenticationError extends nMeshedError {
    constructor(message?: string);
}
/**
 * Thrown when a message fails to parse or validate.
 */
declare class MessageError extends nMeshedError {
    readonly rawMessage?: string | undefined;
    constructor(message: string, rawMessage?: string | undefined);
}
/**
 * Thrown when the operation queue exceeds capacity.
 */
declare class QueueOverflowError extends nMeshedError {
    constructor(maxSize: number);
}

/**
 * Parses and validates a raw message string from the server.
 *
 * @param raw - Raw JSON string from WebSocket
 * @returns Validated nMeshedMessage
 * @throws {MessageError} If message is invalid
 */
declare function parseMessage(raw: string): nMeshedMessage;
/**
 * Safely truncates a string for logging/error messages.
 */
declare function truncate(str: string, maxLength?: number): string;

export { AuthenticationError, ConfigurationError, ConnectionError, MessageError, QueueOverflowError, nMeshedError, nMeshedMessage, parseMessage, truncate };
