
import React, { useState, useEffect } from 'react';
import { useSyncedMap, useSyncedDict } from '../react/collections';
import { NMeshedProvider } from '../ai/react';

// Styles
const styles = {
    container: {
        position: 'fixed' as const,
        bottom: '20px',
        right: '20px',
        width: '350px',
        backgroundColor: '#1a1a1a',
        color: '#e0e0e0',
        borderRadius: '8px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        fontFamily: 'monospace',
        fontSize: '12px',
        zIndex: 9999,
        border: '1px solid #333',
        display: 'flex',
        flexDirection: 'column' as const,
        maxHeight: '500px',
    },
    header: {
        padding: '10px',
        backgroundColor: '#2a2a2a',
        borderBottom: '1px solid #333',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        cursor: 'pointer',
        borderTopLeftRadius: '8px',
        borderTopRightRadius: '8px',
    },
    title: {
        fontWeight: 'bold',
        color: '#4caf50',
    },
    content: {
        overflowY: 'auto' as const,
        padding: '10px',
    },
    tabBar: {
        display: 'flex',
        borderBottom: '1px solid #333',
    },
    tab: (active: boolean) => ({
        flex: 1,
        padding: '8px',
        textAlign: 'center' as const,
        cursor: 'pointer',
        backgroundColor: active ? '#1a1a1a' : '#252525',
        color: active ? '#fff' : '#888',
        borderBottom: active ? '2px solid #4caf50' : 'none',
    }),
    jsonTree: {
        whiteSpace: 'pre-wrap' as const,
        color: '#a5d6a7',
    },
    logEntry: {
        marginBottom: '5px',
        padding: '5px',
        backgroundColor: '#222',
        borderRadius: '4px',
        borderLeft: '2px solid #4caf50',
    }
};

interface InspectorProps {
    workspaceId?: string; // Optional, can auto-detect from context if inside provider
}

export const AgentStateInspector: React.FC<InspectorProps> = ({ workspaceId }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<'state' | 'signals'>('state');

    // Safe access to hooks - assume we are inside NMeshedProvider
    // If workspaceId is provided, we might be outside the main provider, 
    // but useSyncedStore usually expects to be inside.
    // For this V1, let's assume it's rendered inside the layout which is inside the provider.

    // We bind to the store to get live updates
    // useSyncedDict('') gives the entire root store
    const [storeState] = useSyncedDict<any>('');

    // For signals, we want ALL queues.
    // Signals are stored under "signals.{queueId}.{signalId}"
    // So if we map "signals", we get keys like "{queueId}.{signalId}".
    const [allSignalsMap] = useSyncedMap<any>('signals');
    const [signalLog, setSignalLog] = useState<any[]>([]);

    useEffect(() => {
        const values = Object.values(allSignalsMap);
        if (values.length > 0) {
            // Sort by createdAt
            const sorted = values.sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0));
            setSignalLog(sorted.slice(0, 50));
        }
    }, [allSignalsMap]);

    if (!isOpen) {
        return (
            <div style={{ ...styles.container, width: 'auto', height: 'auto' }} onClick={() => setIsOpen(true)}>
                <div style={styles.header}>
                    <span style={styles.title}>nMeshed Inspector</span>
                </div>
            </div>
        );
    }

    return (
        <div style={styles.container}>
            <div style={styles.header} onClick={() => setIsOpen(false)}>
                <span style={styles.title}>nMeshed Inspector {workspaceId ? `(${workspaceId.slice(0, 4)}...)` : ''}</span>
                <span>▼</span>
            </div>

            <div style={styles.tabBar}>
                <div style={styles.tab(activeTab === 'state')} onClick={() => setActiveTab('state')}>State</div>
                <div style={styles.tab(activeTab === 'signals')} onClick={() => setActiveTab('signals')}>Signals</div>
            </div>

            <div style={styles.content}>
                {activeTab === 'state' && (
                    <div style={styles.jsonTree}>
                        {JSON.stringify(storeState, null, 2)}
                    </div>
                )}

                {activeTab === 'signals' && (
                    <div>
                        {signalLog.length === 0 ? <div style={{ color: '#666' }}>No recent signals</div> : null}
                        {signalLog.map((sig, i) => (
                            <div key={i} style={styles.logEntry}>
                                {JSON.stringify(sig)}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};
