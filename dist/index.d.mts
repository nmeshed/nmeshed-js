import { N as NMeshedMessage } from './client-Cs0HhYm5.mjs';
export { C as ConnectionStatus, I as InitMessage, M as MessageHandler, a as NMeshedClient, b as NMeshedConfig, O as Operation, c as OperationMessage, S as StatusHandler } from './client-Cs0HhYm5.mjs';

/**
 * Error types for nMeshed SDK.
 *
 * Using typed errors allows consumers to handle specific failure modes.
 */
/**
 * Base class for all nMeshed errors.
 */
declare class NMeshedError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
/**
 * Thrown when configuration is invalid.
 */
declare class ConfigurationError extends NMeshedError {
    constructor(message: string);
}
/**
 * Thrown when connection fails or times out.
 */
declare class ConnectionError extends NMeshedError {
    readonly cause?: Error | undefined;
    readonly isRetryable: boolean;
    constructor(message: string, cause?: Error | undefined, isRetryable?: boolean);
}
/**
 * Thrown when authentication fails.
 */
declare class AuthenticationError extends NMeshedError {
    constructor(message?: string);
}
/**
 * Thrown when a message fails to parse or validate.
 */
declare class MessageError extends NMeshedError {
    readonly rawMessage?: string | undefined;
    constructor(message: string, rawMessage?: string | undefined);
}
/**
 * Thrown when the operation queue exceeds capacity.
 */
declare class QueueOverflowError extends NMeshedError {
    constructor(maxSize: number);
}

/**
 * Parses and validates a raw message string from the server.
 *
 * @param raw - Raw JSON string from WebSocket
 * @returns Validated nMeshedMessage
 * @throws {MessageError} If message is invalid
 */
declare function parseMessage(raw: string): NMeshedMessage;
/**
 * Safely truncates a string for logging/error messages.
 */
declare function truncate(str: string, maxLength?: number): string;

export { AuthenticationError, ConfigurationError, ConnectionError, MessageError, NMeshedError, NMeshedMessage, QueueOverflowError, parseMessage, truncate };
