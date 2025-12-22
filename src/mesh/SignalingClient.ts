
import type { SignalEnvelope, SignalMessage } from './types';
import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';
import { SignalData } from '../schema/nmeshed/signal-data';
import { Join } from '../schema/nmeshed/join';
import { Offer } from '../schema/nmeshed/offer';
import { Answer } from '../schema/nmeshed/answer';
import { Candidate } from '../schema/nmeshed/candidate';
import { ProtocolUtils } from './ProtocolUtils';
import { logger } from '../utils/Logger';

export interface SignalingConfig {
    url: string;
    token?: string;
    tokenProvider?: () => Promise<string>;
    workspaceId: string;
    myId: string;
}

export interface SignalingEvents {
    onSignal: (envelope: SignalEnvelope) => void;
    onPresence: (userId: string, status: string, meshId?: string) => void;
    onConnect: () => void;
    onDisconnect: () => void;
    onError: (err: Error) => void;
    onServerMessage: (data: Uint8Array) => void;
    onInit: (data: any) => void;
    onEphemeral: (payload: any) => void;
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

    public updateToken(token: string) {
        this.config.token = token;
    }

    public async connect() {
        this.intentionallyClosed = false;

        if (this.config.tokenProvider) {
            try {
                this.config.token = await this.config.tokenProvider();
            } catch (e) {
                logger.error('Token Provider Error', e);
            }
        }

        let url = this.config.url;

        if (this.config.token) {
            const separator = url.includes('?') ? '&' : '?';
            url += `${separator}token=${encodeURIComponent(this.config.token)}`;
        }

        logger.sig(`Connecting to ${url}...`);

        try {
            this.ws = new WebSocket(url);
            this.ws.binaryType = 'arraybuffer';

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
            const bytes = ProtocolUtils.createSignalPacket(to, this.config.myId, signal);
            this.ws!.send(bytes);
        } catch (e) {
            logger.error('Send Signal Error', e);
        }
    }

    public sendSync(data: Uint8Array) {
        if (!this.connected) return;

        try {
            const bytes = ProtocolUtils.createSyncPacket(data);
            this.ws!.send(bytes);
        } catch (e) {
            logger.error('Send Sync Error', e);
        }
    }

    public sendEphemeral(payload: any, to?: string) {
        if (!this.connected) return;
        const msg = JSON.stringify({ type: 'ephemeral', to, payload });
        this.ws!.send(msg);
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

        // Send Binary Join
        this.sendSignal('server', joinPayload);

        this.listeners.onConnect?.();
    }

    private handleMessage(e: MessageEvent) {
        try {
            if (typeof e.data === 'string') {
                this.handleJsonMessage(e.data);
            } else {
                this.handleBinaryMessage(e.data as ArrayBuffer);
            }
        } catch (fatal) {
            logger.error('Critical Message Error', fatal);
        }
    }

    private handleBinaryMessage(buffer: ArrayBuffer) {
        try {
            const arr = new Uint8Array(buffer);
            const buf = new flatbuffers.ByteBuffer(arr);
            const wire = WirePacket.getRootAsWirePacket(buf);
            const msgType = wire.msgType();

            if (msgType === MsgType.Sync) {
                const payload = wire.payloadArray();
                if (payload) {
                    this.listeners.onServerMessage?.(payload);
                }
            } else if (msgType === MsgType.Signal) {
                const sig = wire.signal();
                if (sig) {
                    const from = sig.fromPeer();
                    const dataType = sig.dataType();

                    if (from && dataType !== SignalData.NONE) {
                        let parsed: SignalMessage | null = null;
                        if (dataType === SignalData.Join) {
                            const join = sig.data(new Join());
                            if (join) parsed = { type: 'join', workspaceId: join.workspaceId()! };
                        } else if (dataType === SignalData.Offer) {
                            const offer = sig.data(new Offer());
                            if (offer) parsed = { type: 'offer', sdp: offer.sdp()! };
                        } else if (dataType === SignalData.Answer) {
                            const answer = sig.data(new Answer());
                            if (answer) parsed = { type: 'answer', sdp: answer.sdp()! };
                        } else if (dataType === SignalData.Candidate) {
                            const cand = sig.data(new Candidate());
                            if (cand) {
                                parsed = {
                                    type: 'candidate',
                                    candidate: {
                                        candidate: cand.candidate()!,
                                        sdpMid: cand.sdpMid()!,
                                        sdpMLineIndex: cand.sdpMLineIndex()
                                    }
                                };
                            }
                        }

                        if (parsed) {
                            this.listeners.onSignal?.({ from, signal: parsed });
                        }
                    }
                }
            }
        } catch (err) {
            logger.error('Binary Parser Error', err);
        }
    }

    private handleJsonMessage(data: string) {
        try {
            const msg = JSON.parse(data);
            switch (msg.type) {
                case 'presence':
                    if (msg.payload) {
                        const { userId, status, meshId } = msg.payload || msg;
                        if (userId) this.listeners.onPresence?.(userId, status, meshId);
                    } else if (msg.userId) {
                        this.listeners.onPresence?.(msg.userId, msg.status, msg.meshId);
                    }
                    break;
                case 'signal':
                    // Legacy JSON signals
                    if (msg.from && msg.signal) {
                        this.listeners.onSignal?.({ from: msg.from, signal: msg.signal });
                    }
                    break;
                case 'init':
                    this.listeners.onInit?.(msg);
                    break;
                case 'ephemeral':
                    this.listeners.onEphemeral?.(msg.payload);
                    break;
            }
        } catch (e) {
            logger.error('JSON Parse Error', e);
        }
    }

    private handleClose(e: CloseEvent) {
        logger.sig(`Disconnected: ${e.code} ${e.reason}`);
        this.listeners.onDisconnect?.();

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
