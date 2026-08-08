import { expect, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchApp, type LaunchAppOptions, type LaunchedApp } from './electron';
import { startBootstrapNode, type BootstrapNode } from './bootstrap-node';
import {
    addBootstrapServer,
    beginIdentityCreation,
    finishWizard,
    getDhtConnected,
    readPeerId,
    timedStage,
} from './onboard';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * Bundled Tor resources (see e2e/README.md-adjacent groundwork: the orchestrator
 * placed libevent-2.1.so.7 here and verified the binary runs, but ONLY with
 * LD_LIBRARY_PATH pointed at this directory — the binary carries no RUNPATH).
 * Same layout getTorBinaryPath() (src/core/transport/tor-manager.ts) resolves
 * to for an unpacked/dev-mode app (isPackaged === false, which is how the e2e
 * suite always runs — see electron.ts's dist-electron launch).
 */
const TOR_DIR = path.join(repoRoot, 'resources', 'tor', 'linux-x64');
const TOR_BINARY_PATH = path.join(TOR_DIR, 'tor');
const TOR_LIBEVENT_PATH = path.join(TOR_DIR, 'libevent-2.1.so.7');

/**
 * Whether this machine's architecture has a bundled Tor at all. Upstream
 * publishes no linux-aarch64 Tor Expert Bundle (see resources/tor/README.md), so
 * on arm64 there is nothing to download and nothing for the Tor specs to
 * exercise — they skip instead of failing on a file that cannot exist.
 */
export const BUNDLED_TOR_AVAILABLE_FOR_ARCH = process.arch === 'x64';

/**
 * Fails fast with clear setup instructions (mirrors electron.ts's dist-electron
 * missing-build check) rather than let a spawn() silently hang or crash deep
 * inside a test. Deliberately does NOT attempt to download anything — the
 * bundled Tor binary and its libevent are already in place per tonight's
 * groundwork; a missing file here means the environment regressed, not that
 * this helper should self-heal it.
 */
function ensureTorResourcesAvailable(): void {
    if (!BUNDLED_TOR_AVAILABLE_FOR_ARCH) {
        throw new Error(
            `No bundled Tor exists for linux-${process.arch} — upstream ships no aarch64 Linux ` +
            'Tor Expert Bundle, so "npm run download:tor" cannot fetch one. These specs should ' +
            'have been skipped via BUNDLED_TOR_AVAILABLE_FOR_ARCH before reaching this helper.',
        );
    }
    if (!existsSync(TOR_BINARY_PATH)) {
        throw new Error(
            `Bundled tor binary not found at ${TOR_BINARY_PATH}. Run "npm run download:tor" ` +
            '(or "npm run setup") to fetch it before running tor-mode.spec.ts.',
        );
    }
    if (!existsSync(TOR_LIBEVENT_PATH)) {
        throw new Error(
            `Bundled libevent not found at ${TOR_LIBEVENT_PATH}. The tor binary in this repo has no ` +
            'RUNPATH and will fail to start without it sitting alongside the binary — see this file\'s ' +
            'header comment for the groundwork that placed it there.',
        );
    }
}

/** Kills a spawned Tor child process, escalating to SIGKILL if it doesn't exit gracefully. */
async function stopTorProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    await new Promise<void>((resolve) => {
        const timeoutId = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
        }, 5_000);
        child.once('exit', () => {
            clearTimeout(timeoutId);
            resolve();
        });
        child.kill('SIGTERM');
    });
}

async function waitForHostnameFile(hostnamePath: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(hostnamePath)) {
            const content = await readFile(hostnamePath, 'utf-8');
            if (content.trim().length > 0) {
                return content.trim();
            }
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`Timed out waiting for onion hostname file at ${hostnamePath}`);
}

export interface OnionFrontedBootstrap {
    /** Real onion multiaddr dialable over the live Tor network: /onion3/<host>:9000/p2p/<peerId>. */
    multiaddr: string;
    /** The bare 56-char base32 onion host (no .onion suffix, no port/p2p suffix). */
    onionHost: string;
    /** Stops the fronting Tor daemon AND the underlying bootstrap-node.ts process, and cleans up scratch dirs. */
    stop(): Promise<void>;
}

