import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Logger, LogLevel, logger } from './Logger';

describe('Logger', () => {
    let infoSpy: any;
    let debugSpy: any;
    let warnSpy: any;
    let errorSpy: any;

    beforeEach(() => {
        infoSpy = vi.spyOn(console, 'info').mockImplementation(() => { });
        debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => { });
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
        logger.setLogLevel(LogLevel.INFO);
        logger.setJson(false);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should log info messages by default', () => {
        logger.info('hello world');
        expect(infoSpy).toHaveBeenCalledWith('[nMeshed] hello world');
    });

    it('constructor with debug=true sets DEBUG level', () => {
        const debugLogger = new Logger('TestDebug', true);
        debugLogger.debug('debug message');
        expect(debugSpy).toHaveBeenCalled();
    });

    it('error() logs with error prefix', () => {
        logger.error('something failed');
        expect(errorSpy).toHaveBeenCalledWith('[nMeshed] ❌ something failed');
    });

    it('warn() logs with warning prefix', () => {
        logger.warn('a warning');
        expect(warnSpy).toHaveBeenCalledWith('[nMeshed] ⚠️ a warning');
    });

    it('should not log debug messages by default', () => {
        logger.debug('should not see this');
        expect(debugSpy).not.toHaveBeenCalled();
    });

    it('should log debug messages when level is set to DEBUG', () => {
        logger.setLogLevel(LogLevel.DEBUG);
        logger.debug('debugging enabled');
        expect(debugSpy).toHaveBeenCalledWith('[nMeshed] (DEBUG) debugging enabled');
    });

    it('respects log levels (false branches)', () => {
        logger.setLogLevel(LogLevel.ERROR);
        logger.debug('test');
        logger.info('test');
        logger.warn('test');
        logger.conn('test');
        expect(infoSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
        expect(debugSpy).not.toHaveBeenCalled();

        logger.setLogLevel(LogLevel.NONE);
        logger.error('test');
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('creates child loggers with inherited settings', () => {
        const child = logger.child('Transport');
        child.info('connected');
        expect(infoSpy).toHaveBeenCalledWith('[nMeshed:Transport] connected');
    });

    it('logs in JSON mode', () => {
        logger.setJson(true);
        logger.info('test-json', { key: 'val' });
        expect(infoSpy).toHaveBeenCalled();
        const call = infoSpy.mock.calls[0][0];
        const parsed = JSON.parse(call);
        expect(parsed.message).toBe('test-json');
        expect(parsed.data).toBeDefined();
    });

    it('conn() logs at DEBUG level', () => {
        logger.setLogLevel(LogLevel.DEBUG);
        logger.conn('handshake-started');
        expect(debugSpy).toHaveBeenCalledWith('[nMeshed] handshake-started');
    });

    it('serializes to JSON correctly via toJSON', () => {
        const data = logger.toJSON();
        expect(data).toEqual({
            tag: 'nMeshed',
            level: LogLevel.INFO,
            useJson: false
        });
    });

    it('supports JSON output mode without data', () => {
        logger.setJson(true);
        logger.info('json-msg-no-data');
        expect(infoSpy).toHaveBeenCalled();
        const call = infoSpy.mock.calls[0][0];
        const parsed = JSON.parse(call);
        expect(parsed.data).toBeUndefined();
    });

    describe('toViewable', () => {
        it('converts BigInt to string with n suffix', () => {
            const result = Logger.toViewable(123n);
            expect(result).toBe('123n');
        });

        it('recursively handles objects and arrays', () => {
            const input = {
                a: [1n, 2n],
                b: { c: 3n }
            };
            const result = Logger.toViewable(input);
            expect(result).toEqual({
                a: ['1n', '2n'],
                b: { c: '3n' }
            });
        });

        it('handles null and undefined', () => {
            expect(Logger.toViewable(null)).toBeNull();
            expect(Logger.toViewable(undefined)).toBeUndefined();
        });

        it('preserves other types', () => {
            expect(Logger.toViewable("text")).toBe("text");
            expect(Logger.toViewable(123)).toBe(123);
            expect(Logger.toViewable(true)).toBe(true);
        });

        it('ignores inherited properties', () => {
            const proto = { inherited: 1n };
            const obj = Object.create(proto);
            obj.local = 2n;
            const result = Logger.toViewable(obj);
            expect(result).toEqual({ local: '2n' });
            expect(result.inherited).toBeUndefined();
        });
    });
});
