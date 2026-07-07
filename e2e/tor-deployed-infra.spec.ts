import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { type LaunchedApp } from './electron';
import { launchAnonymousApp, completeAnonymousRegisterStep } from './tor';
import { beginIdentityCreation, addBootstrapServer, getDhtConnected, finishWizard, readPeerId, timedStage } from './onboard';
import { ONION_BOOTSTRAP_MULTIADDR, uniqueRunSuffix } from './config';

// Round 9 of e2e/test-roadmap.md: the deploy-verification gate for the REAL,
// operator-deployed anonymous-mode onion bootstrap (distinct from
// tor-groups.spec.ts / tor-mode.spec.ts / trusted-import.spec.ts's S3, which
// all target a THROWAWAY local bootstrap fronted by this suite's own Tor
// daemon, per e2e/tor.ts's startOnionFrontedBootstrap). This file exists to
// answer one question a local-only Tor test cannot: does the real deployed
// server actually speak the anonymous DHT protocol namespace end to end
// (`/kiyeovo/1.0.0/dht`, NETWORK_MODE_CONFIG — src/core/constants.ts:66-67,
// code-confirmed) over a genuine, cold, real-world onion circuit — not just
// "is Tor reachable from this box" (already proven by every other Tor round).
//
// MANDATORY READING done before writing anything below:
// Kiyeovo_desktop_technical_documentation.md section 11.9 (doc-confirmed:
// "Anonymous mode is structurally different from Fast mode: a Tor
// hidden-service container fronts a single bootstrap node. There is NO
// RELAY, and nothing is published on the host — clients reach the bootstrap
// only via its .onion" — so this test's one instance never touches a relay
// or STUN/ICE step at all, matching tor-mode.spec.ts's T1
// assertAnonymousWizardStepsOnly finding); e2e/tor.ts (doc comments on
// startOnionFrontedBootstrap explain the KNOWN failure mode this test exists
// to rule out for the real deployment: a bootstrap process speaking the
// WRONG protocol namespace — fast-mode's `/kiyeovo-fast/1.0.0/dht` instead of
// anonymous's `/kiyeovo/1.0.0/dht` — lets the plain libp2p connect succeed
// ["Bootstrap connected"] while every DHT put/get then fails with a raw
// QUERY_ERROR surfaced as "all N peers unreachable"; a real username
// REGISTRATION succeeding is the strongest available evidence the deployed
// server is genuinely running in anonymous mode, not just Tor-reachable);
// waitForRealDhtConnectionAnonymous's doc comment in e2e/tor.ts (the 65s
// per-"Retry connection"-click internal ceiling: 3 internal dial batches x
// ANONYMOUS_BOOTSTRAP_BATCH_TIMEOUT_MS=20s + 5s buffer — code-confirmed via
// anonymous-mode-startup-fix.md's own arithmetic, referenced there); and
// username-lookup.spec.ts's scenario B / `attemptUsernameLookup` (the
// designed not-found error trace this file's GET-path check reuses the
// SHAPE of, reimplemented locally per this suite's per-file-helpers
// convention — that file's helper is module-private).
//
// --- Scenario (single test, env-gated) ---
// Skipped entirely (via `test.skip(...)` with a clear message, not a bare
// early return) unless KIYEOVO_E2E_ONION_BOOTSTRAP is set — e2e/config.ts's
// new `ONION_BOOTSTRAP_MULTIADDR` export reads it, defaulting to `undefined`.
// The real address lives ONLY in e2e/e2e.env.local (gitignored) or a real env
// var; it is NEVER hardcoded here — unlike BOOTSTRAP_MULTIADDR's committed
// fast-mode default, this identifies a specific operator-run server, not a
// value safe to bake into a public repo.
//
// When set: ONE anonymous-mode instance onboards through the REAL guided
// wizard (Network Mode -> Anonymous, identity creation, Bootstrap step
// pointed at the deployed onion multiaddr, Register step) against the
// deployed infra, using a retry-tolerant, RETRY-COUNTING variant of
// e2e/tor.ts's `waitForRealDhtConnectionAnonymous` (reimplemented locally
// here specifically to report the retry count the task brief asks for,
// without modifying e2e/tor.ts's shared helper's signature for every other
// caller). A successful username registration is a real DHT PUT reaching the
// deployed server's anonymous-protocol namespace — the strongest available
// proof it isn't silently running (or misconfigured into) fast mode. Then ONE
// lookup of a guaranteed-never-registered username proves the GET path
// round-trips too, with the same designed, clean not-found UX
// username-lookup.spec.ts's scenario B already established in the throwaway-
// local-DHT case — this is the first time that GET path is exercised against
// the REAL deployed anonymous DHT.
//
// Timings are logged generously and the retry count is reported explicitly:
// cold first dials to a real, internet-routed onion service (not this
// suite's own throwaway hidden service, which is one hop from the fronting
// Tor daemon on the same box) were observed at 40-70s+ in prior manual
// verification, and the app's own per-address dial timeout is 20s with batch
// retries (ANONYMOUS_BOOTSTRAP_ADDRESS_TIMEOUT_MS /
// ANONYMOUS_BOOTSTRAP_BATCH_TIMEOUT_MS, both 20s per e2e/tor.ts's doc
// comment) — a single "Retry connection" click's OWN internal ceiling is
// already 65s, so most of the "cold dial" latency is typically absorbed
// within just 1-2 outer retries of this test's counted loop, not many.
//
// Isolation: registers a fresh uniqueRunSuffix() username (never collides
// with a prior run's registration on the real, persistent deployed DHT) and
// looks up an equally-unique never-registered name — this test does not
// depend on, and must not disturb, any other test's state on the shared
// deployed infra.
test.setTimeout(12 * 60_000);

