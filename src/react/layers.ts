/**
 * @file layers.ts
 * @brief Centralized UI layer (z-index) management for nMeshed React components.
 *
 * Prevents Z-index collisions by providing explicit, ordered layer constants.
 * All components that render fixed/absolute overlays should use these values
 * instead of hardcoded z-index numbers.
 *
 * Layer ordering (lowest to highest):
 * 1. CURSOR_OVERLAY - Remote peer cursors (below HUD to not block controls)
 * 2. DEBUG_HUD - Diagnostic overlay (above cursors, below modals)
 * 3. MODAL - Modal dialogs (above everything except toasts)
 * 4. TOAST - Toast notifications (highest, always visible)
 */

/**
 * Centralized z-index values for UI layers.
 *
 * @example
 * ```tsx
 * import { UI_LAYERS } from './layers';
 *
 * <div style={{ zIndex: UI_LAYERS.CURSOR_OVERLAY }}>
 *   {cursors}
 * </div>
 * ```
 */
export const UI_LAYERS = {
    /** Remote peer cursors overlay */
    CURSOR_OVERLAY: 9998,
    /** Developer diagnostic HUD */
    DEBUG_HUD: 9999,
    /** Modal dialogs */
    MODAL: 10000,
    /** Toast notifications */
    TOAST: 10001,
} as const;

/**
 * Type for UI layer keys.
 */
export type UILayerKey = keyof typeof UI_LAYERS;
