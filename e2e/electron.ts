import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

export interface CloseOptions {
    /**
     * Keep profileDir on disk instead of deleting it (used to relaunch the
     * same identity later — the returning-user/offline-reconnect scenario —
     * rather than the normal throwaway-profile teardown).
     */
    keepProfile?: boolean;
}

export interface LaunchedApp {
    app: ElectronApplication;
    /** The first BrowserWindow's renderer. */
    page: Page;
    /** Per-run scratch dir holding this instance's isolated config/data/cache. */
    profileDir: string;
    /** Main-process stdout+stderr captured so far (e.g. the [CONFIG]/[Electron] logs). */
    logs: string[];
    /**
     * Close the app and, by default, delete profileDir. Pass
     * `{ keepProfile: true }` to keep the on-disk identity/database around for
     * a later `launchApp({ profileDir })` relaunch. Always waits for the
     * underlying OS process to fully exit (not just for Playwright's `close()`
     * call to resolve) before returning — the app's single-instance lock is
     * keyed on the profile dir, so a relaunch racing the old process's exit
     * would otherwise just get rejected as a duplicate instance.
     */
    close(options?: CloseOptions): Promise<void>;
}

export interface LaunchAppOptions {
    /**
     * Value for KIYEOVO_P2P_PORT (see src/electron/main.ts). Each concurrently
     * running instance needs a distinct port, or the second one to start dies
     * with EADDRINUSE — the app's libp2p node otherwise always listens on the
     * hardcoded default (9001).
     */
    p2pPort?: number;
    /** Extra env vars to merge in on top of the isolation defaults below. */
    env?: Record<string, string>;
    /**
     * Reuse an existing profile dir instead of minting a fresh one with
     * mkdtemp. Used to relaunch the *same* identity against a persisted
     * profile (see the offline-delivery/reconnect spec) — the directory must
     * already contain the XDG env / HOME layout a prior launchApp() call created
     * (i.e. it came from an earlier LaunchedApp.profileDir, closed with
     * `{ keepProfile: true }`).
     */
    profileDir?: string;
    /**
     * Extra Chromium/Electron command-line args appended after the fixed
     * `['.', '--no-sandbox']` pair. Introduced for round 5 (calls.spec.ts):
     * `--use-fake-device-for-media-stream` + `--use-fake-ui-for-media-stream`
     * (singular "stream" — see calls.spec.ts's FAKE_MEDIA_ARGS comment for why
     * the more commonly documented plural form doesn't work on this repo's
     * bundled Electron/Chromium) make `getUserMedia`/`getDisplayMedia` return
     * a synthetic camera/mic feed instead of hitting real hardware or a
     * permission prompt, which headless call tests need. Backward
     * compatible — omitted entirely by every existing caller.
     */
    extraArgs?: string[];
}

/**
 * Launches the built app (dist-electron + dist-ui) with an isolated profile.
 *
 * XDG_* overrides point Electron's own userData (session/cookies/etc.) at a
 * temp dir so the single-instance lock (keyed on userData) doesn't collide
 * with a running dev instance or another launchApp() call.
 *
 * That alone is NOT enough to isolate the app's real data, though:
 * `ensureAppDataDir()` (src/core/utils/miscellaneous.ts) computes the
 * chat.db / identity / window-bounds location from `os.homedir()` directly,
 * ignoring XDG_CONFIG_HOME/XDG_DATA_HOME entirely (ends up at the fixed
 * `~/.config/kiyeovo` on Linux — see the e2e README / test report for
 * details). Overriding `HOME` for the child process makes `os.homedir()`
 * follow along too, which is what actually isolates each test instance's
 * database/identity from the real profile and from each other. Without this,
 * two launchApp() calls (or two separate test runs) silently share one
 * on-disk identity and SQLite database.
 */
export async function launchApp(options: LaunchAppOptions = {}): Promise<LaunchedApp> {
    const { p2pPort, env, extraArgs } = options;

    const mainEntry = path.join(repoRoot, 'dist-electron', 'electron', 'main.js');
    if (!existsSync(mainEntry)) {
        throw new Error(
            'Built app not found at dist-electron/electron/main.js. ' +
            'Run "npm run transpile:electron && npm run build" before the e2e suite.',
        );
    }

    const profileDir = options.profileDir ?? await mkdtemp(path.join(tmpdir(), 'kiyeovo-e2e-'));

    const app = await electron.launch({
        // --no-sandbox: the npm-installed Electron has no setuid sandbox helper,
        // and Ubuntu restricts unprivileged user namespaces, so the Chromium
        // sandbox cannot start on headless dev/CI boxes. Test harness only.
        args: ['.', '--no-sandbox', ...(extraArgs ?? [])],
        cwd: repoRoot,
        env: {
            ...(process.env as Record<string, string>),
            // Anything but 'development', so isDev() is false and the window
            // loads the packaged app:// entry URL instead of the Vite dev server.
            NODE_ENV: 'test',
            XDG_CONFIG_HOME: path.join(profileDir, 'config'),
            XDG_DATA_HOME: path.join(profileDir, 'data'),
            XDG_CACHE_HOME: path.join(profileDir, 'cache'),
            // See the doc comment above: this is what actually isolates
            // ensureAppDataDir()'s ~/.config/kiyeovo (chat.db, identity, etc).
            HOME: path.join(profileDir, 'home'),
            ...(p2pPort !== undefined ? { KIYEOVO_P2P_PORT: String(p2pPort) } : {}),
            ...(env ?? {}),
        },
    });

    const page = await app.firstWindow();

    // Capture the main process's own stdout/stderr (the [CONFIG]/[Electron]/
    // libp2p logs) so a failing test can dump what actually happened on the
    // node/DHT side, not just the renderer's DOM state.
    const logs: string[] = [];
    const proc = app.process();
    proc.stdout?.setEncoding('utf-8').on('data', (chunk: string) => logs.push(chunk));
    proc.stderr?.setEncoding('utf-8').on('data', (chunk: string) => logs.push(chunk));

    return {
        app,
        page,
        profileDir,
        logs,
        close: async (closeOptions?: CloseOptions) => {
            // app.close() resolves once Playwright's own teardown is done, but the
            // single-instance lock is released only when the underlying OS process
            // actually exits — waiting on the child process's own 'exit' event (not
            // just Playwright's promise) is what makes an immediate relaunch against
            // the same profileDir safe rather than racing a duplicate-instance
            // rejection.
            const alreadyExited = proc.exitCode !== null || proc.signalCode !== null;
            const exited = alreadyExited
                ? Promise.resolve()
                : new Promise<void>((resolve) => proc.once('exit', () => resolve()));

            await app.close().catch((error) => console.error('app.close() failed:', error));

            await Promise.race([
                exited,
                new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
            ]);

            if (!closeOptions?.keepProfile) {
                await rm(profileDir, { recursive: true, force: true });
            }
        },
    };
}