const PASSWORD = 'Correct-Horse-Battery-Staple9!';

async function attach(testInfo: TestInfo, page: Page, name: string) {
    const screenshotPath = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' });
}

async function attachLogs(testInfo: TestInfo, peer: LaunchedApp | undefined, name: string) {
    if (!peer) return;
    await testInfo.attach(name, { body: peer.logs.join(''), contentType: 'text/plain' });
}

/**
 * Retry-COUNTING variant of e2e/tor.ts's `completeAnonymousBootstrapStep` +
 * `waitForRealDhtConnectionAnonymous`. Reimplemented locally (rather than
 * changing tor.ts's shared, multi-caller helper's return type) specifically
 * to report the "how many retries did the real deployed cold dial take"
 * metric this round's brief asks for. Same per-click internal ceiling (70s
 * for "Retrying…" to clear — tor.ts's own comment: 3 x 20s dial batches + 5s
 * buffer = 65s worst case) and the same 20s/4s-interval poll for real DHT
 * connectivity after each click, but with an 8-attempt ceiling (vs. tor.ts's
 * default of 4) — generous headroom for a genuinely cold, internet-routed
 * onion service, which is a slower class of dial than this suite's other
 * Tor rounds' one-hop throwaway hidden services.
 */
async function completeAnonymousBootstrapStepAgainstDeployedInfra(
    page: Page,
    onionMultiaddr: string,
    maxAttempts = 8,
): Promise<number> {
    await expect(page.getByRole('heading', { name: 'Bootstrap servers' })).toBeVisible({ timeout: 15_000 });
    await addBootstrapServer(page, onionMultiaddr);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const attemptStart = Date.now();
        await page.getByRole('button', { name: 'Retry connection' }).click();
        await expect(page.getByRole('button', { name: 'Retrying…' })).toBeHidden({ timeout: 70_000 });

        try {
            await expect.poll(async () => {
                const connected = await getDhtConnected(page);
                return connected ?? 'error';
            }, { timeout: 20_000, intervals: [4_000] }).toBe(true);
            console.log(
                `[timing][deployed-infra] bootstrap connected on attempt ${attempt}/${maxAttempts} ` +
                `(this attempt: ${((Date.now() - attemptStart) / 1000).toFixed(1)}s)`,
            );
            await page.getByRole('button', { name: 'Continue', exact: true }).click();
            return attempt;
        } catch {
            console.log(
                `[timing][deployed-infra] attempt ${attempt}/${maxAttempts} did not reach real DHT connectivity ` +
                `within its settle window (${((Date.now() - attemptStart) / 1000).toFixed(1)}s) — retrying`,
            );
        }
    }
    throw new Error(
        `Anonymous bootstrap against the DEPLOYED onion infra never reported real DHT connectivity after ` +
        `${maxAttempts} retries. If main-process logs (DEBUG_MODE) show "all N peers unreachable" despite a ` +
        'successful plain connect, the deployed server may be running in the WRONG DHT protocol mode — see ' +
        'this file\'s header comment and e2e/tor.ts\'s startOnionFrontedBootstrap doc comment for that exact ' +
        'known failure signature.',
    );
}

type LookupOutcome = { outcome: 'success' | 'not_found' | 'timeout'; errorText?: string };

/**
 * Drives one lookup attempt through "New Conversation" and reports which
 * designed terminal state it reached — same SHAPE as
 * username-lookup.spec.ts's `attemptUsernameLookup` (module-private there,
 * reimplemented locally per this suite's convention), deliberately NOT
 * retrying on a 'not_found' result (retrying would paper over the exact
 * "not found" signal this GET-path check needs to observe).
 */
