import { ZodTypeAny } from 'zod';
import { SyncEngine } from './engine';

/** 
 * Note: Factories > Classes for ephemeral proxies.
 */
export function createProxy<T extends object>(engine: SyncEngine, key: string, schema: ZodTypeAny): T {
    // Get existing value or use schema-appropriate default
    const existing = engine.get<T>(key);
    // Use Zod's internal typeName for reliable detection across module boundaries
    const typeName = (schema as any)?._def?.typeName;
    const isArraySchema = typeName === 'ZodArray';

    // DEBUG 
    console.log('[StoreProxy] key:', key, 'typeName:', typeName, 'isArraySchema:', isArraySchema, 'existing:', existing);

    const target = existing ?? (isArraySchema ? [] : {}) as T;

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
