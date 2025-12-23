import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from './Logger';

describe('Logger', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

    beforeEach(() => {
        vi.clearAllMocks();
        // Reset logger to a known good state
        logger.configure({ enabled: true, level: 'info', categories: { net: true, mesh: true, sig: true, conn: true } });
    });

    it('logs messages by category', () => {
        logger.net('net-msg');
        expect(logSpy).toHaveBeenCalledWith('[NET] net-msg');

        logger.mesh('mesh-msg');
        expect(logSpy).toHaveBeenCalledWith('[MESH] mesh-msg');
    });

    it('respects log levels', () => {
        logger.configure({ level: 'warn' });
        logger.debug('debug-msg');
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('can be disabled', () => {
        logger.configure({ enabled: false });
        logger.net('silent');
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('supports debug level', () => {
        logger.configure({ enabled: true });
        logger.enableDebug();
        logger.debug('verbose');
        expect(logSpy).toHaveBeenCalledWith('[DEBUG] verbose');
    });
});
