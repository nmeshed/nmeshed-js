import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AvatarStack } from './AvatarStack';

// Mock usePresence hook
vi.mock('./usePresence', () => ({
    usePresence: vi.fn(),
    generateStableColor: vi.fn((userId: string) => `#${userId.charCodeAt(0).toString(16).padStart(6, '0')}`),
}));

import { usePresence, generateStableColor } from './usePresence';

describe('AvatarStack', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns null when no users', () => {
        (usePresence as any).mockReturnValue([]);
        const { container } = render(<AvatarStack />);
        expect(container.firstChild).toBeNull();
    });

    it('renders avatars for online users', () => {
        (usePresence as any).mockReturnValue([
            { userId: 'alice', status: 'online' },
            { userId: 'bob', status: 'online' }
        ]);

        render(<AvatarStack />);

        expect(screen.getByText('AL')).toBeTruthy();
        expect(screen.getByText('BO')).toBeTruthy();
        expect(screen.getByText('2 active')).toBeTruthy();
    });

    it('uses user color if provided', () => {
        (usePresence as any).mockReturnValue([
            { userId: 'charlie', status: 'online', color: '#ff0000' }
        ]);

        const { container } = render(<AvatarStack />);

        // Find the avatar div by its background color since inline styles are applied
        const avatarDivs = container.querySelectorAll('div');
        // The component structure is: container > wrapper > avatar divs
        // Avatar is the third level div with backgroundColor
        let found = false;
        avatarDivs.forEach(div => {
            if (div.style.backgroundColor === 'rgb(255, 0, 0)') {
                found = true;
            }
        });
        expect(found).toBe(true);
    });

    it('generates stable color if user has no color', () => {
        (usePresence as any).mockReturnValue([
            { userId: 'dave', status: 'online' }
        ]);

        render(<AvatarStack />);

        expect(generateStableColor).toHaveBeenCalledWith('dave');
    });

    it('shows online indicator for online users', () => {
        (usePresence as any).mockReturnValue([
            { userId: 'eve', status: 'online' }
        ]);

        const { container } = render(<AvatarStack />);

        // Indicator is a span with specific styling
        const spans = container.querySelectorAll('span');
        expect(spans.length).toBeGreaterThan(0);
    });

    it('does not show online indicator for non-online users', () => {
        (usePresence as any).mockReturnValue([
            { userId: 'frank', status: 'away' }
        ]);

        const { container } = render(<AvatarStack />);

        // No spans should exist for away status (no indicator)
        const spans = container.querySelectorAll('span');
        expect(spans.length).toBe(0);
    });

    it('displays correct title attribute', () => {
        (usePresence as any).mockReturnValue([
            { userId: 'grace', status: 'online' }
        ]);

        const { container } = render(<AvatarStack />);

        const avatarWithTitle = container.querySelector('[title="grace (online)"]');
        expect(avatarWithTitle).not.toBeNull();
    });
});
