import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useNMeshed } from './context';
import type { NMeshedClient } from '../client';

export interface StateInspectorProps {
    /**
     * Optional client instance. If not provided, uses the nMeshed context.
     */
    client?: NMeshedClient;
    /**
     * Initially collapsed depth for the JSON tree.
     * Default: 2
     */
    initialDepth?: number;
    /**
     * Custom class name for the container.
     */
    className?: string;
}

interface HistorySnap {
    timestamp: number;
    state: Record<string, unknown>;
    opKey?: string;
}

/**
 * A "Medical Grade" Inspector for nMeshed State.
 * 
 * Features:
 * - Real-time JSON visualization of the entire state.
 * - Session-based Time Travel (Slider to rewind history).
 * - "Diff" highlighting (TBD - visual only for now).
 */
export const StateInspector: React.FC<StateInspectorProps> = ({
    client: propClient,
    initialDepth = 2,
    className
}) => {
    // 1. Resolve Client
    const context = useNMeshed();
    const client = propClient || context.client;

    // 2. State & History
    const [liveState, setLiveState] = useState<Record<string, unknown>>({});
    const [history, setHistory] = useState<HistorySnap[]>([]);
    const [sliderIndex, setSliderIndex] = useState<number>(-1); // -1 means "Live"
    const [isPaused, setIsPaused] = useState(false);

    // 3. Subscription (Session Recording)
    // Use ref for isPaused to avoid restarting effect (which resets history) when pausing
    const isPausedRef = useRef(false);
    useEffect(() => {
        isPausedRef.current = isPaused;
    }, [isPaused]);

    useEffect(() => {
        if (!client) return;

        // Initial State
        const initialMap = client.getAllValues();
        setLiveState(initialMap);
        setHistory([{ timestamp: Date.now(), state: initialMap, opKey: 'init' }]);
        setSliderIndex(-1); // Reset to live on mount

        // Listen for ops
        const unsub = client.on('op', (key, value, isLocal, timestamp) => {
            if (isPausedRef.current) return;

            setLiveState((prev) => {
                // Construct new state immutably for the history snapshot
                const next = { ...prev };
                if (value === null || value === undefined) {
                    delete next[key];
                } else {
                    next[key] = value;
                }

                // Record History
                setHistory(h => {
                    let ts = Date.now();
                    if (typeof timestamp === 'number') ts = timestamp;
                    else if (typeof timestamp === 'bigint') ts = Number(timestamp >> 80n); // Assuming HLC format (physical << 80)
                    // Fallback if assumption fails or simple conversion
                    if (ts === 0 || isNaN(ts)) ts = Date.now();

                    const snap: HistorySnap = {
                        timestamp: ts,
                        state: next,
                        opKey: key
                    };
                    // Limit history to last 1000 ops to prevent memory leaks in long sessions
                    const newHistory = [...h, snap];
                    if (newHistory.length > 1000) newHistory.shift();
                    return newHistory;
                });

                // If user is "Live", update the view
                // If user is "Time Traveling" (sliderIndex !== -1), strictly DON'T update the visible view
                return next;
            });
        });

        return () => {
            unsub();
        };
    }, [client]); // Remove isPaused from deps

    // 4. Derived View State
    const activeState = useMemo(() => {
        if (sliderIndex === -1) return liveState;
        return history[sliderIndex]?.state || {};
    }, [liveState, history, sliderIndex]);

    const activeTimestamp = useMemo(() => {
        if (sliderIndex === -1) return Date.now();
        return history[sliderIndex]?.timestamp || 0;
    }, [history, sliderIndex]);

    // 5. Render Helpers
    if (!client) {
        return <div className="p-4 text-red-500 font-mono">No nMeshed Client Found</div>;
    }

    const max = history.length > 0 ? history.length - 1 : 0;
    const currentVal = sliderIndex === -1 ? max + 1 : sliderIndex;

    return (
        <div className={`nmeshed-inspector flex flex-col font-mono text-xs border rounded-lg bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-800 ${className || ''}`} style={{ minHeight: '300px', maxHeight: '600px' }}>
            {/* Header / Toolbar */}
            <div className="flex items-center justify-between p-2 border-b bg-white dark:bg-gray-950 border-gray-200 dark:border-gray-800">
                <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${sliderIndex === -1 ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'}`} />
                    <span className="font-bold text-gray-700 dark:text-gray-200">
                        {sliderIndex === -1 ? 'LIVE' : 'TIME TRAVEL'}
                    </span>
                    <span className="text-gray-400">
                        {new Date(activeTimestamp).toLocaleTimeString()}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setLiveState(client.getAllValues())} // Force refresh
                        className="px-2 py-1 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 rounded text-gray-600 dark:text-gray-300"
                    >
                        Refresh
                    </button>
                    <button
                        onClick={() => {
                            setHistory([]);
                            setLiveState(client.getAllValues());
                            setSliderIndex(-1);
                            setIsPaused(false); // Resume live updates
                        }}
                        className="px-2 py-1 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 rounded text-gray-600 dark:text-gray-300"
                    >
                        Clear History
                    </button>
                </div>
            </div>

            {/* Timeline Slider */}
            <div className="p-2 bg-gray-100 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
                <div className="flex items-center gap-2 mb-1">
                    <span className="text-gray-500">History:</span>
                    <input
                        type="range"
                        min={0}
                        max={max + 1}
                        value={currentVal}
                        onChange={(e) => {
                            const val = parseInt(e.target.value);
                            if (val > max) {
                                setSliderIndex(-1); // Live mode
                            } else {
                                setSliderIndex(val);
                                setIsPaused(true); // Auto-pause when dragging
                            }
                        }}
                        className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700"
                    />
                    <span className="w-12 text-right text-gray-500">
                        {sliderIndex === -1 ? 'LIVE' : `-${max - sliderIndex}`}
                    </span>
                </div>
                {sliderIndex !== -1 && (
                    <div className="flex justify-center mt-1">
                        <button
                            onClick={() => { setSliderIndex(-1); setIsPaused(false); }}
                            className="text-xs text-blue-500 hover:text-blue-600 underline"
                        >
                            Return to Live
                        </button>
                    </div>
                )}
            </div>

            {/* Tree View */}
            <div className="flex-1 overflow-auto p-2">
                <JsonNode
                    name="root"
                    value={activeState}
                    depth={0}
                    initialDepth={initialDepth}
                    lastOpKey={history[sliderIndex]?.opKey}
                />
            </div>

            {/* Status Footer */}
            <div className="p-1 px-2 border-t text-gray-400 text-[10px] flex justify-between bg-white dark:bg-gray-950">
                <span>Peer: {client.getPeerId()}</span>
                <span>{Object.keys(activeState).length} Keys</span>
            </div>
        </div>
    );
};

