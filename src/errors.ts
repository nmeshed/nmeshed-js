/**
 * Error types for nMeshed SDK.
 * 
 * Using typed errors allows consumers to handle specific failure modes 
 * with structural precision.
 */

/**
 * Base class for all nMeshed errors.
 */
export class NMeshedError extends Error {
    constructor(message: string, public readonly code: string) {
        super(message);
        this.name = 'NMeshedError';
        // Maintains proper stack trace for where error was thrown (V8 only)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, NMeshedError);
        }
    }
}

/**
 * Thrown when configuration is invalid.
 */
export class ConfigurationError extends NMeshedError {
    constructor(message: string) {
        super(message, 'CONFIGURATION_ERROR');
        this.name = 'ConfigurationError';
    }
}

/**
 * Thrown when connection fails or times out.
 */
export class ConnectionError extends NMeshedError {
    constructor(
        message: string,
        public readonly cause?: Error,
        public readonly isRetryable: boolean = true
    ) {
        super(message, 'CONNECTION_ERROR');
        this.name = 'ConnectionError';
    }
}

/**
 * Thrown when authentication fails.
 */
export class AuthenticationError extends NMeshedError {
    constructor(message: string = 'Authentication failed') {
        super(message, 'AUTHENTICATION_ERROR');
        this.name = 'AuthenticationError';
    }
}

/**
 * Thrown when a message fails to parse or validate.
 */
export class MessageError extends NMeshedError {
    constructor(
        message: string,
        public readonly rawMessage?: string
    ) {
        super(message, 'MESSAGE_ERROR');
        this.name = 'MessageError';
    }
}

/**
 * Thrown when the operation queue exceeds capacity.
 */
export class QueueOverflowError extends NMeshedError {
    constructor(maxSize: number) {
        super(
            `Operation queue exceeded maximum capacity of ${maxSize}. ` +
            'Consider increasing maxQueueSize or reducing send frequency.',
            'QUEUE_OVERFLOW_ERROR'
        );
        this.name = 'QueueOverflowError';
    }
}

/**
 * Thrown when an operation is attempted on a destroyed client.
 */
export class ClientError extends NMeshedError {
    constructor(message: string) {
        super(message, 'CLIENT_ERROR');
        this.name = 'ClientError';
    }
}

/**
 * Thrown when schema registration or decoding fails.
 */
export class SchemaError extends NMeshedError {
    constructor(message: string) {
        super(message, 'SCHEMA_ERROR');
        this.name = 'SchemaError';
    }
}
