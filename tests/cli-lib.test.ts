
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCLI, runCommand } from '../src/cli-lib';
import fs from 'fs';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

// Mock child_process
vi.mock('child_process', () => ({
    spawn: vi.fn(),
}));

// Mock fs
vi.mock('fs', () => {
    return {
        default: {
            existsSync: vi.fn(),
            writeFileSync: vi.fn(),
        },
        existsSync: vi.fn(),
        writeFileSync: vi.fn(),
    };
});

// Mock console
const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
const processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`Process.exit(${code})`);
});

describe('CLI Lib', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('runCommand', () => {
        it('should resolve on success (code 0)', async () => {
            const mockChild = new EventEmitter();
            // @ts-ignore
            spawn.mockReturnValue(mockChild);

            const promise = runCommand('echo', ['hello']);
            setTimeout(() => mockChild.emit('close', 0), 10);
            await expect(promise).resolves.toBeUndefined();
        });

        it('should reject on failure (code 1)', async () => {
            const mockChild = new EventEmitter();
            // @ts-ignore
            spawn.mockReturnValue(mockChild);

            const promise = runCommand('fail', []);
            setTimeout(() => mockChild.emit('close', 1), 10);
            await expect(promise).rejects.toThrow('Command failed with code 1');
        });
    });

    describe('deploy command', () => {
        it('should define deploy command', () => {
            const cli = createCLI();
            const parsed = cli.parse(['node', 'cli', 'deploy', '--name', 'test-worker'], { run: false });
            expect(cli.matchedCommand?.name).toBe('deploy');
            expect(parsed.options).toMatchObject({ name: 'test-worker' });
        });

        it('should handle missing wrangler', async () => {
            const cli = createCLI();
            const mockChild = new EventEmitter();
            // @ts-ignore
            spawn.mockReturnValue(mockChild);

            // Execute (don't await promise as cac might be synchronous wrapper around async action)
            try {
                cli.parse(['node', 'cli', 'deploy'], { run: true });
            } catch (e) {
                // Ignore sync errors, we look for side effects
            }

            // Trigger failure asynchronously
            setTimeout(() => mockChild.emit('error', new Error('ENOENT')), 10);

            // Wait for Process.exit side effect
            await vi.waitFor(() => {
                expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error: "wrangler" not found'));
                expect(processExitSpy).toHaveBeenCalledWith(1);
            });
        });

        it('should generate wrangler.toml if missing', async () => {
            const cli = createCLI();
            const mockChild = new EventEmitter();
            // @ts-ignore
            spawn.mockReturnValue(mockChild);

            (fs.existsSync as any).mockReturnValue(false);

            cli.parse(['node', 'cli', 'deploy'], { run: true });

            setTimeout(() => mockChild.emit('close', 0), 10);

            await vi.waitFor(() => {
                expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Wrangler found'));
                expect(fs.writeFileSync).toHaveBeenCalledWith(
                    expect.stringContaining('wrangler.toml'),
                    expect.stringContaining('nmeshed-worker')
                );
            });
        });

        it('should proceed if wrangler.toml exists', async () => {
            const cli = createCLI();
            const mockChild = new EventEmitter();
            // @ts-ignore
            spawn.mockReturnValue(mockChild);

            (fs.existsSync as any).mockReturnValue(true);

            cli.parse(['node', 'cli', 'deploy'], { run: true });
            setTimeout(() => mockChild.emit('close', 0), 10);

            await vi.waitFor(() => {
                expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Bundled Worker not found'));
                expect(fs.writeFileSync).not.toHaveBeenCalled();
            });
        });
    });
});