// =============================================================================
// Internal: Recursive JSON Tree Renderer
// =============================================================================

interface JsonNodeProps {
    name: string;
    value: unknown;
    depth: number;
    initialDepth: number;
    lastOpKey?: string;
}

const JsonNode: React.FC<JsonNodeProps> = ({ name, value, depth, initialDepth, lastOpKey }) => {
    const [expanded, setExpanded] = useState(depth < initialDepth);
    const isObject = value !== null && typeof value === 'object';
    const isArray = Array.isArray(value);
    const isEmpty = isObject && Object.keys(value as object).length === 0;

    // Highlight if this key matches the last operation
    const isHighlight = name === lastOpKey;

    if (!isObject) {
        let displayValue = JSON.stringify(value);
        if (typeof value === 'string') displayValue = `"${value}"`;
        if (value === undefined) displayValue = 'undefined';
        if (value === null) displayValue = 'null';

        const colorClass =
            typeof value === 'string' ? 'text-green-600 dark:text-green-400' :
                typeof value === 'number' ? 'text-blue-600 dark:text-blue-400' :
                    typeof value === 'boolean' ? 'text-purple-600 dark:text-purple-400' :
                        'text-gray-500';

        return (
            <div className={`flex hover:bg-black/5 dark:hover:bg-white/5 rounded px-1 ${isHighlight ? 'bg-yellow-100 dark:bg-yellow-900/30' : ''}`}>
                <span className="text-gray-500 dark:text-gray-400 mr-1">{name}:</span>
                <span className={colorClass}>{displayValue}</span>
            </div>
        );
    }

    if (isEmpty) {
        return (
            <div className="flex px-1">
                <span className="text-gray-500 dark:text-gray-400 mr-1">{name}:</span>
                <span className="text-gray-400">{isArray ? '[]' : '{}'}</span>
            </div>
        );
    }

    return (
        <div>
            <div
                className={`flex cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded px-1 ${isHighlight ? 'bg-yellow-100 dark:bg-yellow-900/30' : ''}`}
                onClick={() => setExpanded(!expanded)}
            >
                <span className="text-gray-400 mr-1 w-3 inline-block select-none">
                    {expanded ? '▼' : '▶'}
                </span>
                <span className="text-purple-700 dark:text-purple-400 font-semibold mr-1">{name}</span>
                {!expanded && (
                    <span className="text-gray-400 text-[10px] self-center">
                        {isArray ? `Array(${Object.keys(value).length})` : `Object{${Object.keys(value).length}}`}
                    </span>
                )}
            </div>

            {expanded && (
                <div className="pl-4 border-l border-gray-200 dark:border-gray-800 ml-1.5">
                    {Object.entries(value).map(([k, v]) => (
                        <JsonNode
                            key={k}
                            name={k}
                            value={v}
                            depth={depth + 1}
                            initialDepth={initialDepth}
                            lastOpKey={depth === 0 && k === lastOpKey ? k : undefined}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};
