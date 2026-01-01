// @vitest-environment jsdom
import React from 'react';
import { render, act } from '@testing-library/react';
import { NMeshedClient } from '../src/client'; // Adjust path
import { NMeshedProvider } from '../src/react/context';
import { useStore } from '../src/react/hooks';

// Mocks
Object.defineProperty(global, 'crypto', {
    value: { randomUUID: () => 'uuid-' + Math.random() },
    writable: true
});

describe('React SDK Performance (Zero-Jank)', () => {
    let client: NMeshedClient;

    beforeEach(() => {
        client = new NMeshedClient({
            workspaceId: 'perf-test',
            token: 'test-token',
            userId: 'perf-user',
            storage: {
                init: async () => { },
                get: async () => undefined,
                set: async () => { },
                delete: async () => { },
                getAll: async () => ({})
            } as any
        });
    });

    it('should not re-render unrelated components', async () => {
        const renderCounts = { A: 0, B: 0 };

        const ComponentA = () => {
            const store = useStore<any>('item-a');
            renderCounts.A++;
            return <div>{store.value}</div>;
        };

        const ComponentB = () => {
            const store = useStore<any>('item-b');
            renderCounts.B++;
            return <div>{store.value}</div>;
        };

        const App = () => (
            <NMeshedProvider client={client}>
                <ComponentA />
                <ComponentB />
            </NMeshedProvider>
        );

        render(<App />);

        // Capture initial render counts (might be 1 or 2 due to React StrictMode/Concurrent checks)
        const initialA = renderCounts.A;
        const initialB = renderCounts.B;

        // Validating baseline sanity (it rendered at least once)
        expect(initialA).toBeGreaterThan(0);
        expect(initialB).toBeGreaterThan(0);

        // Update Item A
        act(() => {
            client.set('item-a', { value: 'updated' });
        });

        // A should render (+1), B should NOT (0 change)
        expect(renderCounts.A).toBeGreaterThan(initialA);
        expect(renderCounts.B).toBe(initialB); // The critical test: B remained stable
    });

    it('should handle 1000 updates without main thread blocking', async () => {
        const Component = () => {
            const store = useStore<any>('rapid-fire');
            return <div>{store.count}</div>;
        };

        render(
            <NMeshedProvider client={client}>
                <Component />
            </NMeshedProvider>
        );

        const start = performance.now();

        await act(async () => {
            for (let i = 0; i < 1000; i++) {
                client.set('rapid-fire', { count: i });
                // We don't await anything here, simulating high-frequency stream
            }
        });

        const duration = performance.now() - start;
        console.log(`1000 updates processed in ${duration.toFixed(2)}ms`);

        // This is a loose benchmark, but ensures no obvious O(N^2) hook overhead
        expect(duration).toBeLessThan(1000);
    });
});
