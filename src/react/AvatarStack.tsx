import { usePresence, generateStableColor } from './usePresence';

/**
 * Inline styles for AvatarStack.
 * Using inline styles instead of Tailwind for SDK portability.
 */
const styles = {
    container: {
        display: 'flex',
        alignItems: 'center',
        overflow: 'hidden',
    },
    avatarsWrapper: {
        display: 'flex',
        // Negative margin for overlap effect
        marginLeft: '-8px',
    },
    avatar: {
        position: 'relative' as const,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '32px',
        height: '32px',
        borderRadius: '50%',
        outline: '2px solid #ffffff',
        fontSize: '11px',
        fontWeight: 600,
        color: '#ffffff',
        backgroundColor: '#9ca3af',
        marginLeft: '-8px',
        flexShrink: 0,
        cursor: 'default',
    },
    firstAvatar: {
        marginLeft: 0,
    },
    onlineIndicator: {
        position: 'absolute' as const,
        bottom: 0,
        right: 0,
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        backgroundColor: '#34d399',
        outline: '2px solid #ffffff',
    },
    count: {
        marginLeft: '16px',
        fontSize: '12px',
        color: '#6b7280',
        whiteSpace: 'nowrap' as const,
    },
};

/**
 * A horizontal stack of avatars showing online users.
 *
 * ## Features
 * - Overlapping avatar design (like GitHub/Linear)
 * - Online status indicator
 * - Stable color generation per user ID
 * - Inline styles for SDK portability (no Tailwind required)
 *
 * @example
 * ```tsx
 * <AvatarStack />
 * ```
 */
export function AvatarStack() {
    const users = usePresence();

    if (users.length === 0) return null;

    return (
        <div style={styles.container}>
            <div style={styles.avatarsWrapper}>
                {users.map((user, index) => {
                    // Use stable color from user or generate one
                    const backgroundColor = user.color || generateStableColor(user.userId);

                    return (
                        <div
                            key={user.userId}
                            style={{
                                ...styles.avatar,
                                ...(index === 0 ? styles.firstAvatar : {}),
                                backgroundColor,
                            }}
                            title={`${user.userId} (${user.status})`}
                        >
                            {user.userId.slice(0, 2).toUpperCase()}
                            {user.status === 'online' && (
                                <span style={styles.onlineIndicator} />
                            )}
                        </div>
                    );
                })}
            </div>
            <div style={styles.count}>
                {users.length} active
            </div>
        </div>
    );
}