/**
 * The "onion-fronted local bootstrap" design: a plain-TCP bootstrap-node.ts
 * instance (see bootstrap-node.ts) with our OWN Tor daemon (the same bundled
 * binary the app uses) running a hidden service in front of it. Anonymous-mode
 * app instances only ever accept /onion3/... bootstrap addresses
 * (filterBootstrapAddressesForMode, src/core/network/node-bootstrap.ts:71-78
 * — non-onion addresses are silently dropped), so a plain local bootstrap is
 * useless to them as-is; fronting it with a real onion service makes it
 * dialable over the real Tor network, giving the e2e suite full lifecycle
 * control over the bootstrap (like every other local-bootstrap round) while
 * still exercising a genuine onion dial end to end.
 *
 * Orchestrator-verified tonight: this exact torrc shape (SocksPort 0,
 * ControlPort 0, a chmod-700 HiddenServiceDir, HiddenServicePort 9000 ->
 * 127.0.0.1:<bootstrap tcp port>) reaches "Bootstrapped 100%" and mints a
 * working hidden service from this box in well under a minute.
 *
 * CRITICAL, empirically-found ordering requirement (code-confirmed root
 * cause, not just "slow"): src/core/bootstrap.ts defaults
 * BOOTSTRAP_NETWORK_MODE to 'fast' when unset. Fast and anonymous mode use
 * completely different DHT protocol string prefixes (NETWORK_MODE_CONFIG,
 * src/core/constants.ts:66-67 — `/kiyeovo-fast/1.0.0/dht` vs.
 * `/kiyeovo/1.0.0/dht`), not just different validators, so a plain
 * fast-mode bootstrap process cannot negotiate the DHT protocol with an
 * anonymous-mode app at all: every `dht.put()`/`dht.get()` against it fails
 * with a raw QUERY_ERROR (surfaced to the user as "Username registration
 * failed: all N peers unreachable"), even though the plain libp2p connect
 * (no protocol negotiation needed) succeeds fine and the wizard's Bootstrap
 * step happily reports "connected". This function therefore starts the
 * FRONTING TOR FIRST (the onion hostname needs no backend listening yet —
 * Tor mints the hidden-service descriptor independent of whether anything
 * is behind it), then starts src/core/bootstrap.ts itself with
 * BOOTSTRAP_NETWORK_MODE=anonymous and BOOTSTRAP_ANNOUNCE_ADDRS pointed at
 * that onion host (bare `/onion3/<host>:9000`, no `/p2p/...` suffix — same
 * derivation doc-confirmed at Kiyeovo_desktop_technical_documentation.md
 * line ~916 for the real deployed infra) — a real anonymous-mode DHT server,
 * not a fast-mode one merely reachable over Tor.
 */
