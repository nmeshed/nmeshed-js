/**
 * @file Logger.ts
 * @brief Conditional logging utility for zero-overhead production builds.
 *
 * Provides structured logging with categories and conditional compilation.
 * In production builds, debug/info logs can be disabled via configuration
 * to eliminate console overhead in hot paths.
 *
 * @example
 * ```typescript
 * import { logger } from './utils/Logger';
 *
 * logger.net('Connecting...'); // [NET] Connecting...
 * logger.debug('Verbose info'); // Only when debug enabled
 * ```
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LoggerConfig {
    enabled: boolean;
    level: LogLevel;
    categories: {
        net: boolean;
        mesh: boolean;
        sig: boolean;
        conn: boolean;
    };
}

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

/**
 * Default configuration - can be overridden at runtime.
 */
const config: LoggerConfig = {
    enabled: typeof process !== 'undefined'
        ? process.env.NODE_ENV !== 'production'
        : true,
    level: 'info',
    categories: {
        net: true,
        mesh: true,
        sig: true,
        conn: true,
    },
};

function shouldLog(level: LogLevel): boolean {
    if (!config.enabled) return false;
    return LOG_LEVELS[level] >= LOG_LEVELS[config.level];
}

/**
 * Structured logger with category prefixes.
 */
export const logger = {
    /** Configure logger at runtime */
    configure: (updates: Partial<LoggerConfig>) => {
        Object.assign(config, updates);
    },

    /** Enable debug logging */
    enableDebug: () => {
        config.level = 'debug';
    },

    /** Network logs */
    net: (message: string, ...args: unknown[]) => {
        if (config.categories.net && shouldLog('info')) {
            console.log(`[NET] ${message}`, ...args);
        }
    },

    /** Mesh client logs */
    mesh: (message: string, ...args: unknown[]) => {
        if (config.categories.mesh && shouldLog('info')) {
            console.log(`[MESH] ${message}`, ...args);
        }
    },

    /** Signaling client logs */
    sig: (message: string, ...args: unknown[]) => {
        if (config.categories.sig && shouldLog('info')) {
            console.log(`[SIG] ${message}`, ...args);
        }
    },

    /** Connection manager logs */
    conn: (message: string, ...args: unknown[]) => {
        if (config.categories.conn && shouldLog('info')) {
            console.log(`[CONN] ${message}`, ...args);
        }
    },

    /** Debug-level logs (disabled in production) */
    debug: (message: string, ...args: unknown[]) => {
        if (shouldLog('debug')) {
            console.log(`[DEBUG] ${message}`, ...args);
        }
    },

    /** Warning logs */
    warn: (message: string, ...args: unknown[]) => {
        if (shouldLog('warn')) {
            console.warn(`[WARN] ${message}`, ...args);
        }
    },

    /** Error logs (always enabled) */
    error: (message: string, ...args: unknown[]) => {
        console.error(`[ERROR] ${message}`, ...args);
    },
};
