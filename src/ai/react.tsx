import { useRef, useEffect } from 'react';
import { useSyncedMap } from '../react/collections';
// We assume peer dependency on 'ai/react'. 
// Since we don't want to force install it to build the SDK, we use partial types or generics.
// But for "Zen", we want strict typing if possible.
// We will define specific interfaces matching Vercel AI SDK to avoid hard dependency.

export interface Message {
    id: string;
    role: 'system' | 'user' | 'assistant' | 'function' | 'data' | 'tool';
    content: string;
    createdAt?: Date;
    [key: string]: any;
}

export interface UseChatOptions {
    api?: string;
    id?: string;
    initialMessages?: Message[];
    onFinish?: (message: Message) => void;
    // ... potentially other Vercel options
    [key: string]: any;
}

// Minimal shape of what useChat returns that we care about intercepting
export interface UseChatHelpers {
    messages: Message[];
    setMessages: (messages: Message[]) => void;
    append: (message: Message | { role: 'user'; content: string }) => Promise<string | null | undefined>;
    input: string;
    handleInputChange: (e: any) => void;
    handleSubmit: (e: any) => void;
    isLoading: boolean;
    // ...
}

/**
 * useSyncedChat
 * 
 * A wrapper around Vercel AI SDK's `useChat` (or a distinctive implementation) 
 * that treats the nMeshed store as the source of truth for message history.
 * 
 * @param useChatHook - The actual `useChat` function from 'ai/react' (dependency injection to avoid peer dep issues).
 * @param channel - The nMeshed collection/path to sync messages on.
 * @param options - Standard useChat options + nMeshed config.
 */
export function useSyncedChat(
    useChatHook: (options: UseChatOptions) => UseChatHelpers,
    channel: string,
    options: UseChatOptions = {}
) {
    // 1. Semantic Storage: "chat:{channel}" (handled by useSyncedMap prefix)
    // We synchronize the messages collection.
    const [syncedMap, setItem] = useSyncedMap<Message>(`chat:${channel}`);

    // Ref to track if we are the "generator" of the current stream
    const isGeneratingRef = useRef(false);

    // 2. Initialize useChat
    const chatHelpers = useChatHook({
        ...options,
        initialMessages: options.initialMessages || [], // we'll sync updates manually
        onFinish: (message) => {
            isGeneratingRef.current = false;
            // When stream finishes, we persist the final assistant message
            const finalMsg = {
                ...message,
                createdAt: message.createdAt || new Date()
            };
            setItem(message.id, finalMsg);
            options.onFinish?.(message);
        },
    });

    // 3. Sync: Incoming Changes (Remote -> Local)
    useEffect(() => {
        // useSyncedMap returns a Record<string, T>

        if (isGeneratingRef.current) {
            // Optimistic Locking: Ignore updates while generating to prevent stutter
            return;
        }

        // Convert synced map to array and sort
        const sortedSynced = Object.values(syncedMap).sort(
            (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
        );

        // Check if different to avoid render loops (deep equal or length check?)
        if (JSON.stringify(sortedSynced) !== JSON.stringify(chatHelpers.messages)) {
            chatHelpers.setMessages(sortedSynced);
        }

    }, [syncedMap, chatHelpers.setMessages]);

    // 4. Intercept Appends (Local -> Remote)
    const originalAppend = chatHelpers.append;
    const syncedAppend = async (message: Message | { role: 'user'; content: string }) => {
        isGeneratingRef.current = true;

        // user message
        const id = (message as any).id || crypto.randomUUID();
        const userMsg: Message = {
            id,
            role: 'user',
            content: (message as any).content,
            createdAt: new Date()
        };

        // Optimistically save user message to nMeshed
        setItem(id, userMsg);

        // Trigger AI generation
        return originalAppend(message);
    };

    return {
        ...chatHelpers,
        append: syncedAppend,
        messages: chatHelpers.messages // return local state which includes streaming
    };
}