export async function startOnionFrontedBootstrap(
    options: { bootstrapPort?: number; torBootstrapTimeoutMs?: number } = {},
): Promise<OnionFrontedBootstrap> {
    ensureTorResourcesAvailable();
    const bootstrapPort = options.bootstrapPort ?? 20421;
    const torBootstrapTimeoutMs = options.torBootstrapTimeoutMs ?? 90_000;

    const scratchDir = await mkdtemp(path.join(tmpdir(), 'kiyeovo-e2e-onion-front-'));
    const dataDir = path.join(scratchDir, 'data');
    const hsDir = path.join(scratchDir, 'hs');
    await mkdir(dataDir, { recursive: true });
    await mkdir(hsDir, { recursive: true, mode: 0o700 });

    const torrcPath = path.join(scratchDir, 'torrc');
    const torrcContent = [
        '# Fronting tor for e2e/tor.ts onion-fronted local bootstrap',
        'SocksPort 0',
        'ControlPort 0',
        `DataDirectory ${dataDir}`,
        `HiddenServiceDir ${hsDir}`,
        `HiddenServicePort 9000 127.0.0.1:${bootstrapPort}`,
        'Log notice stdout',
    ].join('\n') + '\n';
    await writeFile(torrcPath, torrcContent);

    const torProcess: ChildProcessWithoutNullStreams = spawn(TOR_BINARY_PATH, ['-f', torrcPath], {
        cwd: repoRoot,
        env: {
            ...process.env,
            LD_LIBRARY_PATH: TOR_DIR,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    try {
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (fn: () => void) => {
                if (settled) return;
                settled = true;
                fn();
            };

            const timeoutId = setTimeout(() => {
                finish(() => reject(new Error(
                    `Fronting tor did not reach "Bootstrapped 100%" within ${torBootstrapTimeoutMs}ms.\n` +
                    `--- fronting tor output ---\n${output}`,
                )));
            }, torBootstrapTimeoutMs);

            const onData = (chunk: Buffer) => {
                output += chunk.toString();
                if (/Bootstrapped 100%/.test(output)) {
                    clearTimeout(timeoutId);
                    finish(resolve);
                }
            };

            torProcess.stdout.on('data', onData);
            torProcess.stderr.on('data', onData);
            torProcess.on('error', (error) => {
                clearTimeout(timeoutId);
                finish(() => reject(new Error(`Failed to spawn fronting tor: ${error.message}`)));
            });
            torProcess.on('exit', (code, signal) => {
                clearTimeout(timeoutId);
                finish(() => reject(new Error(
                    `Fronting tor exited early (code=${String(code)}, signal=${String(signal)})\n` +
                    `--- fronting tor output ---\n${output}`,
                )));
            });
        });
    } catch (error) {
        await stopTorProcess(torProcess);
        await rm(scratchDir, { recursive: true, force: true });
        throw error;
    }

    let onionHost: string;
    try {
        const hostnamePath = path.join(hsDir, 'hostname');
        // The descriptor file can land a beat after "Bootstrapped 100%" —
        // orchestrator's probe observed it well within a minute; 30s is
        // generous headroom without approaching this test's own budget.
        const hostname = await waitForHostnameFile(hostnamePath, 30_000);
        onionHost = hostname.replace(/\.onion$/, '');
        if (!/^[a-z2-7]{56}$/.test(onionHost)) {
            throw new Error(`Unexpected onion hostname format read from ${hostnamePath}: "${hostname}"`);
        }
    } catch (error) {
        await stopTorProcess(torProcess);
        await rm(scratchDir, { recursive: true, force: true });
        throw error;
    }

    // NOW start the actual bootstrap-node.ts process, in genuine anonymous
    // mode, self-announcing the onion address we just minted — see this
    // function's doc comment for why plain/default (fast-mode) would silently
    // break every DHT operation despite a successful plain connect.
    let bootstrapNode: BootstrapNode;
    try {
        bootstrapNode = await startBootstrapNode({
            port: bootstrapPort,
            env: {
                BOOTSTRAP_NETWORK_MODE: 'anonymous',
                BOOTSTRAP_ANNOUNCE_ADDRS: `/onion3/${onionHost}:9000`,
            },
        });
    } catch (error) {
        await stopTorProcess(torProcess);
        await rm(scratchDir, { recursive: true, force: true });
        throw error;
    }

    const bootstrapPeerId = bootstrapNode.multiaddr.match(/\/p2p\/(\S+)$/)?.[1];
    if (!bootstrapPeerId) {
        await bootstrapNode.stop();
        await stopTorProcess(torProcess);
        await rm(scratchDir, { recursive: true, force: true });
        throw new Error(`Could not parse peer ID out of bootstrap multiaddr: ${bootstrapNode.multiaddr}`);
    }

    const clientMultiaddr = `/onion3/${onionHost}:9000/p2p/${bootstrapPeerId}`;
    console.log(`[tor] onion-fronted bootstrap ready (anonymous mode, genuine DHT protocol match): ${clientMultiaddr}`);

    return {
        multiaddr: clientMultiaddr,
        onionHost,
        stop: async () => {
            await bootstrapNode.stop();
            await stopTorProcess(torProcess);
            await rm(scratchDir, { recursive: true, force: true });
        },
    };
}

/**
 * Ports a single anonymous-mode app instance needs, all overridable via env
 * (see e2e/electron.ts's launchApp and src/electron/main.ts's
 * KIYEOVO_TOR_SOCKS_PORT/KIYEOVO_TOR_CONTROL_PORT — commit 1c9298e). Each
 * concurrently-running anonymous instance needs its own disjoint pair, same
 * idiom as KIYEOVO_P2P_PORT.
 */
export interface AnonymousAppPorts {
    p2pPort: number;
    torSocksPort: number;
    torControlPort: number;
}

/**
 * Builds the env overlay that makes a launchApp() instance run its OWN
 * bundled Tor daemon on the given ports, using the same LD_LIBRARY_PATH
 * workaround the fronting tor above needs. TorManager (src/core/transport/
 * tor-manager.ts) spawns the bundled binary with no explicit `env` override of
 * its own, so it inherits whatever the Electron main process's env is — which
 * is exactly the env launchApp({ env }) merges in on top of process.env.
 */
export function anonymousAppEnv(ports: AnonymousAppPorts): Record<string, string> {
    ensureTorResourcesAvailable();
    return {
        LD_LIBRARY_PATH: TOR_DIR,
        KIYEOVO_TOR_SOCKS_PORT: String(ports.torSocksPort),
        KIYEOVO_TOR_CONTROL_PORT: String(ports.torControlPort),
    };
}

/** launchApp() with the anonymous-mode Tor env overlay pre-applied. */
export async function launchAnonymousApp(
    ports: AnonymousAppPorts,
    extra: Omit<LaunchAppOptions, 'p2pPort' | 'env'> & { env?: Record<string, string> } = {},
): Promise<LaunchedApp> {
    const { env, ...rest } = extra;
    return launchApp({
        ...rest,
        p2pPort: ports.p2pPort,
        env: { ...anonymousAppEnv(ports), ...(env ?? {}) },
    });
}

/**
 * Clicks "Retry connection" and waits for its own busy state to clear, tuned
 * for anonymous mode's much larger dial budget (anonymous-mode-startup-fix.md:
 * ANONYMOUS_BOOTSTRAP_BATCH_TIMEOUT_MS/ANONYMOUS_BOOTSTRAP_ADDRESS_TIMEOUT_MS
 * are both 20s, and a cold onion dial routinely needs 10-20s on top of that —
 * onboard.ts's fast-mode-tuned clickRetryBootstrapConnection only allows 20s
 * for the same wait, too tight to reuse here without risking a false-negative
 * timeout on a real, still-in-flight cold dial).
 */
async function clickRetryBootstrapConnectionAnonymous(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Retry connection' }).click();
    // anonymous-mode-startup-fix.md's own worst-case arithmetic: 3 batches x
    // ANONYMOUS_BOOTSTRAP_BATCH_TIMEOUT_MS(20s) + 5s buffer = 65s is the
    // dial's OWN internal ceiling before it gives up — the button's busy
    // state can legitimately stay up that whole time, so this wait must
    // exceed 65s or it risks a false-negative Playwright timeout on a dial
    // that is still genuinely in flight, not stuck.
    await expect(page.getByRole('button', { name: 'Retrying…' })).toBeHidden({ timeout: 70_000 });
}

/**
 * Anonymous-mode counterpart to onboard.ts's waitForRealDhtConnection: same
 * "retry, then poll the real (not ping-based) DHT connectivity status" shape,
 * but with settle windows sized for onion dials instead of loopback/WAN TCP.
 */
export async function waitForRealDhtConnectionAnonymous(page: Page, attempts = 4): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        await clickRetryBootstrapConnectionAnonymous(page);

        try {
            // eslint-disable-next-line no-await-in-loop
            await expect.poll(async () => {
                const connected = await getDhtConnected(page);
                return connected ?? 'error';
            }, { timeout: 20_000, intervals: [4_000] }).toBe(true);
            return;
        } catch {
            // Not connected yet within this attempt's settle window — loop and retry.
        }
    }
    throw new Error('Anonymous bootstrap never reported real DHT connectivity after repeated retries (onion dial)');
}

