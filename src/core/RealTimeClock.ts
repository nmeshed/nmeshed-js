import { EventEmitter } from '../utils/EventEmitter';

export interface RTCUpdate {
    tick: number;
    timestamp: number;
    peerId: string;
}

export interface RTCEvents {
    tick: [number];
    sync: [RTCUpdate];
    [key: string]: any[];
}

/**
 * RealTimeClock (RTC): The Monotonic Pulse of the Mesh.
 * 
 * Embodies the Zen of "Unified Time". Instead of every system maintaining 
 * its own jittery clock, the RTC provides a single, high-precision, 
 * latency-compensated tick stream.
 * 
 * It uses a linear interpolation strategy to "catch up" to authoritative
 * ticks from the network without jarring jumps, maintaining the flow.
 */
export class RealTimeClock extends EventEmitter<RTCEvents> {
    private currentTick: number = 0;
    private targetTick: number = 0;
    private lastUpdateTime: number = performance.now();
    private msPerTick: number;
    private timer: any;

    private localPeerId: string;

    constructor(peerId: string, tickRate: number = 60, _debug: boolean = false) {
        super();
        this.localPeerId = peerId;
        this.msPerTick = 1000 / tickRate;
    }

    /**
     * Start the clock loop.
     */
    public start() {
        if (this.timer) return;
        this.lastUpdateTime = performance.now();
        this.update();
    }

    /**
     * Stop the clock loop.
     */
    public stop() {
        if (this.timer) {
            if (typeof cancelAnimationFrame !== 'undefined') {
                cancelAnimationFrame(this.timer);
            }
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private update() {
        const now = performance.now();
        const deltaMs = now - this.lastUpdateTime;

        if (deltaMs >= this.msPerTick) {
            const ticksToAdvance = Math.floor(deltaMs / this.msPerTick);

            for (let i = 0; i < ticksToAdvance; i++) {
                this.currentTick++;
                if (this.targetTick - this.currentTick > 120) {
                    this.currentTick = this.targetTick;
                }
                this.emit('tick', this.currentTick);
            }

            this.lastUpdateTime = now - (deltaMs % this.msPerTick);
        }

        const raf = (typeof requestAnimationFrame !== 'undefined')
            ? requestAnimationFrame
            : (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16);

        this.timer = raf(() => this.update());
    }

    /**
     * Apply a synchronization update from the network.
     */
    public applySync(update: RTCUpdate) {
        if (update.peerId === this.localPeerId) return;

        // Ensure we're working with regular numbers (Flatbuffers may send BigInt for int64)
        const remoteTick = Number(update.tick);
        const remoteTimestamp = Number(update.timestamp);
        const now = performance.now() + performance.timeOrigin;

        // Calculate estimated latency
        const latencyMs = Math.max(0, now - remoteTimestamp);
        const latencyTicks = Math.floor(latencyMs / this.msPerTick);

        // Authoritative target is remote_tick + estimated flight time
        const newTarget = remoteTick + latencyTicks;

        if (newTarget > this.targetTick) {
            this.targetTick = newTarget;
            this.emit('sync', update);
        }
    }

    public getTick(): number {
        return this.currentTick;
    }

    public setTick(tick: number) {
        this.currentTick = tick;
        this.targetTick = tick;
    }
}
