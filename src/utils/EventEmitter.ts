/**
 * A tiny, type-safe event emitter to replace sprawling Set<Handler> patterns.
 * 
 * Design Choices:
 * - **Type-safe**: Event names and argument types are enforced at compile time.
 * - **Error boundaries**: Exceptions in handlers don't break other listeners.
 * - **Zero dependencies**: No external libraries required.
 * - **Memory-safe**: Returns unsubscribe functions to prevent leaks.
 * 
 * @example
 * ```typescript
 * interface MyEvents { data: [string]; error: [Error] }
 * const emitter = new EventEmitter<MyEvents>();
 * const unsub = emitter.on('data', (msg) => console.log(msg));
 * emitter.emit('data', 'hello');
 * unsub(); // Clean up
 * ```
 */
export class EventEmitter<T extends Record<string, any[]> & { [K: string]: any[] }> {
    private listeners: { [K in keyof T]?: Set<(...args: T[K]) => void> } = {};

    /**
     * Subscribe to an event.
     * @returns Unsubscribe function
     */
    on<K extends keyof T>(event: K, handler: (...args: T[K]) => void): () => void {
        if (!this.listeners[event]) {
            this.listeners[event] = new Set();
        }
        this.listeners[event]!.add(handler);
        return () => this.off(event, handler);
    }

    /**
     * Unsubscribe from an event.
     */
    off<K extends keyof T>(event: K, handler: (...args: T[K]) => void): void {
        this.listeners[event]?.delete(handler);
    }

    /**
     * Emit an event.
     */
    emit<K extends keyof T>(event: K, ...args: T[K]): void {
        const handlers = this.listeners[event];
        if (!handlers) return;

        for (const handler of Array.from(handlers)) {
            try {
                handler(...args);
            } catch (err) {
                console.error(`[EventEmitter] Error in listener for ${String(event)}:`, err);
            }
        }
    }

    /**
     * Subscribe to an event once.
     */
    once<K extends keyof T>(event: K, handler: (...args: T[K]) => void): () => void {
        const wrapper = (...args: T[K]) => {
            this.off(event, wrapper);
            handler(...args);
        };
        return this.on(event, wrapper);
    }

    /**
     * Remove all listeners.
     */
    removeAllListeners(): void {
        this.listeners = {};
    }
}
