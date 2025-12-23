import { useState, useEffect } from 'react';
import { useNmeshedContext } from './context';
import { usePresence } from './usePresence';
import type { MeshLifecycleState } from '../mesh/types';
import type { ChaosOptions } from '../types';

/**
 * NMeshedHUD - A delightful diagnostic overlay for developers.
 * 
 * Provides real-time visibility into the mesh health, peer latency,
 * and topology (Relay vs P2P). Also includes "Chaos Mode" controls
 * for testing network resilience.
 * 
 * Toggle visibility using `Ctrl+Shift+D` by default.
 */
export function NMeshedHUD() {
    const client = useNmeshedContext();
    const peers = usePresence();
    const [isVisible, setIsVisible] = useState(false);
    const [status, setStatus] = useState<MeshLifecycleState | string>('IDLE');
    const [chaos, setChaos] = useState<ChaosOptions | null>(null);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.ctrlKey && e.shiftKey && e.key === 'D') {
                setIsVisible(prev => !prev);
            }
        };
        window.addEventListener('keydown', handleKeyDown);

        const unsubscribeStatus = (client as any).onStatusChange?.((s: string) => setStatus(s));
        const unsubscribeLifecycle = (client as any).on?.('lifecycleStateChange', (s: string) => setStatus(s));

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            unsubscribeStatus?.();
            unsubscribeLifecycle?.();
        };
    }, [client]);

    if (!isVisible) return null;

    const toggleChaos = (option: keyof ChaosOptions, value: number) => {
        const newChaos = { ...chaos, [option]: value };
        if (value === 0 && !newChaos.latency && !newChaos.jitter && !newChaos.packetLoss) {
            setChaos(null);
            (client as any).simulateNetwork(null);
        } else {
            setChaos(newChaos);
            (client as any).simulateNetwork(newChaos);
        }
    };

    return (
        <div style={styles.overlay}>
            <div style={styles.header}>
                <div style={styles.title}>nMeshed Diagnostics</div>
                <div style={styles.statusBadge(status)}>{status}</div>
                <button style={styles.closeBtn} onClick={() => setIsVisible(false)}>×</button>
            </div>

            <div style={styles.section}>
                <div style={styles.sectionTitle}>Mesh Topology & Latency</div>
                <div style={styles.peerList}>
                    {peers.map(peer => (
                        <div key={peer.userId} style={styles.peerRow}>
                            <div style={styles.avatar(peer.color)}>{peer.userId.slice(0, 2).toUpperCase()}</div>
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
                        type="range" min="0" max="1000" step="50"
                        value={chaos?.latency || 0}
                        onChange={(e) => toggleChaos('latency', parseInt(e.target.value))}
                        style={styles.slider}
                    />
                    <span style={styles.value}>{chaos?.latency || 0}ms</span>
                </div>
                <div style={styles.controlRow}>
                    <label style={styles.label} htmlFor="chaos-loss">Packet Loss (%)</label>
                    <input
                        id="chaos-loss"
                        type="range" min="0" max="100" step="5"
                        value={chaos?.packetLoss || 0}
                        onChange={(e) => toggleChaos('packetLoss', parseInt(e.target.value))}
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

const styles: Record<string, any> = {
    overlay: {
        position: 'fixed',
        top: '20px',
        right: '20px',
        width: '320px',
        backgroundColor: 'rgba(255, 255, 255, 0.8)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderRadius: '16px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.1)',
        border: '1px solid rgba(255, 255, 255, 0.4)',
        padding: '16px',
        zIndex: 9999,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#1a1a1a',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '20px',
    },
    title: {
        fontSize: '14px',
        fontWeight: '700',
        letterSpacing: '-0.02em',
    },
    statusBadge: (status: string) => ({
        fontSize: '10px',
        fontWeight: '600',
        backgroundColor: status === 'ACTIVE' || status === 'CONNECTED' ? '#e6fcf5' : '#fff4e6',
        color: status === 'ACTIVE' || status === 'CONNECTED' ? '#099268' : '#d9480f',
        padding: '2px 8px',
        borderRadius: '12px',
        textTransform: 'uppercase',
    }),
    closeBtn: {
        background: 'none',
        border: 'none',
        fontSize: '20px',
        cursor: 'pointer',
        color: '#adb5bd',
        padding: '0 4px',
    },
    section: {
        marginBottom: '20px',
    },
    sectionTitle: {
        fontSize: '11px',
        fontWeight: '600',
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
    avatar: (color: string) => ({
        width: '32px',
        height: '32px',
        borderRadius: '50%',
        backgroundColor: color || '#dee2e6',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '10px',
        fontWeight: '700',
        color: '#fff',
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.05)',
    }),
    peerInfo: {
        flex: 1,
    },
    peerId: {
        fontSize: '11px',
        fontWeight: '600',
        color: '#212529',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        width: '180px',
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
    }
};
