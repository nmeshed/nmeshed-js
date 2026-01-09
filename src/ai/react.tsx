/**
 * @module AI_Chat
 * @description
 * React Hooks for building Collaborative AI interfaces.
 * Integrates seamlessly with the **Vercel AI SDK**.
 */

import { useRef, useEffect } from 'react';
import { useSyncedMap } from '../react/collections';

// Compatible definition with Vercel AI SDK 'Message'
export interface Message {
    id: string;
    role?: string;
    content?: any;
    createdAt?: Date | string | number;
    name?: string;
    [key: string]: any;
}

export type CreateMessage =
    | { role: 'user'; content: string;[key: string]: any }
    | { role: 'assistant'; content: string;[key: string]: any }
    | { role: 'system'; content: string;[key: string]: any }
    | { role: 'function'; content: string; name: string;[key: string]: any }
    | { role: 'data'; content: any;[key: string]: any }
    | { role: 'tool'; content: any;[key: string]: any };

export interface UseChatHelpers<TMessage extends Message = Message> {
    messages: TMessage[];
    setMessages: (messages: TMessage[]) => void;
    append: (message: Message | CreateMessage) => Promise<string | null | undefined>;
    input: string;
    handleInputChange: (e: any) => void;
    handleSubmit: (e?: { preventDefault?: () => void }, chatRequestOptions?: any) => void;
    isLoading: boolean;
    [key: string]: any;
}

/**
 * **Collaborative Chat Hook**
 * 
 * A wrapper around the Vercel AI SDK's `useChat` that upgrades it to be real-time and multi-user.
 * 
 * @remarks
 * - **Source of Truth**: The nMeshed store becomes the master history.
 * - **Interception**: We trap `append` calls to persist user messages immediately.
 * - **Streaming**: We allow the local AI SDK to handle streaming UI, then persist the final result.
 * 
 * @param useChatHook - The actual `useChat` function imported from 'ai/react'.
 * @param channel - The unique ID for this chat session (e.g. "chat_room_1").
 * @param options - Standard Vercel AI SDK options.
 * 
 * @example
 * ```tsx
 * import { useChat } from 'ai/react';
 * import { useSyncedChat } from 'nmeshed/ai/react';
 * 
 * const { messages, input, handleInputChange, handleSubmit } = useSyncedChat(
 *   useChat,
 *   'room-123',
 *   { api: '/api/chat' }
 * );
 * ```
 */
export function useSyncedChat<
    TMessage extends Message = Message,
    TOptions extends Record<string, any> = Record<string, any>,
    THelpers extends UseChatHelpers<TMessage> = UseChatHelpers<TMessage>
>(
    useChatHook: (options?: TOptions) => THelpers,
    channel: string,
    options: TOptions = {} as TOptions
) {
    // 1. Semantic Storage: "chat:{channel}"
    const [syncedMap, setItem] = useSyncedMap<TMessage>(`chat.${channel}`);

    // Ref to track if we are the "generator" of the current stream
    const isGeneratingRef = useRef(false);

    // 2. Initialize useChat
    // We cast to THelpers to ensure the hook returns what we expect, 
    // but the input options are preserved.
    const chatHelpers = useChatHook({
        ...options,
        initialMessages: options.initialMessages || [],
        onFinish: (result: any) => {
            isGeneratingRef.current = false;
            // Support Vercel AI SDK signature ({ message: ... }) and direct message
            const message = result.message || result;

            if (message && message.id) {
                // When stream finishes, we persist the final assistant message
                const finalMsg = {
                    ...message,
                    createdAt: message.createdAt || new Date()
                };
                setItem(message.id, finalMsg as TMessage);
            }
            options.onFinish?.(result);
        },
    } as TOptions);

    // 3. Sync: Incoming Changes (Remote -> Local)
    useEffect(() => {
        if (isGeneratingRef.current) return;

        // Convert synced map to array and sort
        const sortedSynced = Object.values(syncedMap).sort(
            (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
        );

        // Simple length check + id check optimization could go here, 
        // but for now relying on React reconciliation or deep compare if needed.
        // We only set if lengths differ or last ID differs to avoid loops.
        // For "Zen", simple is better:
        if (JSON.stringify(sortedSynced) !== JSON.stringify(chatHelpers.messages)) {
            chatHelpers.setMessages(sortedSynced);
        }

    }, [syncedMap, chatHelpers]);

    // 4. Intercept Appends (Local -> Remote)
    const originalAppend = chatHelpers.append;

    // We strictly type the interceptor to match Vercel's `append`
    const syncedAppend = async (message: Message | CreateMessage | string) => {
        isGeneratingRef.current = true;

        // If string, Vercel treats as user message. We normalize.
        let content = '';
        let role = 'user';
        let id = crypto.randomUUID();

        if (typeof message === 'string') {
            content = message;
        } else {
            content = message.content || '';
            role = message.role || 'user';
            if ('id' in message && message.id) {
                id = message.id;
            }
        }

        const userMsg: any = {
            id,
            role,
            content,
            createdAt: new Date()
        };

        // Optimistically save user message to nMeshed
        // We only persist if it's a standard message type we track
        if (role === 'user') {
            setItem(id, userMsg as TMessage);
        }

        // Trigger AI generation
        // Note: originalAppend expects message | CreateMessage. 
        // We pass it through untouched or normalized.
        return originalAppend(message as any);
    };

    return {
        ...chatHelpers,
        append: syncedAppend,
        // We override messages with the synced version (though they are synced via setMessages above)
        // Returning local specific chatHelpers.messages allows the streaming UI to work (which is local state).
        messages: chatHelpers.messages
    };
}
