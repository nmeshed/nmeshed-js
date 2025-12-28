/**
 * Internal logging utility for the nMeshed SDK.
 * Provides structured logging with levels and tags, allowing for
 * easy control of log noise in production environments.
 */
export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
    NONE = 4
}

export class Logger {
    private level: LogLevel = LogLevel.INFO;
    private tag: string;
    private useJson: boolean = false;

    constructor(tag: string = 'nMeshed', debug: boolean = false) {
        this.tag = tag;
        if (debug) {
            this.level = LogLevel.DEBUG;
        }
    }

    public setLogLevel(level: LogLevel): void {
        this.level = level;
    }

    public setJson(enabled: boolean): void {
        this.useJson = enabled;
    }

    private log(method: 'debug' | 'info' | 'warn' | 'error', levelName: string, message: string, ...args: any[]): void {
        if (this.useJson) {
            const entry = {
                timestamp: new Date().toISOString(),
                tag: this.tag,
                level: levelName,
                message,
                data: args.length > 0 ? args : undefined
            };
            console[method](JSON.stringify(entry));
        } else {
            const prefix = `[${this.tag}]${levelName === 'DEBUG' ? ' (DEBUG)' : ''}${levelName === 'WARN' ? ' ⚠️' : ''}${levelName === 'ERROR' ? ' ❌' : ''}`;
            console[method](`${prefix} ${message}`, ...args);
        }
    }

    public debug(message: string, ...args: any[]): void {
        if (this.level <= LogLevel.DEBUG) {
            this.log('debug', 'DEBUG', message, ...args);
        }
    }

    public info(message: string, ...args: any[]): void {
        if (this.level <= LogLevel.INFO) {
            this.log('info', 'INFO', message, ...args);
        }
    }

    public conn(message: string, ...args: any[]): void {
        if (this.level <= LogLevel.DEBUG) {
            this.log('debug', 'CONN', message, ...args);
        }
    }

    public warn(message: string, ...args: any[]): void {
        if (this.level <= LogLevel.WARN) {
            this.log('warn', 'WARN', message, ...args);
        }
    }

    public error(message: string, ...args: any[]): void {
        if (this.level <= LogLevel.ERROR) {
            this.log('error', 'ERROR', message, ...args);
        }
    }

    /**
     * Creates a child logger with an extended tag.
     */
    public child(subTag: string): Logger {
        const child = new Logger(`${this.tag}:${subTag}`);
        child.setLogLevel(this.level);
        child.setJson(this.useJson);
        return child;
    }

    /**
     * Support for JSON.stringify(logger)
     */
    public toJSON() {
        return {
            tag: this.tag,
            level: this.level,
            useJson: this.useJson
        };
    }

    /**
     * Converts an object to a JSON-safe format by handling BigInt values.
     * Use this for debugging/logging state that may contain BigInts.
     */
    public static toViewable(obj: any): any {
        if (obj === null || obj === undefined) return obj;
        if (typeof obj === 'bigint') return obj.toString() + 'n';
        if (Array.isArray(obj)) return obj.map(item => Logger.toViewable(item));
        if (typeof obj === 'object') {
            const result: any = {};
            for (const key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                    result[key] = Logger.toViewable(obj[key]);
                }
            }
            return result;
        }
        return obj;
    }
}

// Global default logger
export const logger = new Logger('nMeshed');
