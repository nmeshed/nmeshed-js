/**
 * @file MessageRouter.ts
 * @brief The Single Parsing Gateway for all incoming messages.
 *
 * This class embodies the Zen principle of "One Gate" - every message
 * enters through here, is parsed once, and emerges as a typed discriminated union.
 *
 * The Transport layer becomes a "dumb pipe" - it moves bytes.
 * The MessageRouter gives those bytes meaning.
 */

import * as flatbuffers from 'flatbuffers';
import { WirePacket } from '../schema/nmeshed/wire-packet';
import { MsgType } from '../schema/nmeshed/msg-type';
import { SyncPacket } from '../schema/nmeshed/sync-packet';

// ============================================================================
// THE SINGLE TRUTH: Discriminated Union of All Message Types
// ============================================================================

/**
 * A parsed operation from a remote peer.
 */
export interface OpMessage {
    type: 'op';
    key: string;
    value: Uint8Array | null;
    timestamp?: bigint;
}

/**
 * A synchronization snapshot or state vector.
 */
export interface SyncMessage {
    type: 'sync';
    snapshot?: Uint8Array;
    stateVector?: Map<string, bigint>;
    ackSeq?: bigint;
}

/**
 * An initial state snapshot (JSON-based legacy format).
 */
export interface InitMessage {
    type: 'init';
    data: Record<string, unknown>;
}

/**
 * Ephemeral signaling data (cursors, presence, custom).
 */
export interface SignalMessage {
    type: 'signal';
    payload: unknown;
    from?: string;
}

/**
 * The unified message type - all incoming data is one of these.
 * This is the ONLY type that SyncEngine.receive() accepts.
 */
export type IncomingMessage = OpMessage | SyncMessage | InitMessage | SignalMessage;

// ============================================================================
// THE SINGLE GATE: MessageRouter Implementation
// ============================================================================

/**
 * MessageRouter: The Single Parsing Gateway.
 *
 * Responsibilities:
 * 1. Parse WirePacket binary data into typed messages
 * 2. Handle malformed data gracefully
 * 3. Provide clear error information for debugging
 *
 * Non-Responsibilities:
 * - State management (that's SyncEngine)
 * - Event emission (that's the caller)
 * - Schema decoding (that's SyncEngine with registry)
 */
export class MessageRouter {
    private debug: boolean;

    constructor(debug: boolean = false) {
        this.debug = debug;
    }

    /**
     * Parse raw bytes into a typed message.
     * Returns null if the message cannot be parsed (malformed or unknown type).
     */
    parse(bytes: Uint8Array): IncomingMessage | null {
        if (!bytes || bytes.length === 0) {
            return null;
        }

        try {
            const buf = new flatbuffers.ByteBuffer(bytes);
            const wire = WirePacket.getRootAsWirePacket(buf);
            const msgType = wire.msgType();

            switch (msgType) {
                case MsgType.Op:
                    return this.parseOp(wire);

                case MsgType.Sync:
                    return this.parseSync(wire);

                case MsgType.Signal:
                    return this.parseSignal(wire);

                default:
                    if (this.debug) {
                        console.warn(`[MessageRouter] Unknown MsgType: ${msgType}`);
                    }
                    return null;
            }
        } catch (e) {
            if (this.debug) {
                console.warn('[MessageRouter] Failed to parse WirePacket:', e);
            }
            return null;
        }
    }

    /**
     * Parse an Op (operation) message.
     */
    private parseOp(wire: WirePacket): OpMessage | null {
        const op = wire.op();
        if (!op) return null;

        const key = op.key();
        if (!key) return null;

        const valueArray = op.valueArray();
        const timestamp = op.timestamp();

        return {
            type: 'op',
            key,
            value: valueArray ? new Uint8Array(valueArray) : null,
            timestamp: timestamp !== 0n ? timestamp : undefined,
        };
    }

    /**
     * Parse a Sync (synchronization) message.
     */
    private parseSync(wire: WirePacket): SyncMessage | null {
        const sync = wire.sync();

        if (sync) {
            return this.extractSyncData(sync);
        }

        // Fallback: some packets put sync data in payload
        const payload = wire.payloadArray();
        if (payload) {
            try {
                const syncBuf = new flatbuffers.ByteBuffer(payload);
                const syncPacket = SyncPacket.getRootAsSyncPacket(syncBuf);
                return this.extractSyncData(syncPacket);
            } catch {
                // Payload isn't a SyncPacket - might be an ephemeral in sync wrapper
                return {
                    type: 'sync',
                    snapshot: new Uint8Array(payload),
                };
            }
        }

        return null;
    }

    /**
     * Extract sync data from a SyncPacket.
     */
    private extractSyncData(sync: SyncPacket): SyncMessage {
        const result: SyncMessage = { type: 'sync' };

        // Extract snapshot
        const snapshot = sync.snapshotArray();
        if (snapshot && snapshot.length > 0) {
            result.snapshot = new Uint8Array(snapshot);
        }

        // Extract state vector
        const svCount = sync.stateVectorLength();
        if (svCount > 0) {
            result.stateVector = new Map();
            for (let i = 0; i < svCount; i++) {
                const entry = sync.stateVector(i);
                if (entry && entry.peerId()) {
                    result.stateVector.set(entry.peerId()!, entry.seq());
                }
            }
        }

        // Extract ack sequence
        const ackSeq = sync.ackSeq();
        if (ackSeq && ackSeq > 0n) {
            result.ackSeq = ackSeq;
        }

        return result;
    }

    /**
     * Parse a Signal (ephemeral) message.
     */
    private parseSignal(wire: WirePacket): SignalMessage | null {
        const payload = wire.payloadArray();
        if (!payload) return null;

        // Return raw bytes - decoding is SyncEngine's job
        return {
            type: 'signal',
            payload: new Uint8Array(payload),
        };
    }

    /**
     * Create an OpMessage from pre-parsed components.
     * Utility for callers who already have the pieces.
     */
    static createOp(key: string, value: Uint8Array | null, timestamp?: bigint): OpMessage {
        return { type: 'op', key, value, timestamp };
    }

    /**
     * Create an InitMessage from a JSON snapshot.
     */
    static createInit(data: Record<string, unknown>): InitMessage {
        return { type: 'init', data };
    }

    /**
     * Create a SignalMessage from payload.
     */
    static createSignal(payload: unknown, from?: string): SignalMessage {
        return { type: 'signal', payload, from };
    }
}