/**
 * Anonymous-mode Bootstrap wizard step: single onion multiaddr, generous
 * onion-dial-aware retry budget. Exported (unlike onboard.ts's private
 * fast-mode equivalent) so tor-mode.spec.ts's T1 can insert the
 * assertAnonymousWizardStepsOnly() mode-gating check between this step and
 * the Register step, the same fine-grained-control pattern
 * network-edges.spec.ts uses for its manually-composed scenarios.
 */
export async function completeAnonymousBootstrapStep(page: Page, onionMultiaddr: string): Promise<void> {
    await expect(page.getByRole('heading', { name: 'Bootstrap servers' })).toBeVisible({ timeout: 15_000 });
    await addBootstrapServer(page, onionMultiaddr);
    await waitForRealDhtConnectionAnonymous(page);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
}

/**
 * Mode-gating assertion (T1's core claim): the anonymous wizard
 * (InitialSetupWizard.tsx's ANONYMOUS_STEPS) has ONLY Bootstrap and Register
 * steps — no Relay, no Calls/ICE. Each step nav button's accessible name is
 * `${step.title} setup${...}` (InitialSetupWizard.tsx line ~243), so absence
 * of a "Relay setup"/"Calls setup" button is a direct, code-traceable check
 * that the fast-only steps never render in anonymous mode, not an inference
 * from timing or copy elsewhere.
 */
export async function assertAnonymousWizardStepsOnly(page: Page): Promise<void> {
    await expect(page.getByRole('button', { name: /Bootstrap setup/ })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /Register setup/ })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /Relay setup/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Calls setup/ })).toHaveCount(0);
}

