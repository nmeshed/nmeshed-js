import { useState, useEffect, useCallback, useRef } from 'react';
import { useNmeshedContext, useCursor } from './index';

export interface CursorState {
    x: number;
    y: number;
    targetX: number;
    targetY: number;
    lastUpdate: number;
    color: string;
}

const START_COLORS = ['#f87171', '#fb923c', '#fbbf24', '#a3e635', '#34d399', '#22d3ee', '#818cf8', '#e879f9'];

function getColor(id: string) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
    return START_COLORS[Math.abs(hash) % START_COLORS.length];
}

/**
 * Standard SVG Cursor
 */
function CursorIcon({ color }: { color: string }) {
    return (
        <svg
            className="w-5 h-5 drop-shadow-sm"
            viewBox="0 0 24 24"
            fill={color}
            xmlns="http://www.w3.org/2000/svg"
        >
            <path d="M5.65376 12.3673H5.46026L5.31717 12.4976L0.500002 16.8829L0.500002 1.19138L11.7841 12.3673H5.65376Z" />
        </svg>
    );
}

/**
 * A drop-in component that renders live multiplayer cursors.
 * Optimized for 60fps+ by bypassing React render cycle for movement.
 * Uses requestAnimationFrame and direct DOM manipulation.
 */
export function LiveCursors() {
    const client = useNmeshedContext();
    const { cursors, sendCursor } = useCursor(client as any);

    // 1. Mutable State (No Re-renders for movement)
    const cursorState = useRef<Record<string, CursorState>>({});
    const domRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const requestRef = useRef<number>(0);

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

    // 4. Game Loop (Animation Frame)
    const animateRef = useRef<() => void>();

    const animate = useCallback(() => {
        const LERP_FACTOR = 0.2; // Smoothness tuning

        for (const id of activeIds) {
            const cursor = cursorState.current[id];
            const el = domRefs.current[id];

            if (cursor && el) {
                // LERP: Current + (Target - Current) * Factor
                const dx = cursor.targetX - cursor.x;
                const dy = cursor.targetY - cursor.y;

                // Snap if close to stop micro-jitter
                if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) {
                    cursor.x = cursor.targetX;
                    cursor.y = cursor.targetY;
                } else {
                    cursor.x += dx * LERP_FACTOR;
                    cursor.y += dy * LERP_FACTOR;
                }

                // Direct DOM update (Zero React Overhead)
                el.style.transform = `translate3d(${cursor.x}px, ${cursor.y}px, 0)`;
            }
        }

        if (animateRef.current) {
            requestRef.current = requestAnimationFrame(animateRef.current);
        }
    }, [activeIds]);

    // Keep animate callback up to date
    useEffect(() => {
        animateRef.current = animate;
    }, [animate]);

    // Start/Stop Loop
    useEffect(() => {
        if (animateRef.current) {
            requestRef.current = requestAnimationFrame(animateRef.current);
        }
        return () => cancelAnimationFrame(requestRef.current);
    }, []);

    // 5. Broadcast My Position (Throttled via CursorManager internally)
    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            sendCursor(e.clientX, e.clientY);
        };

        window.addEventListener('mousemove', handleMouseMove);
        return () => window.removeEventListener('mousemove', handleMouseMove);
    }, [sendCursor]);

    return (
        <div className="pointer-events-none fixed inset-0 overflow-hidden z-[9999]">
            {activeIds.map(id => {
                // eslint-disable-next-line react-hooks/rules-of-hooks
                const state = cursorState.current[id];
                if (!state) return null;

                return (
                    <div
                        key={id}
                        ref={el => { domRefs.current[id] = el; }}
                        className="absolute will-change-transform"
                        style={{
                            // Start position, implementation handles the rest
                            transform: `translate3d(${state.x}px, ${state.y}px, 0)`
                        }}
                    >
                        <CursorIcon color={state.color} />
                        <div
                            className="ml-2 px-2 py-1 rounded-full text-xs font-semibold text-white shadow-md"
                            style={{ backgroundColor: state.color }}
                        >
                            {id}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
