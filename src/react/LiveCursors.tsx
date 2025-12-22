import { useState, useEffect, useCallback, useRef } from 'react';
import { useBroadcast } from './useBroadcast';
import { packCursor, unpackCursor, isBinaryCursor } from '../sync/binary';
// Note: usePresence is not needed for cursor tracking, only raw broadcast

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
export function LiveCursors({ selfId }: { selfId?: string }) {
    // 1. Mutable State (No Re-renders for movement)
    const cursorState = useRef<Record<string, CursorState>>({});
    const domRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const requestRef = useRef<number>(0);

    // 2. React State (Only for mounting/unmounting DOM elements)
    const [activeIds, setActiveIds] = useState<string[]>([]);

    // 3. Game Loop (Animation Frame)
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
                // Using translate3d forces GPU acceleration layer
                el.style.transform = `translate3d(${cursor.x}px, ${cursor.y}px, 0)`;
            }
        }

        if (animateRef.current) {
            requestRef.current = requestAnimationFrame(animateRef.current);
        }
    }, [activeIds]);

    // Keep ref updated
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

    // 4. Handle Incoming Broadcasts
    const handleBroadcast = useCallback((payload: unknown) => {
        let x: number, y: number, userId: string;

        // A. Binary Path (Fast)
        if (isBinaryCursor(payload)) {
            const decoded = unpackCursor(payload as ArrayBuffer);
            if (!decoded) return;
            x = decoded.x;
            y = decoded.y;
            userId = decoded.userId;
        }
        // B. JSON Path (Legacy/Fallback)
        else {
            const data = payload as any;
            if (data.type !== 'cursor') return;
            x = data.x;
            y = data.y;
            userId = data.userId;
        }

        if (userId === selfId) return;

        const now = Date.now();
        if (!cursorState.current[userId]) {
            // New cursor: Mount
            cursorState.current[userId] = {
                x, y, targetX: x, targetY: y,
                lastUpdate: now,
                color: getColor(userId),
            };
            setActiveIds(prev => [...prev, userId]);
        } else {
            // Update
            const c = cursorState.current[userId];
            c.targetX = x;
            c.targetY = y;
            c.lastUpdate = now;
        }
    }, [selfId]);

    const broadcast = useBroadcast(handleBroadcast);

    // 5. Cleanup Stale Cursors
    useEffect(() => {
        const interval = setInterval(() => {
            const now = Date.now();
            let changed = false;

            Object.entries(cursorState.current).forEach(([id, c]) => {
                if (now - c.lastUpdate > 5000) { // 5s timeout
                    delete cursorState.current[id];
                    delete domRefs.current[id];
                    changed = true;
                }
            });

            if (changed) {
                setActiveIds(Object.keys(cursorState.current));
            }
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    // 6. Broadcast My Position (Throttled + Binary)
    useEffect(() => {
        let lastSent = 0;
        const THROTTLE_MS = 30;

        const handleMouseMove = (e: MouseEvent) => {
            const now = Date.now();
            if (now - lastSent < THROTTLE_MS) return;

            lastSent = now;

            // Binary Pack!
            // Note: clientX/Y are relative to viewport.
            // In a real app we might want pageX/Y or normalized 0..1 coords.
            // But this matches the JSON behavior for now.
            if (selfId) {
                const buffer = packCursor(selfId, e.clientX, e.clientY);
                broadcast(buffer);
            }
        };

        window.addEventListener('mousemove', handleMouseMove);
        return () => window.removeEventListener('mousemove', handleMouseMove);
    }, [broadcast, selfId]);

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
