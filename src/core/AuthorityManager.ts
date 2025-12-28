import { ConsistentHashRing } from '../utils/ConsistentHashRing';
import { EventEmitter } from '../utils/EventEmitter';

export interface AuthorityEvents {
    becomeAuthority: [string]; // key
    loseAuthority: [string];   // key
    [key: string]: any[];
}

/**
 * AuthorityManager: The Arbiter of Ownership.
 * 
 * Encapsulates the ConsistentHashRing and the logic for determining which 
 * peer "owns" a specific key at any given time.
 * 
 * Embodies the Zen of "Execution through Inaction" - by automating 
 * authority decisions, we eliminate the need for manual handshakes.
 */
export class AuthorityManager extends EventEmitter<AuthorityEvents> {
    private ring: ConsistentHashRing;
    private localPeerId: string;
    private currentAuthorities = new Set<string>();
    public meshId: string | null = null;

    constructor(localPeerId: string, replicationFactor: number = 20) {
        super();
        this.localPeerId = localPeerId;
        this.ring = new ConsistentHashRing(replicationFactor);
        this.ring.addNode(localPeerId);
    }

    public get peerId(): string {
        return this.localPeerId;
    }

    public addPeer(peerId: string) {
        this.ring.addNode(peerId);
        this.recalculate();
    }

    public removePeer(peerId: string) {
        this.ring.removeNode(peerId);
        this.recalculate();
    }

    /**
     * Checks if the local peer is the authority for a given key.
     */
    public isAuthority(key: string): boolean {
        return this.ring.getNode(key) === this.localPeerId;
    }

    /**
     * Recalculate authority for all known keys.
     * This is called when the peer set changes.
     */
    private recalculate() {
        // Note: In a real system, we'd only recalculate keys we are tracking.
        // For the SDK, this is usually delegated to the SyncEngine which knows 
        // the current keyset.
        this.emit('recalculate' as any); // Signal SyncEngine to re-revaluate its keys
    }

    /**
     * Track a key and trigger events if authority changes.
     */
    public trackKey(key: string) {
        const currentlyAuth = this.isAuthority(key);
        const previouslyAuth = this.currentAuthorities.has(key);

        if (currentlyAuth && !previouslyAuth) {
            this.currentAuthorities.add(key);
            this.emit('becomeAuthority', key);
        } else if (!currentlyAuth && previouslyAuth) {
            this.currentAuthorities.delete(key);
            this.emit('loseAuthority', key);
        }
    }
}
