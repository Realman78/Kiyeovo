import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

export interface LaunchedApp {
    app: ElectronApplication;
    /** The first BrowserWindow's renderer. */
    page: Page;
    /** Per-run scratch dir holding this instance's isolated config/data/cache. */
    profileDir: string;
    /** Close the app and delete profileDir. */
    close(): Promise<void>;
}

/**
 * Launches the built app (dist-electron + dist-ui) with an isolated profile.
 *
 * XDG_* overrides point Electron's userData at a temp dir so test runs never
 * touch the real ~/.config/Kiyeovo profile, and so the single-instance lock
 * (keyed on userData) doesn't collide with a running dev instance. Note that
 * keytar is NOT isolated by this — it still talks to the real session
 * keychain, so tests must not create or delete keychain-backed accounts.
 */
export async function launchApp(): Promise<LaunchedApp> {
    const mainEntry = path.join(repoRoot, 'dist-electron', 'electron', 'main.js');
    if (!existsSync(mainEntry)) {
        throw new Error(
            'Built app not found at dist-electron/electron/main.js. ' +
            'Run "npm run transpile:electron && npm run build" before the e2e suite.',
        );
    }

    const profileDir = await mkdtemp(path.join(tmpdir(), 'kiyeovo-e2e-'));

    const app = await electron.launch({
        // --no-sandbox: the npm-installed Electron has no setuid sandbox helper,
        // and Ubuntu restricts unprivileged user namespaces, so the Chromium
        // sandbox cannot start on headless dev/CI boxes. Test harness only.
        args: ['.', '--no-sandbox'],
        cwd: repoRoot,
        env: {
            ...(process.env as Record<string, string>),
            // Anything but 'development', so isDev() is false and the window
            // loads the packaged app:// entry URL instead of the Vite dev server.
            NODE_ENV: 'test',
            XDG_CONFIG_HOME: path.join(profileDir, 'config'),
            XDG_DATA_HOME: path.join(profileDir, 'data'),
            XDG_CACHE_HOME: path.join(profileDir, 'cache'),
        },
    });

    const page = await app.firstWindow();

    return {
        app,
        page,
        profileDir,
        close: async () => {
            await app.close();
            await rm(profileDir, { recursive: true, force: true });
        },
    };
}
