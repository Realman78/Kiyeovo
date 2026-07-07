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
    /** This instance's scratch dir (datastore + peer-id file) — pass back in via
     * `startBootstrapNode({ scratchDir })` to relaunch with the SAME identity/
     * multiaddr after a `stop({ keepScratchDir: true })` (round 3's "bootstrap
     * dies mid-session, then comes back" scenario — a genuine restart of the
     * same node, not a fresh one at a coincidentally-reused address). */
    scratchDir: string;
    /** By default also deletes the scratch dir (datastore + peer-id file). Pass
     * `{ keepScratchDir: true }` to preserve it for a later same-identity
     * restart via `startBootstrapNode({ scratchDir })`. */
    stop(options?: { keepScratchDir?: boolean }): Promise<void>;
}

export interface StartBootstrapNodeOptions {
    port?: number;
    /** Reuse an existing scratch dir (see BootstrapNode.scratchDir) to restart
     * a previously-stopped node with the same Peer ID/datastore, instead of
     * minting a fresh throwaway identity. */
    scratchDir?: string;
    /**
     * Extra env vars merged in on top of the fixed BOOTSTRAP_LISTEN_ADDRESS/
     * BOOTSTRAP_DATASTORE_PATH/BOOTSTRAP_PEER_ID_FILE trio below. Added for
     * round 6 (e2e/tor.ts's startOnionFrontedBootstrap): src/core/bootstrap.ts
     * reads BOOTSTRAP_NETWORK_MODE ('fast'|'anonymous', default 'fast') and
     * BOOTSTRAP_ANNOUNCE_ADDRS to run as a genuine anonymous-mode DHT server —
     * without this, a plain startBootstrapNode() call always speaks the
     * fast-mode DHT protocol namespace (`/kiyeovo-fast/1.0.0/dht`), which an
     * anonymous-mode client (`/kiyeovo/1.0.0/dht`) cannot negotiate at all
     * (NETWORK_MODE_CONFIG, src/core/constants.ts:66-67 — the two modes use
     * entirely different protocol string prefixes, not just different
     * validators). Every other caller omits this and keeps the pre-existing
     * fast-mode-only behavior.
     */
    env?: Record<string, string>;
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
export async function startBootstrapNode(options: number | StartBootstrapNodeOptions = {}): Promise<BootstrapNode> {
    const {
        port = 19501,
        scratchDir: reusedScratchDir,
        env: extraEnv,
    } = typeof options === 'number' ? { port: options } : options;
    const scratchDir = reusedScratchDir ?? await mkdtemp(path.join(tmpdir(), 'kiyeovo-e2e-bootstrap-'));

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
                ...(extraEnv ?? {}),
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
        scratchDir,
        stop: async (stopOptions?: { keepScratchDir?: boolean }) => {
            await stopChild(child);
            if (!stopOptions?.keepScratchDir) {
                await rm(scratchDir, { recursive: true, force: true });
            }
        },
    };
}