/**
 * Clicks whichever top-nav continue-ish button the wizard is currently
 * showing. Register is the LAST step in ANONYMOUS_STEPS (InitialSetupWizard.tsx
 * — unlike fast mode, where an ICE step always follows it), so its own
 * continueLabel computation (InitialSetupWizard.tsx's `continueLabel`) reads
 * "Finish setup" once registered, or "Finish without registering" if skipped
 * — never "Continue", which onboard.ts's fast-mode-shaped
 * completeRegisterStep/handleContinue callers hardcode. Either label still
 * just calls the same handleContinue() -> setShowingReady(true) transition
 * (code-confirmed), so clicking whichever is present is safe and correct.
 */
async function clickWizardContinueOrFinish(page: Page): Promise<void> {
    await page.getByRole('button', { name: /^(Continue|Finish setup|Finish without registering)$/ }).click();
}

/**
 * Anonymous-mode counterpart to onboard.ts's completeRegisterStep. Same
 * registration flow/retry shape, but ends with clickWizardContinueOrFinish()
 * instead of a hardcoded "Continue" click — see that helper's doc comment.
 * Register-over-Tor observed at ~10-40s per run (real DHT PUT round trip
 * over onion circuits, plus the DHT-protocol fix in
 * startOnionFrontedBootstrap), so the retry loop's budget is left generous
 * (180s) without being maximally paranoid.
 */
export async function completeAnonymousRegisterStep(page: Page, username: string): Promise<void> {
    await expect(page.getByRole('heading', { name: 'Register a username' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Register username' }).click();
    await expect(page.getByRole('heading', { name: 'Register Identity' })).toBeVisible({ timeout: 15_000 });
    await page.getByPlaceholder('Enter username...').fill(username);

    const rememberMeCheckbox = page.getByRole('checkbox', { name: /Auto-register on startup/ });
    if (await rememberMeCheckbox.isChecked()) {
        await rememberMeCheckbox.uncheck();
    }

    await expect(async () => {
        const dialogStillOpen = await page.getByRole('heading', { name: 'Register Identity' })
            .isVisible()
            .catch(() => false);
        if (dialogStillOpen) {
            await page.getByRole('button', { name: 'Register', exact: true }).click();
        }
        await expect(page.getByRole('heading', { name: 'Register Identity' })).toBeHidden({ timeout: 45_000 });
    }).toPass({ timeout: 180_000, intervals: [3_000] });

    await clickWizardContinueOrFinish(page);
}

/**
 * Full anonymous-mode onboard: Network Mode -> Anonymous (Tor), identity
 * creation (gated behind the app's own Tor daemon bootstrapping — see
 * beginIdentityCreation's mode-aware timeout), recovery-phrase ack, guided
 * wizard's Bootstrap step (single onion multiaddr) then optional Register
 * step, "Finish setup" -> "Start chatting". Unlike onboard.ts's fast-mode
 * onboard(), there is no Relay or ICE step at all (ANONYMOUS_STEPS,
 * InitialSetupWizard.tsx) — code-confirmed, also asserted directly by
 * assertAnonymousWizardStepsOnly() in tor-mode.spec.ts's T1.
 */
export async function onboardAnonymous(
    page: Page,
    options: { password: string; username?: string; bootstrapMultiaddr: string },
): Promise<{ peerId: string }> {
    const { password, username, bootstrapMultiaddr } = options;
    const label = username ?? 'anon';
    const onboardStart = Date.now();

    await page.waitForLoadState('domcontentloaded');

    await timedStage(label, 'network_mode+tor_start+identity+recovery', () => (
        beginIdentityCreation(page, password, { mode: 'anonymous' })
    ));

    await timedStage(label, 'bootstrap_onion', () => completeAnonymousBootstrapStep(page, bootstrapMultiaddr));

    if (username) {
        await timedStage(label, 'register', () => completeAnonymousRegisterStep(page, username));
    } else {
        // Register is optional (WizardRegisterStep). Since it's also the LAST
        // step in ANONYMOUS_STEPS, skipping it shows "Finish without
        // registering" rather than "Continue" — see
        // clickWizardContinueOrFinish's doc comment.
        await timedStage(label, 'skip_register', () => clickWizardContinueOrFinish(page));
    }

    await timedStage(label, 'finish_wizard', () => finishWizard(page));

    const peerId = await readPeerId(page);
    console.log(`[timing][${label}] TOTAL onboardAnonymous(): ${((Date.now() - onboardStart) / 1000).toFixed(1)}s`);
    return { peerId };
}
