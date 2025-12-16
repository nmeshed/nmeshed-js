import { z } from 'zod';
import { MessageError } from './errors';
import type { NMeshedMessage } from './types';

/**
 * Zod schemas for message validation.
 * Enforcing "Zod at the Gates" to trust no one.
 */

const PresenceUserSchema = z.object({
    userId: z.string(),
    // We allow string to handle future status types without crashing, 
    // but we prefer the known union.
    // We strictly enforce the union, but coerce unknown strings to 'offline'
    // to prevent UI crashes ("Happy Path" resilience).
    status: z.preprocess(
        (val) => {
            if (val === 'online' || val === 'idle' || val === 'offline') return val;
            return 'offline';
        },
        z.union([
            z.literal('online'),
            z.literal('idle'),
            z.literal('offline'),
        ])
    ),
    last_seen: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
});

const OperationSchema = z.object({
    key: z.string().min(1),
    value: z.unknown(),
    timestamp: z.number(),
});

const InitMessageSchema = z.object({
    type: z.literal('init'),
    data: z.record(z.unknown()),
});

const OperationMessageSchema = z.object({
    type: z.literal('op'),
    payload: OperationSchema,
});

const PresenceMessageSchema = z.object({
    type: z.literal('presence'),
    users: z.array(PresenceUserSchema),
});

// Discriminated union for performance and type safety
export const MessageSchema = z.discriminatedUnion('type', [
    InitMessageSchema,
    OperationMessageSchema,
    PresenceMessageSchema,
]);

/**
 * Parses and validates a raw message string from the server.
 * 
 * @param raw - Raw JSON string from WebSocket
 * @returns Validated nMeshedMessage
 * @throws {MessageError} If message is invalid
 */
export function parseMessage(raw: string): NMeshedMessage {
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch (error) {
        throw new MessageError(
            `Failed to parse message as JSON: ${error instanceof Error ? error.message : 'Unknown error'}`,
            raw
        );
    }

    const result = MessageSchema.safeParse(json);

    if (!result.success) {
        const errorMessages = result.error.issues
            .map(e => `${e.path.join('.')}: ${e.message}`)
            .join(', ');

        throw new MessageError(
            `Validation failed: ${errorMessages}`,
            raw
        );
    }

    return result.data as NMeshedMessage;
}

/**
 * Safely truncates a string for logging/error messages.
 */
export function truncate(str: string, maxLength: number = 200): string {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + `... (${str.length - maxLength} more chars)`;
}
