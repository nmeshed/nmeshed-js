import { describe, it, expect } from 'vitest';
import {
    NMeshedError,
    ConfigurationError,
    ConnectionError,
    AuthenticationError,
    MessageError,
    QueueOverflowError
} from './errors';

describe('Errors', () => {
    it('NMeshedError should work', () => {
        const err = new NMeshedError('test', 'CODE');
        expect(err.message).toBe('test');
        expect(err.code).toBe('CODE');
        expect(err.name).toBe('NMeshedError');
    });

    it('ConfigurationError should work', () => {
        const err = new ConfigurationError('bad config');
        expect(err.code).toBe('CONFIGURATION_ERROR');
        expect(err.name).toBe('ConfigurationError');
    });

    it('ConnectionError should work', () => {
        const cause = new Error('root cause');
        const err = new ConnectionError('failed', cause, false);
        expect(err.code).toBe('CONNECTION_ERROR');
        expect(err.cause).toBe(cause);
        expect(err.isRetryable).toBe(false);
    });

    it('AuthenticationError should work', () => {
        const err = new AuthenticationError();
        expect(err.code).toBe('AUTHENTICATION_ERROR');
        expect(err.message).toBe('Authentication failed');
    });

    it('MessageError should work', () => {
        const err = new MessageError('invalid', 'raw');
        expect(err.code).toBe('MESSAGE_ERROR');
        expect(err.rawMessage).toBe('raw');
    });

    it('QueueOverflowError should work', () => {
        const err = new QueueOverflowError(100);
        expect(err.code).toBe('QUEUE_OVERFLOW_ERROR');
        expect(err.message).toContain('100');
    });
});
