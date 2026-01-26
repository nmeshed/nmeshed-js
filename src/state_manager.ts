export class SpeculativeStateManager {
    private committedState: Uint8Array; // The "Last Known Good" binary
    private speculativeState: Uint8Array; // The current "Optimistic" binary
    private pendingOps: Map<string, any>; // Track by TaskID

    constructor(initialState: Uint8Array) {
        this.committedState = new Uint8Array(initialState);
        this.speculativeState = new Uint8Array(initialState);
        this.pendingOps = new Map();
    }

    /**
     * Called when the user performs an action. 
     * Updates the UI immediately (0ms).
     */
    public applyLocalChange(taskId: string, opData: Uint8Array, wasmInstance: any) {
        // 1. Update the Speculative View
        // Assuming wasmInstance exports `apply_change(state, op)` returning new state
        this.speculativeState = wasmInstance.apply_change(this.speculativeState, opData);

        // 2. Track it for potential rollback
        this.pendingOps.set(taskId, opData);

        return this.speculativeState;
    }

    /**
     * Handles the 'VerificationFailed' event from the Rust Core.
     */
    public handleVerificationFailure(failedTaskId: string, wasmInstance: any) {
        console.warn(`nMeshed: Security Violation on Task ${failedTaskId}. Rolling back.`);

        // 1. Purge the invalid op from the pending set
        this.pendingOps.delete(failedTaskId);

        // 2. The REBASE: 
        // We reset the Speculative state to the Committed state (The Truth).
        this.speculativeState = new Uint8Array(this.committedState);

        // 3. Re-apply any OTHER pending ops that haven't failed.
        // This ensures we don't lose subsequent VALID user work.
        for (const opData of this.pendingOps.values()) {
            this.speculativeState = wasmInstance.apply_change(this.speculativeState, opData);
        }

        // 5. Audit: Push metric to the observability layer (Mocked)
        // metrics.increment("nmeshed_ui_snapback_total");

        return this.speculativeState;
    }

    /**
     * Handles 'VerificationSuccess' - Promoting speculative data to truth.
     */
    public handleVerificationSuccess(taskId: string, finalVerifiedState: Uint8Array) {
        this.pendingOps.delete(taskId);
        // Update the anchor point for future rollbacks
        this.committedState = new Uint8Array(finalVerifiedState);
    }
}
