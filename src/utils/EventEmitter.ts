
/**
 * A tiny, type-safe event emitter to replace the sprawling Set<Handler> patterns.
 * Designed for readability and zero dependencies.
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
     * Remove all listeners.
     */
    removeAllListeners(): void {
        this.listeners = {};
    }
}