async function attemptUsernameLookup(page: Page, identifier: string, message: string, timeoutMs: number): Promise<LookupOutcome> {
    await page.locator('button:has(svg.lucide-plus)').first().click();
    await page.getByRole('button', { name: 'New Conversation', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New Conversation' })).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder('Enter peer ID or username...').fill(identifier);
    await page.getByPlaceholder('Compose an inital greeting...').fill(message);
    await page.getByRole('button', { name: 'Send' }).click();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const dialogVisible = await page.getByRole('heading', { name: 'New Conversation' }).isVisible().catch(() => false);
        if (!dialogVisible) {
            return { outcome: 'success' };
        }
        const notFoundLocator = page.getByText(/not found/i);
        if (await notFoundLocator.isVisible().catch(() => false)) {
            const errorText = await notFoundLocator.first().textContent().catch(() => null);
            return { outcome: 'not_found', errorText: errorText ?? undefined };
        }
        await page.waitForTimeout(1_000);
    }
    return { outcome: 'timeout' };
}

test('anonymous mode registers a username on the deployed onion bootstrap and looks up a nonexistent one cleanly @slow', async () => {
    test.skip(
        !ONION_BOOTSTRAP_MULTIADDR,
        'KIYEOVO_E2E_ONION_BOOTSTRAP is not set (see e2e/e2e.env.local or a real env var) — ' +
        'skipping the deploy-verification gate against the real deployed anonymous-mode infra.',
    );

    const testInfo = test.info();
    const testStart = Date.now();
    let peer: LaunchedApp | undefined;
    let failed = false;
    const runSuffix = uniqueRunSuffix();
    const username = `torinfra_${runSuffix}`;
    const neverRegistered = `torinfra_never_${runSuffix}`;

    try {
        peer = await timedStage('deployed-infra', 'launch_app', () => launchAnonymousApp({
            p2pPort: 9221,
            torSocksPort: 9581,
            torControlPort: 9582,
        }));
        const { page } = peer;
        await page.waitForLoadState('domcontentloaded');

        // --- Network mode -> Anonymous, identity creation (gated behind this
        // instance's OWN Tor daemon bootstrapping — see beginIdentityCreation's
        // mode-aware timeout in onboard.ts). ---
        await timedStage('deployed-infra', 'network_mode_tor_start_identity_recovery', () => (
            beginIdentityCreation(page, PASSWORD, { mode: 'anonymous' })
        ));
        await attach(testInfo, page, 'deployed-01-identity-created');

        // --- Bootstrap step against the REAL deployed onion multiaddr, using
        // the retry-counting variant above. ---
        const retriesUsed = await timedStage('deployed-infra', 'bootstrap_deployed_onion_dial', () => (
            completeAnonymousBootstrapStepAgainstDeployedInfra(page, ONION_BOOTSTRAP_MULTIADDR!)
        ));
        console.log(`[deployed-infra] cold dial to the deployed onion bootstrap succeeded after ${retriesUsed} "Retry connection" attempt(s)`);
        expect(await getDhtConnected(page)).toBe(true);
        await attach(testInfo, page, 'deployed-02-bootstrap-connected');

        // --- Register a unique username: a successful DHT PUT is the proof
        // the deployed server speaks the anonymous protocol namespace (see
        // file-level comment for the known wrong-mode failure signature this
        // rules out). ---
        await timedStage('deployed-infra', 'register_over_deployed_dht', () => completeAnonymousRegisterStep(page, username));
        await timedStage('deployed-infra', 'finish_wizard', () => finishWizard(page));

        const peerId = await readPeerId(page);
        expect(peerId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20,}$/);
        const userState = await page.evaluate(() => window.kiyeovoAPI.getUserState());
        expect(userState.isRegistered).toBe(true);
        expect(userState.username).toBe(username);
        console.log(`[deployed-infra] registration confirmed: peerId=${peerId} username=${username}`);
        await attach(testInfo, page, 'deployed-03-registered');

        // --- GET path: look up a guaranteed-never-registered username and
        // confirm the clean, designed not-found UX round-trips against the
        // REAL deployed DHT (same designed error text as username-lookup.
        // spec.ts's scenario B, first time exercised against real anonymous
        // infra rather than a throwaway local one). ---
        const lookupResult = await timedStage('deployed-infra', 'lookup_never_registered_on_deployed_dht', () => (
            attemptUsernameLookup(page, neverRegistered, 'anybody home on the real onion infra?', 60_000)
        ));
        console.log(`[deployed-infra] not-found lookup outcome=${lookupResult.outcome} errorText="${lookupResult.errorText ?? '(none)'}"`);
        expect(lookupResult.outcome).toBe('not_found');
        expect(lookupResult.errorText ?? '').toMatch(/not found/i);
        await attach(testInfo, page, 'deployed-04-not-found-lookup');

        // App stays usable after the not-found result — same no-hang check
        // username-lookup.spec.ts's scenario B performs.
        await page.getByRole('button', { name: 'Close', exact: true }).first().click();
        await expect(page.getByRole('heading', { name: 'New Conversation' })).toBeHidden({ timeout: 10_000 });
        await attach(testInfo, page, 'deployed-05-app-still-usable');
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][deployed-infra] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) await attachLogs(testInfo, peer, 'deployed-infra-main-process-logs');
        await peer?.close().catch((error) => console.error('Failed to close peer:', error));
    }
});
