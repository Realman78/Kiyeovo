import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

export interface BootstrapNode {
    /** Full dialable multiaddr, e.g. /ip4/127.0.0.1/tcp/19501/p2p/12D3Koo... */
    multiaddr: string;
    stop(): Promise<void>;
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }

    await new Promise<void>((resolve) => {
        const timeoutId = setTimeout(resolve, 5_000);
        child.once('exit', () => {
            clearTimeout(timeoutId);
            resolve();
        });
        child.kill();
    });
}

/**
 * Spawns `src/core/bootstrap.ts` (the same script `npm run bootstrap` runs) as a
 * child process, with its datastore and peer-id file redirected into a scratch
 * directory instead of the repo's default `./bootstrap-datastore` (see
 * BOOTSTRAP_DATASTORE_PATH in src/core/bootstrap.ts). Fast-mode e2e peers need a
 * live bootstrap node to find each other via the DHT — there is no mDNS/LAN
 * discovery wired into the app's libp2p node (see src/core/network/node-factory.ts).
 */
export async function startBootstrapNode(port = 19501): Promise<BootstrapNode> {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'kiyeovo-e2e-bootstrap-'));

    const child: ChildProcessWithoutNullStreams = spawn(
        tsxBin,
        [path.join(repoRoot, 'src', 'core', 'bootstrap.ts')],
        {
            cwd: repoRoot,
            env: {
                ...process.env,
                BOOTSTRAP_LISTEN_ADDRESS: `/ip4/127.0.0.1/tcp/${port}`,
                BOOTSTRAP_DATASTORE_PATH: path.join(scratchDir, 'datastore'),
                BOOTSTRAP_PEER_ID_FILE: path.join(scratchDir, 'peer-id.bin'),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );

    let output = '';
    let settled = false;

    let multiaddr: string;
    try {
        multiaddr = await new Promise<string>((resolve, reject) => {
            const failEarly = (message: string) => {
                if (settled) return;
                settled = true;
                reject(new Error(`${message}\n--- bootstrap node output ---\n${output}`));
            };

            const timeoutId = setTimeout(() => failEarly('Timed out waiting for bootstrap node to become ready'), 30_000);

            const onData = (chunk: Buffer) => {
                output += chunk.toString();
                const match = output.match(/Listening on: (\S+)/);
                if (match && !settled) {
                    settled = true;
                    clearTimeout(timeoutId);
                    resolve(match[1]!);
                }
            };

            child.stdout.on('data', onData);
            child.stderr.on('data', onData);
            child.on('error', (error) => {
                clearTimeout(timeoutId);
                failEarly(`Failed to spawn bootstrap node: ${error.message}`);
            });
            child.on('exit', (code, signal) => {
                clearTimeout(timeoutId);
                failEarly(`Bootstrap node exited early (code=${String(code)}, signal=${String(signal)})`);
            });
        });
    } catch (error) {
        await stopChild(child);
        await rm(scratchDir, { recursive: true, force: true });
        throw error;
    }

    return {
        multiaddr,
        stop: async () => {
            await stopChild(child);
            await rm(scratchDir, { recursive: true, force: true });
        },
    };
}
