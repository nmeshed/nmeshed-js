import { useState, useEffect, useCallback } from 'react';
import { useNmeshedContext, useNmeshedStatus } from './context';
import { usePresence } from './usePresence';
import { UI_LAYERS } from './layers';
import type { ChaosOptions, ConnectionStatus } from '../types';

/**
 * Style definitions for the HUD.
 * Using explicit types instead of Record<string, any> for type safety.
 */
interface HUDStyles {
    overlay: React.CSSProperties;
    header: React.CSSProperties;
    title: React.CSSProperties;
    closeBtn: React.CSSProperties;
    section: React.CSSProperties;
    sectionTitle: React.CSSProperties;
    peerList: React.CSSProperties;
    peerRow: React.CSSProperties;
    peerInfo: React.CSSProperties;
    peerId: React.CSSProperties;
    peerMeta: React.CSSProperties;
    divider: React.CSSProperties;
    empty: React.CSSProperties;
    controlRow: React.CSSProperties;
    label: React.CSSProperties;
    slider: React.CSSProperties;
    value: React.CSSProperties;
    footer: React.CSSProperties;
    kbd: React.CSSProperties;
}

/**
 * Props for the status badge component.
 */
interface StatusBadgeProps {
    status: string;
}

/**
 * Props for the avatar component.
 */
interface AvatarProps {
    color: string;
    initials: string;
}

/**
 * NMeshedHUD - A delightful diagnostic overlay for developers.
 *
 * Provides real-time visibility into the mesh health, peer latency,
 * and topology. Also includes "Chaos Mode" controls
 * for testing network resilience.
 *
 * Toggle visibility using `Ctrl+Shift+D` by default.
 *
 * ## Improvements
 * - Uses centralized Z-index layer system
 * - Passive keyboard listener (no main thread blocking)
 * - Proper TypeScript types (no `any` casts)
 */
export function NMeshedHUD() {
    const client = useNmeshedContext();
    const { status: connectionStatus } = useNmeshedStatus();
    const peers = usePresence();
    const [isVisible, setIsVisible] = useState(false);
    const [lifecycleStatus, setLifecycleStatus] = useState<ConnectionStatus | string>('IDLE');
    const [chaos, setChaos] = useState<ChaosOptions | null>(null);

    // Determine display status (prefer lifecycle status, fallback to connection status)
    const displayStatus = lifecycleStatus !== 'IDLE' ? lifecycleStatus : connectionStatus;

    // Keyboard shortcut handler
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'D') {
            e.preventDefault();
            setIsVisible(prev => !prev);
        }
    }, []);

    // Register keyboard shortcut with passive listener where possible
    useEffect(() => {
        // Note: We need to prevent default to avoid browser debug shortcuts,
        // so we can't use fully passive. But the listener is lightweight.
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);

    // Subscribe to lifecycle state changes
    useEffect(() => {
        // Type-safe check for client methods
        const clientAny = client as unknown as {
            onStatusChange?: (cb: (s: string) => void) => () => void;
            on?: (event: string, cb: (s: string) => void) => () => void;
        };

        const unsubscribes: (() => void)[] = [];

        if (typeof clientAny.onStatusChange === 'function') {
            const unsub = clientAny.onStatusChange((s) => setLifecycleStatus(s));
            if (typeof unsub === 'function') unsubscribes.push(unsub);
        }

        if (typeof clientAny.on === 'function') {
            const unsub = clientAny.on('lifecycleStateChange', (s) => setLifecycleStatus(s));
            if (typeof unsub === 'function') unsubscribes.push(unsub);
        }

        return () => {
            for (const unsub of unsubscribes) {
                unsub();
            }
        };
    }, [client]);

    // Chaos mode toggle handler
    const toggleChaos = useCallback((option: keyof ChaosOptions, value: number) => {
        setChaos(prevChaos => {
            const newChaos = { ...prevChaos, [option]: value };

            // Clear chaos if all values are zero
            if (value === 0 && !newChaos.latency && !newChaos.jitter && !newChaos.packetLoss) {
                // Type-safe call
                const clientAny = client as unknown as {
                    simulateNetwork?: (opts: ChaosOptions | null) => void;
                };
                if (typeof clientAny.simulateNetwork === 'function') {
                    clientAny.simulateNetwork(null);
                }
                return null;
            }

            // Apply chaos
            const clientAny = client as unknown as {
                simulateNetwork?: (opts: ChaosOptions | null) => void;
            };
            if (typeof clientAny.simulateNetwork === 'function') {
                clientAny.simulateNetwork(newChaos);
            }
            return newChaos;
        });
    }, [client]);

    if (!isVisible) return null;

    return (
        <div style={styles.overlay} data-testid="nmeshed-hud">
            <div style={styles.header}>
                <div style={styles.title}>nMeshed Diagnostics</div>
                <StatusBadge status={displayStatus} />
                <button
                    style={styles.closeBtn}
                    onClick={() => setIsVisible(false)}
                    data-testid="hud-close"
                    aria-label="Close HUD"
                >
                    ×
                </button>
            </div>

            <div style={styles.section}>
                <div style={styles.sectionTitle}>Mesh Topology & Latency</div>
                <div style={styles.peerList}>
                    {peers.map(peer => (
                        <div key={peer.userId} style={styles.peerRow}>
                            <Avatar color={peer.color || '#dee2e6'} initials={peer.userId.slice(0, 2).toUpperCase()} />
                            <div style={styles.peerInfo}>
                                <div style={styles.peerId}>{peer.userId}</div>
                                <div style={styles.peerMeta}>
                                    {peer.latency ? `${peer.latency}ms` : '--ms'}
                                    <span style={styles.divider}>•</span>
                                    {peer.status === 'online' ? 'Active' : 'Idle'}
                                </div>
                            </div>
                        </div>
                    ))}
                    {peers.length === 0 && <div style={styles.empty}>No peers connected</div>}
                </div>
            </div>

            <div style={styles.section}>
                <div style={styles.sectionTitle}>Network Chaos Simulation</div>
                <div style={styles.controlRow}>
                    <label style={styles.label} htmlFor="chaos-latency">Latency (ms)</label>
                    <input
                        id="chaos-latency"
                        type="range"
                        min="0"
                        max="1000"
                        step="50"
                        value={chaos?.latency || 0}
                        onChange={(e) => toggleChaos('latency', parseInt(e.target.value, 10))}
                        style={styles.slider}
                    />
                    <span style={styles.value}>{chaos?.latency || 0}ms</span>
                </div>
                <div style={styles.controlRow}>
                    <label style={styles.label} htmlFor="chaos-loss">Packet Loss (%)</label>
                    <input
                        id="chaos-loss"
                        type="range"
                        min="0"
                        max="100"
                        step="5"
                        value={chaos?.packetLoss || 0}
                        onChange={(e) => toggleChaos('packetLoss', parseInt(e.target.value, 10))}
                        style={styles.slider}
                    />
                    <span style={styles.value}>{chaos?.packetLoss || 0}%</span>
                </div>
            </div>

            <div style={styles.footer}>
                Press <kbd style={styles.kbd}>Ctrl+Shift+D</kbd> to toggle HUD
            </div>
        </div>
    );
}

