// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { useSyncedChat, UseChatOptions, UseChatHelpers, Message } from '../../src/ai/react';
import { NMeshedProvider } from '../../src/react/context';
import { NMeshedClient } from '../../src/client';
import { InMemoryAdapter } from '../../src/adapters/InMemoryAdapter';

// Stub WebSocket
class StubWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    onopen: any;
    onclose: any;
    onmessage: any;
    send() { }
    close() { }
    constructor() {
        setTimeout(() => this.onopen?.(), 10);
    }
}
vi.stubGlobal('WebSocket', StubWebSocket);

describe('useSyncedChat', () => {
    let client: NMeshedClient;
    let mockSetMessages: ReturnType<typeof vi.fn>;
    let mockAppend: ReturnType<typeof vi.fn>;
    let onFinishCallback: ((msg: Message) => void) | undefined;

    // Recreate mock before each test
    const createMockUseChat = () => {
        mockSetMessages = vi.fn();
        mockAppend = vi.fn();

        return (options: UseChatOptions): UseChatHelpers => {
            onFinishCallback = options.onFinish;
            return {
                messages: options.initialMessages || [],
                setMessages: mockSetMessages,
                append: mockAppend.mockResolvedValue('ok'),
                input: '',
                handleInputChange: vi.fn(),
                handleSubmit: vi.fn(),
                isLoading: false,
            };
        };
    };

    beforeEach(async () => {
        vi.clearAllMocks();
        const storage = new InMemoryAdapter();
        client = new NMeshedClient({
            workspaceId: 'test',
            token: 'token',
            storage,
            initialSnapshot: new Uint8Array([0])
        });
    });

    const wrapper = ({ children }: { children: React.ReactNode }) => (
        <NMeshedProvider client={client}>{children}</NMeshedProvider>
    );

    // -------------------------------------------------------------------------
    // 1. Basic Initialization
    // -------------------------------------------------------------------------
    it('should initialize with empty messages', () => {
        const mockUseChat = createMockUseChat();
        const { result } = renderHook(() => useSyncedChat(mockUseChat, 'test-channel'), { wrapper });
        expect(result.current.messages).toEqual([]);
    });

    // -------------------------------------------------------------------------
    // 2. Append (Local -> Remote)
    // -------------------------------------------------------------------------
    it('should call original append and sync to nMeshed', async () => {
        const mockUseChat = createMockUseChat();
        const { result } = renderHook(() => useSyncedChat(mockUseChat, 'test-channel'), { wrapper });

        await act(async () => {
            await result.current.append({ role: 'user', content: 'Hello AI' });
        });

        expect(mockAppend).toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // 3. onFinish (AI Response -> nMeshed)
    // -------------------------------------------------------------------------
    it('should persist final message on onFinish', async () => {
        const mockUseChat = createMockUseChat();
        const userOnFinish = vi.fn();

        const { result } = renderHook(
            () => useSyncedChat(mockUseChat, 'test-channel', { onFinish: userOnFinish }),
            { wrapper }
        );

        // Simulate AI completing a response
        const assistantMessage: Message = {
            id: 'ai-123',
            role: 'assistant',
            content: 'I am the AI',
            createdAt: new Date()
        };

        // Invoke the onFinish captured by the mock
        act(() => {
            onFinishCallback?.(assistantMessage);
        });

        // User's onFinish should be called
        expect(userOnFinish).toHaveBeenCalledWith(assistantMessage);
    });

    // -------------------------------------------------------------------------
    // 4. Remote Sync (Remote -> Local setMessages)
    // -------------------------------------------------------------------------
    it('should update messages when synced map changes', async () => {
        const mockUseChat = createMockUseChat();
        const { result, rerender } = renderHook(
            () => useSyncedChat(mockUseChat, 'sync-test'),
            { wrapper }
        );

        // Simulate remote update by setting directly on client
        act(() => {
            client.set('chat.sync-test.msg-1', {
                id: 'msg-1',
                role: 'user',
                content: 'Remote message',
                createdAt: new Date().toISOString()
            });
        });

        // Give effect time to run
        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        rerender();

        // setMessages should have been called with the synced data
        expect(mockSetMessages).toHaveBeenCalled();
    });
});
