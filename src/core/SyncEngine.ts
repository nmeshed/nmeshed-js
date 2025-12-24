import { NMeshedClientCore } from '../wasm/nmeshed_core';
import { EventEmitter } from '../utils/EventEmitter';
import { encodeValue, decodeValue } from '../codec';
import { saveQueue, loadQueue } from '../persistence';

export interface SyncEngineEvents {
    op: [string, any];
    queueChange: [number];
    [key: string]: any;
}

/**
 * The Brain of nMeshed.
 * Encapsulates WASM core, CRDT logic, operation queuing, and persistence.
 */
export class SyncEngine extends EventEmitter<SyncEngineEvents> {
    private core: NMeshedClientCore | null = null;
    private workspaceId: string;
    private mode: 'crdt' | 'lww';
    private dbName: string;
    private isDestroyed = false;

    // Manual State/Queue management
    private preConnectState: Record<string, any> = {};
    private operationQueue: Uint8Array[] = [];
    private maxQueueSize: number;

    constructor(workspaceId: string, mode: string = 'crdt', maxQueueSize: number = 1000) {
        super();
        this.workspaceId = workspaceId;
        this.mode = mode as any;
        this.maxQueueSize = maxQueueSize;
        this.dbName = `nmeshed_q_${workspaceId}`;
    }

    public async boot(): Promise<void> {
        if (this.core) return;
        this.core = new NMeshedClientCore(this.workspaceId, this.mode);

        // Apply pre-connect state to core and queue for transmission
        for (const [key, value] of Object.entries(this.preConnectState)) {
            const valBytes = encodeValue(value);
            const res = this.core.apply_local_op(key, valBytes, BigInt(Date.now() * 1000)) as any;
            if (res) {
                const delta = res instanceof Uint8Array ? res : (res instanceof ArrayBuffer ? new Uint8Array(res) : new TextEncoder().encode(JSON.stringify(res)));
                this.addToQueue(delta);
            }
        }

        // Load persisted state
        await this.loadPersistedState();

        // Clear pre-connect state only after loading is done to maintain reported queue size
        this.preConnectState = {};
    }

    public set(key: string, value: any): Uint8Array {
        const valBytes = encodeValue(value);
        const timestamp = BigInt(Date.now() * 1000);

        if (this.core) {
            const res = this.core.apply_local_op(key, valBytes, timestamp) as any;
            const delta = res instanceof Uint8Array ? res : (res instanceof ArrayBuffer ? new Uint8Array(res) : new TextEncoder().encode(JSON.stringify(res)));
            this.addToQueue(delta);
            this.saveState();
            this.emit('op', key, value); // Notify listeners of local change
            return delta;
        } else {
            this.preConnectState[key] = value;
            // Enforce maxQueueSize on preConnectState
            const keys = Object.keys(this.preConnectState);
            if (keys.length > this.maxQueueSize) {
                delete this.preConnectState[keys[0]];
            }
            this.saveState();
            this.emit('op', key, value); // Notify listeners of local change
            this.emit('queueChange', Object.keys(this.preConnectState).length);
            return new Uint8Array();
        }
    }

    private addToQueue(delta: Uint8Array): void {
        this.operationQueue.push(delta);
        if (this.operationQueue.length > this.maxQueueSize) {
            this.operationQueue.shift();
        }
        this.emit('queueChange', this.operationQueue.length);
    }

    public applyRemoteDelta(delta: Uint8Array): void {
        if (!this.core) return;
        const core = this.core as any;
        const result = core.merge_remote_delta(delta) as any;
        console.error(`[SyncEngine] merge_remote_delta result: ${JSON.stringify(result)}`);

        if (!result) return;
        console.warn(`[SyncEngine] applyRemoteDelta result type:`, result.type);

        if (result.type === 'init' && result.data) {
            for (let [k, v] of Object.entries(result.data)) {
                if (v instanceof Uint8Array || v instanceof ArrayBuffer) v = decodeValue(v);
                this.emit('op', k, v);
            }
            return;
        }

        if (result.type === 'op' && result.key) {
            const isBinary = result.value instanceof Uint8Array ||
                result.value instanceof ArrayBuffer ||
                (result.value && typeof result.value === 'object' && 'byteLength' in result.value);

            const val = isBinary ? decodeValue(result.value) : result.value;
            this.emit('op', result.key, val);
            return;
        }

        if (result instanceof Uint8Array || result instanceof ArrayBuffer) {
            try {
                const text = new TextDecoder().decode(result);
                const parsed = JSON.parse(text);
                const ops = Array.isArray(parsed) ? parsed : [parsed];
                ops.forEach((op: any) => {
                    if (op && typeof op === 'object' && 'key' in op) {
                        this.emit('op', op.key, op.value);
                    }
                });
            } catch { /* Raw delta */ }
        }
    }

    public get<T = any>(key: string): T | undefined {
        if (!this.core) return this.preConnectState[key];
        const core = this.core as any;

        let state = typeof core.get_state === 'function' ? core.get_state() : core.state;

        if (state && state[key] !== undefined) {
            const val = state[key];
            const decoded = (val instanceof Uint8Array || val instanceof ArrayBuffer) ? decodeValue(val) : val;
            return decoded as T;
        }
        return this.preConnectState[key];
    }

    public getAllValues(): Record<string, any> {
        const result: Record<string, any> = { ...this.preConnectState };
        if (this.core) {
            const core = this.core as any;
            let state = typeof core.get_state === 'function' ? core.get_state() : core.state;
            if (state) {
                for (const key in state) {
                    const val = state[key];
                    result[key] = (val instanceof Uint8Array || val instanceof ArrayBuffer) ? decodeValue(val) : val;
                }
            }
        }
        return result;
    }

    public getQueueSize(): number {
        return this.operationQueue.length + Object.keys(this.preConnectState).length;
    }

    public getPendingOps(): Uint8Array[] {
        return [...this.operationQueue];
    }

    public clearQueue(): void {
        this.operationQueue = [];
        this.saveState();
        this.emit('queueChange', this.getQueueSize());
    }

    public destroy(): void {
        this.isDestroyed = true;
        this.core = null;
        this.operationQueue = [];
        this.preConnectState = {};
    }

    private async saveState(): Promise<void> {
        if (this.isDestroyed) return;
        try {
            await saveQueue(this.workspaceId, this.operationQueue);
        } catch (e) {
            if (!this.isDestroyed) {
                console.error(`[SyncEngine] Save failed for ${this.dbName}`, e);
            }
        }
    }

    private async loadPersistedState(): Promise<void> {
        try {
            const ops = await loadQueue(this.workspaceId);
            if (ops && Array.isArray(ops)) {
                ops.forEach(op => {
                    // Handle various persisted formats (binary, wrapped, or plain object)
                    let data;
                    if (op instanceof Uint8Array) {
                        data = op;
                    } else if (op.data && op.data instanceof Uint8Array) {
                        data = op.data;
                    } else {
                        // Fallback for plain objects from tests or legacy storage
                        data = new TextEncoder().encode(JSON.stringify(op));
                    }

                    if (data) this.operationQueue.push(data);
                });
                this.emit('queueChange', this.operationQueue.length);
            }
        } catch (e) {
            console.error('[SyncEngine] Load failed', e);
        }
    }
}
