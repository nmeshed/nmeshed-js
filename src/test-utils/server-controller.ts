import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import net from 'net';

export class ServerController {
    private process: ChildProcess | null = null;
    public port: number;

    constructor(port = 0) {
        this.port = port;
    }

    async start(): Promise<void> {
        if (this.process) return;

        const serverDir = path.resolve(__dirname, '../../../../product/server/');
        const tmpDbPath = path.resolve('/tmp', `badger-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);

        this.process = spawn('go', ['run', 'main.go'], {
            stdio: ['inherit', 'inherit', 'pipe'],
            cwd: serverDir,
            env: {
                ...process.env,
                LOG_LEVEL: 'info',
                BADGER_PATH: tmpDbPath,
                SQLITE_PATH: tmpDbPath + '.sqlite',
                PORT: this.port.toString(),
                AUTH_BYPASS_DEV: 'true'
            }
        });

        console.log(`[ServerController] Starting server on port ${this.port} (0=ephemeral)...`);

        // Capture port from stderr (slog output)
        const discoveredPort = await this.discoverPort();
        this.port = discoveredPort;

        await this.waitForReady();
        console.log(`[ServerController] Server ready on port ${this.port}.`);
    }

    private discoverPort(): Promise<number> {
        return new Promise((resolve, reject) => {
            let buffer = '';
            const timeout = setTimeout(() => {
                reject(new Error('Timed out waiting for server port log'));
            }, 10000);

            this.process!.stderr!.on('data', (data) => {
                const chunk = data.toString();
                process.stderr.write(data); // Still pipe to parent stderr for debugging
                buffer += chunk;

                // Look for server_starting msg with port
                const lines = buffer.split('\n');
                for (const line of lines) {
                    try {
                        const log = JSON.parse(line);
                        if (log.msg === 'server_starting' && log.port) {
                            clearTimeout(timeout);
                            resolve(parseInt(log.port, 10));
                            return;
                        }
                    } catch (e) {
                        // Not JSON or incomplete line
                    }
                }
                buffer = lines[lines.length - 1]; // Keep last partial line
            });
        });
    }

    async stop(): Promise<void> {
        if (this.process) {
            this.process.kill();
            this.process = null;
            // Wait a bit for port release
            await new Promise(r => setTimeout(r, 100));
        }
    }

    private async waitForReady(): Promise<void> {
        const start = Date.now();
        while (Date.now() - start < 10000) {
            try {
                await this.checkPort();
                return;
            } catch (e) {
                await new Promise(r => setTimeout(r, 200));
            }
        }
        throw new Error('Server failed to start within 10s');
    }

    private checkPort(): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            socket.setTimeout(200);
            socket.on('connect', () => {
                socket.destroy();
                resolve();
            });
            socket.on('timeout', () => {
                socket.destroy();
                reject(new Error('timeout'));
            });
            socket.on('error', (err) => {
                socket.destroy();
                reject(err);
            });
            socket.connect(this.port, '127.0.0.1');
        });
    }
}
