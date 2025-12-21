/**
 * @file SignalingClient.ts
 * @brief WebSocket-based signaling client for WebRTC connection establishment.
 *
 * Handles all WebSocket communication with the signaling server, including:
 * - Connection lifecycle (connect, disconnect, reconnect)
 * - Signal message serialization/deserialization
 * - Presence notifications
 * - Automatic reconnection with exponential backoff
 */

import type { SignalEnvelope, SignalMessage } from './types';
import { logger } from '../utils/Logger';

export interface SignalingConfig {
    url: string;
    token?: string;
    workspaceId: string;
    myId: string;
}

export interface SignalingEvents {
    onSignal: (envelope: SignalEnvelope) => void;
    onPresence: (userId: string, status: string) => void;
    onConnect: () => void;
    onDisconnect: () => void;
    onError: (err: Error) => void;
}

/**
 * Manages WebSocket connection to signaling server for WebRTC coordination.
 */
export class SignalingClient {
    private ws: WebSocket | null = null;
    private config: SignalingConfig;
    private listeners: Partial<SignalingEvents> = {};

    // Reconnection state
    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private intentionallyClosed = false;
    private static readonly MAX_RECONNECT_ATTEMPTS = 10;
    private static readonly BASE_RECONNECT_DELAY_MS = 1000;
    private static readonly MAX_RECONNECT_DELAY_MS = 30000;

    constructor(config: SignalingConfig) {
        this.config = config;
    }

    public setListeners(listeners: Partial<SignalingEvents>) {
        this.listeners = listeners;
    }

    public get connected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    public connect() {
        this.intentionallyClosed = false;
        let url = this.config.url;

        if (this.config.token) {
            const separator = url.includes('?') ? '&' : '?';
            url += `${separator}token=${encodeURIComponent(this.config.token)}`;
        }

        logger.sig(`Connecting to ${this.config.url}...`);

        try {
            this.ws = new WebSocket(url);

            this.ws.onopen = this.handleOpen.bind(this);
            this.ws.onmessage = this.handleMessage.bind(this);
            this.ws.onclose = this.handleClose.bind(this);
            this.ws.onerror = this.handleError.bind(this);
        } catch (e) {
            this.listeners.onError?.(e instanceof Error ? e : new Error(String(e)));
        }
    }

    public close() {
        this.intentionallyClosed = true;
        this.clearReconnectTimer();
        this.ws?.close();
        this.ws = null;
    }

    public sendSignal(to: string, signal: SignalMessage) {
        if (!this.connected) return;

        try {
            const message = JSON.stringify({
                type: 'signal',
                to,
                from: this.config.myId,
                signal
            });
            this.ws!.send(message);
        } catch (e) {
            logger.error('Send Signal Error', e);
        }
    }

    private clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    /**
     * Calculates reconnect delay with exponential backoff and jitter.
     */
    private getReconnectDelay(): number {
        const exponentialDelay = SignalingClient.BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts);
        const jitter = Math.random() * 0.3 * exponentialDelay;
        return Math.min(exponentialDelay + jitter, SignalingClient.MAX_RECONNECT_DELAY_MS);
    }

    /**
     * Attempts to reconnect with exponential backoff.
     */
    private scheduleReconnect() {
        if (this.intentionallyClosed) return;
        if (this.reconnectAttempts >= SignalingClient.MAX_RECONNECT_ATTEMPTS) {
            logger.error(`Max reconnection attempts (${SignalingClient.MAX_RECONNECT_ATTEMPTS}) reached.`);
            return;
        }

        const delay = this.getReconnectDelay();
        this.reconnectAttempts++;
        logger.sig(`Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${SignalingClient.MAX_RECONNECT_ATTEMPTS})...`);

        this.reconnectTimer = setTimeout(() => {
            this.connect();
        }, delay);
    }

    private handleOpen() {
        logger.sig('WS Connected');
        this.reconnectAttempts = 0;

        // Auto-join the workspace
        const joinPayload: SignalMessage = { type: 'join', workspaceId: this.config.workspaceId };
        this.sendSignal('server', joinPayload);

        this.listeners.onConnect?.();
    }

    private handleMessage(e: MessageEvent) {
        try {
            if (typeof e.data === 'string') {
                this.handleJsonMessage(e.data);
            }
        } catch (fatal) {
            logger.error('Critical Message Error', fatal);
        }
    }

    private handleJsonMessage(data: string) {
        try {
            const msg = JSON.parse(data);
            switch (msg.type) {
                case 'presence':
                    const { userId, status } = msg.payload || msg;
                    this.listeners.onPresence?.(userId, status);
                    break;
                case 'signal':
                    if (msg.from && msg.signal) {
                        this.listeners.onSignal?.({ from: msg.from, signal: msg.signal });
                    }
                    break;
            }
        } catch (e) {
            logger.error('JSON Parse Error', e);
        }
    }

    private handleClose(e: CloseEvent) {
        logger.sig(`Disconnected: ${e.code} ${e.reason}`);
        this.listeners.onDisconnect?.();

        // Normal closure codes that shouldn't trigger reconnect
        const normalClosureCodes = [1000, 1001];
        if (!normalClosureCodes.includes(e.code) && !this.intentionallyClosed) {
            this.scheduleReconnect();
        }
    }

    private handleError(e: Event) {
        logger.error('WS Error', e);
        this.listeners.onError?.(new Error('WebSocket Error'));
    }
}
