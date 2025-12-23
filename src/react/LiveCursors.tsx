import { useState, useEffect, useCallback, useRef } from 'react';
import { useNmeshedContext, useCursor } from './index';
import { UI_LAYERS } from './layers';

export interface CursorState {
    x: number;
    y: number;
    targetX: number;
    targetY: number;
    lastUpdate: number;
    color: string;
}

const CURSOR_COLORS = ['#f87171', '#fb923c', '#fbbf24', '#a3e635', '#34d399', '#22d3ee', '#818cf8', '#e879f9'];

/**
 * Generates a stable color for a given ID.
 */
function getColor(id: string): string {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
        hash = id.charCodeAt(i) + ((hash << 5) - hash);
    }
    return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}

/**
 * Standard SVG Cursor Icon with inline styles (no Tailwind dependency).
 */
function CursorIcon({ color }: { color: string }) {
    return (
        <svg
            style={{
                width: '20px',
                height: '20px',
                filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.1))',
            }}
            viewBox="0 0 24 24"
            fill={color}
            xmlns="http://www.w3.org/2000/svg"
        >
            <path d="M5.65376 12.3673H5.46026L5.31717 12.4976L0.500002 16.8829L0.500002 1.19138L11.7841 12.3673H5.65376Z" />
        </svg>
    );
}

/**
 * Inline styles for LiveCursors.
 * Using inline styles instead of Tailwind for SDK portability.
 */
const styles = {
    container: {
        pointerEvents: 'none' as const,
        position: 'fixed' as const,
        inset: 0,
        overflow: 'hidden',
        zIndex: UI_LAYERS.CURSOR_OVERLAY,
    },
    cursor: {
        position: 'absolute' as const,
        willChange: 'transform' as const,
        display: 'flex',
        alignItems: 'flex-start',
    },
    label: {
        marginLeft: '8px',
        padding: '4px 8px',
        borderRadius: '9999px',
        fontSize: '12px',
        fontWeight: 600,
        color: '#ffffff',
        boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
        maxWidth: '120px',
        overflow: 'hidden' as const,
        textOverflow: 'ellipsis' as const,
        whiteSpace: 'nowrap' as const,
    },
};

/**
 * A drop-in component that renders live multiplayer cursors.
 *
 * Optimized for 60fps+ by bypassing React render cycle for movement.
 * Uses requestAnimationFrame with frame-time-independent LERP and
 * direct DOM manipulation.
 *
 * ## Features
 * - Hardware-accelerated transforms via translate3d
 * - Frame-rate independent interpolation (smooth on 30Hz, 60Hz, 120Hz+)
 * - Inline styles for SDK portability (no Tailwind required)
 * - Centralized Z-index layer management
 * - Truncated labels for long user IDs
 */
export function LiveCursors() {
    const client = useNmeshedContext();
    const { cursors, sendCursor } = useCursor(client as any);

    // 1. Mutable State (No Re-renders for movement)
    const cursorState = useRef<Record<string, CursorState>>({});
    const domRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const requestRef = useRef<number>(0);
    const lastFrameTime = useRef<number>(0);

    // 2. React State (Only for mounting/unmounting DOM elements)
    const [activeIds, setActiveIds] = useState<string[]>([]);

    // 3. Sync cursors Map to internal LERP state
    useEffect(() => {
        let changed = false;
        const now = Date.now();

        // Add/Update cursors from map
        for (const [id, pos] of cursors.entries()) {
            if (!cursorState.current[id]) {
                cursorState.current[id] = {
                    x: pos.x,
                    y: pos.y,
                    targetX: pos.x,
                    targetY: pos.y,
                    lastUpdate: now,
                    color: getColor(id),
                };
                changed = true;
            } else {
                const c = cursorState.current[id];
                c.targetX = pos.x;
                c.targetY = pos.y;
                c.lastUpdate = now;
            }
        }

        // Cleanup stale ones that are no longer in the cursors map
        for (const id in cursorState.current) {
            if (!cursors.has(id)) {
                delete cursorState.current[id];
                delete domRefs.current[id];
                changed = true;
            }
        }

        if (changed) {
            setActiveIds(Object.keys(cursorState.current));
        }
    }, [cursors]);

    // 4. Animation Loop (Frame-rate independent LERP)
    const animate = useCallback(function animate(timestamp: number) {
        // Calculate delta time for frame-rate independence
        const deltaTime = timestamp - lastFrameTime.current;
        lastFrameTime.current = timestamp;

        // Normalize LERP factor to ~60fps baseline
        const baseLerpFactor = 0.2;
        const lerpFactor = Math.min(1, (deltaTime / 16.67) * baseLerpFactor);

        const currentIds = Object.keys(cursorState.current);

        for (const id of currentIds) {
            const cursor = cursorState.current[id];
            const el = domRefs.current[id];

            if (cursor && el) {
                const dx = cursor.targetX - cursor.x;
                const dy = cursor.targetY - cursor.y;

                if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
                    cursor.x = cursor.targetX;
                    cursor.y = cursor.targetY;
                } else {
                    cursor.x += dx * lerpFactor;
                    cursor.y += dy * lerpFactor;
                }

                el.style.transform = `translate3d(${cursor.x}px, ${cursor.y}px, 0)`;
            }
        }

        requestRef.current = requestAnimationFrame(animate);
    }, []);

    // Start/Stop Animation Loop
    useEffect(() => {
        lastFrameTime.current = performance.now();
        requestRef.current = requestAnimationFrame(animate);
        return () => cancelAnimationFrame(requestRef.current);
    }, [animate]);

    // 5. Broadcast My Position (Throttled via CursorManager internally)
    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            sendCursor(e.clientX, e.clientY);
        };

        window.addEventListener('mousemove', handleMouseMove);
        return () => window.removeEventListener('mousemove', handleMouseMove);
    }, [sendCursor]);

    return (
        <div style={styles.container}>
            {activeIds.map(id => {
                const state = cursorState.current[id];
                if (!state) return null;

                return (
                    <div
                        key={id}
                        ref={el => { domRefs.current[id] = el; }}
                        style={{
                            ...styles.cursor,
                            transform: `translate3d(${state.x}px, ${state.y}px, 0)`,
                        }}
                    >
                        <CursorIcon color={state.color} />
                        <div
                            style={{
                                ...styles.label,
                                backgroundColor: state.color,
                            }}
                        >
                            {id}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
