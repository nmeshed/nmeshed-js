import { ZodTypeAny, ZodArray } from 'zod';
import { SyncEngine } from './engine';

/** 
 * Note: Factories > Classes for ephemeral proxies.
 */
export function createProxy<T extends object>(engine: SyncEngine, key: string, schema: ZodTypeAny): T {
    // Infer default: Arrays default to [], Objects to {}, others to undefined (let engine handle it)
    const def = schema instanceof ZodArray ? [] : {};
    const target = engine.get<T>(key) || def as T;

    return new Proxy(target, {
        get: (obj, prop) => (Array.isArray(obj) && prop === 'push')
            ? (...items: any[]) => {
                // Mutate local
                const newLength = Array.prototype.push.apply(obj, items);
                // Sync (Optimistic LWW -> ListOp Pending)
                engine.set(key, obj);
                return newLength;
            }
            : Reflect.get(obj, prop),

        set: (obj, prop, value) => {
            const success = Reflect.set(obj, prop, value);
            if (success) engine.set(key, obj);
            return success;
        }
    });
}