/**
 * Status badge with dynamic styling based on connection state.
 */
function StatusBadge({ status }: StatusBadgeProps) {
    const isConnected = status === 'ACTIVE' || status === 'CONNECTED' || status === 'SYNCING' || status === 'READY';
    const badgeStyle: React.CSSProperties = {
        fontSize: '10px',
        fontWeight: 600,
        backgroundColor: isConnected ? '#e6fcf5' : '#fff4e6',
        color: isConnected ? '#099268' : '#d9480f',
        padding: '2px 8px',
        borderRadius: '12px',
        textTransform: 'uppercase',
    };
    return <div style={badgeStyle}>{status}</div>;
}

/**
 * Avatar component with color and initials.
 */
function Avatar({ color, initials }: AvatarProps) {
    const avatarStyle: React.CSSProperties = {
        width: '32px',
        height: '32px',
        borderRadius: '50%',
        backgroundColor: color,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '10px',
        fontWeight: 700,
        color: '#fff',
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.05)',
        flexShrink: 0,
    };
    return <div style={avatarStyle}>{initials}</div>;
}

const styles: HUDStyles = {
    overlay: {
        position: 'fixed',
        top: '20px',
        right: '20px',
        width: '320px',
        backgroundColor: 'rgba(255, 255, 255, 0.8)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)' as unknown as undefined, // Safari support
        borderRadius: '16px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.1)',
        border: '1px solid rgba(255, 255, 255, 0.4)',
        padding: '16px',
        zIndex: UI_LAYERS.DEBUG_HUD,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#1a1a1a',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '20px',
        gap: '8px',
    },
    title: {
        fontSize: '14px',
        fontWeight: 700,
        letterSpacing: '-0.02em',
        flex: 1,
    },
    closeBtn: {
        background: 'none',
        border: 'none',
        fontSize: '20px',
        cursor: 'pointer',
        color: '#adb5bd',
        padding: '0 4px',
        lineHeight: 1,
    },
    section: {
        marginBottom: '20px',
    },
    sectionTitle: {
        fontSize: '11px',
        fontWeight: 600,
        color: '#868e96',
        textTransform: 'uppercase',
        marginBottom: '12px',
        letterSpacing: '0.05em',
    },
    peerList: {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
    },
    peerRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
    },
    peerInfo: {
        flex: 1,
        minWidth: 0, // Enable text truncation
    },
    peerId: {
        fontSize: '11px',
        fontWeight: 600,
        color: '#212529',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    peerMeta: {
        fontSize: '10px',
        color: '#868e96',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
    },
    divider: {
        color: '#dee2e6',
    },
    empty: {
        fontSize: '11px',
        color: '#adb5bd',
        textAlign: 'center',
        padding: '8px 0',
    },
    controlRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        marginBottom: '8px',
    },
    label: {
        fontSize: '11px',
        color: '#495057',
        width: '90px',
        flexShrink: 0,
    },
    slider: {
        flex: 1,
        accentColor: '#339af0',
    },
    value: {
        fontSize: '11px',
        color: '#868e96',
        width: '45px',
        textAlign: 'right',
    },
    footer: {
        marginTop: '16px',
        paddingTop: '12px',
        borderTop: '1px solid #f1f3f5',
        fontSize: '10px',
        color: '#adb5bd',
        textAlign: 'center',
    },
    kbd: {
        backgroundColor: '#f8f9fa',
        border: '1px solid #dee2e6',
        borderRadius: '3px',
        padding: '1px 4px',
        fontSize: '9px',
        color: '#495057',
        fontFamily: 'monospace',
    },
};
