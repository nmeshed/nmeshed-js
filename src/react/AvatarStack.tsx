import { usePresence } from './usePresence';

/**
 * A horizontal stack of avatars showing online users.
 */
export function AvatarStack() {
    const users = usePresence();

    if (users.length === 0) return null;

    return (
        <div className="flex -space-x-2 overflow-hidden items-center">
            {users.map((user) => (
                <div
                    key={user.userId}
                    className="inline-block h-8 w-8 rounded-full ring-2 ring-white dark:ring-gray-800 bg-gray-200 flex items-center justify-center text-xs font-medium text-gray-600 relative"
                    title={`${user.userId} (${user.status})`}
                >
                    {user.userId.slice(0, 2).toUpperCase()}
                    {user.status === 'online' && (
                        <span className="absolute bottom-0 right-0 block h-2 w-2 rounded-full ring-2 ring-white bg-green-400" />
                    )}
                </div>
            ))}
            <div className="ml-4 text-xs text-gray-500">
                {users.length} active
            </div>
        </div>
    );
}
