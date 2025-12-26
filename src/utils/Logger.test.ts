import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger, LogLevel, Logger } from './Logger';

describe('Logger', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => { });
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => { });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

    beforeEach(() => {
        vi.clearAllMocks();
        // Reset logger to info level
        logger.setLogLevel(LogLevel.INFO);
    });

    it('logs messages at info level by default', () => {
        logger.info('info-msg');
        expect(infoSpy).toHaveBeenCalledWith('[nMeshed] info-msg');
    });

    it('respects log levels (debug ignored at info level)', () => {
        logger.debug('debug-msg');
        expect(debugSpy).not.toHaveBeenCalled();
    });

    it('can change log level to debug', () => {
        logger.setLogLevel(LogLevel.DEBUG);
        logger.debug('debug-msg');
        expect(debugSpy).toHaveBeenCalledWith('[nMeshed] (DEBUG) debug-msg');
    });

    it('logs warnings and errors at info level', () => {
        logger.warn('warn-msg');
        expect(warnSpy).toHaveBeenCalledWith('[nMeshed] ⚠️ warn-msg');

        logger.error('error-msg');
        expect(errorSpy).toHaveBeenCalledWith('[nMeshed] ❌ error-msg');
    });

    it('supports child loggers with sub-tags', () => {
        const child = logger.child('Transport');
        child.info('connected');
        expect(infoSpy).toHaveBeenCalledWith('[nMeshed:Transport] connected');
    });

    it('supports JSON output mode', () => {
        logger.setJson(true);
        logger.info('json-msg', { id: 123 });
        expect(infoSpy).toHaveBeenCalled();
        const call = infoSpy.mock.calls[0][0];
        const parsed = JSON.parse(call);
        expect(parsed.tag).toBe('nMeshed');
        expect(parsed.message).toBe('json-msg');
        expect(parsed.data).toEqual([{ id: 123 }]);
    });
});
