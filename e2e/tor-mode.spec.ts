import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { type LaunchedApp } from './electron';
import {
    startOnionFrontedBootstrap,
    launchAnonymousApp,
    completeAnonymousBootstrapStep,
    completeAnonymousRegisterStep,
    assertAnonymousWizardStepsOnly,
    onboardAnonymous,
    BUNDLED_TOR_AVAILABLE_FOR_ARCH,
    type OnionFrontedBootstrap,
} from './tor';
import {
    beginIdentityCreation,
    finishWizard,
    getDhtConnected,
    readPeerId,
    sendContactRequest,
    acceptContactRequest,
    sendChatMessage,
    timedStage,
} from './onboard';
import { uniqueRunSuffix } from './config';

// Round 6 of e2e/test-roadmap.md: Tor / anonymous mode. Marin gave the
// go-ahead the night of 2026-07-06/07 after the groundwork below was
// verified: the bundled tor binary (resources/tor/linux-x64/tor, Tor
// 0.4.8.13) runs on this box ONLY with LD_LIBRARY_PATH pointed at that same
// directory (the binary carries no RUNPATH; libevent-2.1.so.7 was placed
// there as part of this round's setup), and a probe reached
// "Bootstrapped 100%" and minted a working hidden service in well under a
// minute — real Tor network reachability, not a mock. New env overrides
// KIYEOVO_TOR_SOCKS_PORT/KIYEOVO_TOR_CONTROL_PORT (commit 1c9298e, already in
// the built dist-electron this suite launches) let two anonymous-mode
// instances run concurrently on one host without colliding on the bundled
// Tor daemon's own ports, the same idiom as KIYEOVO_P2P_PORT.
//
// Anonymous mode has no real bootstrap infra of its own reachable from this
// box (unlike Fast mode's real deployed bootstrap/relay/STUN, see
// e2e/config.ts) and, per src/core/network/node-bootstrap.ts's
// filterBootstrapAddressesForMode (code-confirmed, lines 74-90), only accepts
// /onion3/... bootstrap addresses at all — every other address format is
// silently dropped. e2e/tor.ts's startOnionFrontedBootstrap() therefore fronts
// a throwaway local bootstrap-node.ts instance with our OWN Tor hidden
// service, giving this file the same full lifecycle control over its
// bootstrap that every other local-bootstrap round has, while still routing
// every dial over the real Tor network end to end.
//
// TIMEOUT EXCEPTION (orchestrator-granted for this round only, see the task
// brief): Tor is legitimately slow — daemon bootstrap + hidden-service
// descriptor publish ~30-60s per instance, cold onion dials 10-20s each,
// everything over real circuits, and every anonymous-mode instance in this
// file runs its OWN Tor daemon (on top of the fronting one for the
// bootstrap). test.setTimeout is raised to 12 minutes here (vs. the roadmap's
// normal 6-minute cap) specifically to cover that. Per-stage timing logs
// (timedStage, onboard.ts) are used throughout so a slow run can be diagnosed
// from console output alone rather than guessed at.
//
// T3 (returning-user relaunch over Tor) is INTENTIONALLY OMITTED this round:
// T1 and T2 alone already spend a large fraction of the granted 12-minute
// budget per test on Tor daemon bootstraps (each anonymous instance pays that
// cost from a cold start, and a relaunch pays it again), and the marginal
// coverage over offline-delivery.spec.ts's already-proven fast-mode
// relaunch/reconnect pattern is comparatively low. Left as a documented
// follow-up rather than a padded, rushed addition.
test.setTimeout(12 * 60_000);

// arm64 Linux ships no bundled Tor (upstream publishes no linux-aarch64 expert
// bundle — see resources/tor/README.md), so anonymous mode does not exist there
// to test. Skip rather than fail: on those machines this is the app behaving as
// designed, not a broken environment.
test.skip(
    !BUNDLED_TOR_AVAILABLE_FOR_ARCH,
    `no bundled Tor for linux-${process.arch}; anonymous mode is unavailable on this architecture`,
);

const PASSWORD = 'Correct-Horse-Battery-Staple9!';

/** Locator for a message *bubble* in the currently open chat (see two-peer.spec.ts's identical helper for why this is scoped to [data-message-bubble]). */
function chatMessage(page: Page, text: string) {
    return page.locator('[data-message-bubble]').getByText(text);
}

async function attach(testInfo: TestInfo, page: Page, name: string) {
    const screenshotPath = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' });
}

async function attachLogs(testInfo: TestInfo, peer: LaunchedApp | undefined, name: string) {
    if (!peer) return;
    await testInfo.attach(name, { body: peer.logs.join(''), contentType: 'text/plain' });
}

// ---------------------------------------------------------------------------
// T1. Anonymous onboarding, single instance.
// ---------------------------------------------------------------------------
test('anonymous mode: tor daemon starts, wizard is bootstrap+register only, and registration succeeds over the Tor DHT @slow', async () => {
    const testInfo = test.info();
    const testStart = Date.now();
    let onionBootstrap: OnionFrontedBootstrap | undefined;
    let peer: LaunchedApp | undefined;
    let failed = false;
    const username = `tor_t1_${uniqueRunSuffix()}`;

    try {
        onionBootstrap = await timedStage('t1', 'start_onion_fronted_bootstrap', () => startOnionFrontedBootstrap({ bootstrapPort: 20421 }));

        peer = await timedStage('t1', 'launch_app', () => launchAnonymousApp({
            p2pPort: 9191,
            torSocksPort: 9561,
            torControlPort: 9562,
        }));
        const { page } = peer;
        await page.waitForLoadState('domcontentloaded');

        // --- Network mode -> Anonymous, identity creation gated behind the
        // app's own Tor daemon bootstrapping (see beginIdentityCreation's
        // mode-aware timeout in onboard.ts). ---
        await timedStage('t1', 'network_mode_tor_start_identity_recovery', () => (
            beginIdentityCreation(page, PASSWORD, { mode: 'anonymous' })
        ));
        await attach(testInfo, page, 't1-01-identity-created');

        // --- Mode-gating assertion: the wizard has ONLY Bootstrap + Register,
        // never Relay or Calls/ICE (ANONYMOUS_STEPS, InitialSetupWizard.tsx). ---
        await expect(page.getByRole('heading', { name: 'Bootstrap servers' })).toBeVisible({ timeout: 15_000 });
        await timedStage('t1', 'assert_wizard_steps_bootstrap_and_register_only', () => assertAnonymousWizardStepsOnly(page));
        await attach(testInfo, page, 't1-02-wizard-bootstrap-only-steps');

        // --- Bootstrap step: single real onion multiaddr, real Tor network dial. ---
        await timedStage('t1', 'bootstrap_onion_dial', () => completeAnonymousBootstrapStep(page, onionBootstrap!.multiaddr));
        expect(await getDhtConnected(page)).toBe(true);
        await attach(testInfo, page, 't1-03-onion-bootstrap-connected');

        // Re-assert the step-nav absence from the Register step too — belt
        // and suspenders that navigating within the wizard never reveals a
        // hidden Relay/Calls step.
        await expect(page.getByRole('heading', { name: 'Register a username' })).toBeVisible({ timeout: 15_000 });
        await timedStage('t1', 'assert_wizard_steps_still_bootstrap_and_register_only', () => assertAnonymousWizardStepsOnly(page));

        // --- Register a username over the Tor DHT. ---
        await timedStage('t1', 'register_over_tor_dht', () => completeAnonymousRegisterStep(page, username));
        await timedStage('t1', 'finish_wizard', () => finishWizard(page));

        const peerId = await readPeerId(page);
        expect(peerId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20,}$/);
        await attach(testInfo, page, 't1-04-registered-main-ui');

        const userState = await page.evaluate(() => window.kiyeovoAPI.getUserState());
        expect(userState.isRegistered).toBe(true);
        expect(userState.username).toBe(username);
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][t1] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) await attachLogs(testInfo, peer, 't1-main-process-logs');
        await peer?.close().catch((error) => console.error('Failed to close peer:', error));
        await onionBootstrap?.stop().catch((error) => console.error('Failed to stop onion-fronted bootstrap:', error));
    }
});

// ---------------------------------------------------------------------------
// T2. Two-instance messaging over Tor (strategic goal).
// ---------------------------------------------------------------------------
test('two anonymous-mode peers connect over Tor, exchange a contact request by username, message both ways, and hide the call button @slow', async () => {
    const testInfo = test.info();
    const testStart = Date.now();
    let onionBootstrap: OnionFrontedBootstrap | undefined;
    let peerA: LaunchedApp | undefined;
    let peerB: LaunchedApp | undefined;
    let failed = false;

    const runSuffix = uniqueRunSuffix();
    const usernameA = `tor_a_${runSuffix}`;
    const usernameB = `tor_b_${runSuffix}`;

    try {
        onionBootstrap = await timedStage('t2', 'start_onion_fronted_bootstrap', () => startOnionFrontedBootstrap({ bootstrapPort: 20422 }));

        // Launch + onboard both instances in parallel so their Tor daemon
        // bootstraps overlap instead of paying the cost twice sequentially
        // (same idiom as two-peer.spec.ts's Promise.all).
        [peerA, peerB] = await timedStage('t2', 'launch_both_apps', () => Promise.all([
            launchAnonymousApp({ p2pPort: 9192, torSocksPort: 9561, torControlPort: 9562 }),
            launchAnonymousApp({ p2pPort: 9193, torSocksPort: 9563, torControlPort: 9564 }),
        ]));
        const { page: pageA } = peerA;
        const { page: pageB } = peerB;

        const [{ peerId: peerIdA }, { peerId: peerIdB }] = await timedStage('t2', 'onboard_both_peers_anonymous', () => Promise.all([
            onboardAnonymous(pageA, { password: PASSWORD, username: usernameA, bootstrapMultiaddr: onionBootstrap!.multiaddr }),
            onboardAnonymous(pageB, { password: PASSWORD, username: usernameB, bootstrapMultiaddr: onionBootstrap!.multiaddr }),
        ]));
        expect(peerIdA).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20,}$/);
        expect(peerIdB).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20,}$/);
        expect(peerIdA).not.toBe(peerIdB);
        await attach(testInfo, pageA, 't2-01-a-onboarded');
        await attach(testInfo, pageB, 't2-02-b-onboarded');

        // --- B looks A up by USERNAME (DHT lookup over Tor), not peer ID —
        // the real-world anonymous-mode contact flow. ---
        const firstMessage = 'Hi — found you over Tor!';
        await timedStage('t2', 'contact_request_by_username_over_tor', async () => {
            // A peer-to-peer onion rendezvous (B's node dialing A's onion
            // service directly, for the very first time) is the slowest kind
            // of Tor connection — descriptor fetch + introduction + rendezvous
            // circuits routinely take 30-90s, well past sendContactRequest's
            // fast-mode-tuned defaults (45s/100s). Generous anonymous budget:
            // 90s per attempt, 4 minutes total.
            await sendContactRequest(pageB, usernameA, firstMessage, {
                perAttemptTimeoutMs: 90_000,
                totalTimeoutMs: 240_000,
            });
            await expect(pageA.getByText(usernameB, { exact: true })).toBeVisible({ timeout: 30_000 });
            await acceptContactRequest(pageA, usernameB);
        });
        await attach(testInfo, pageB, 't2-03-b-sent-contact-request');
        await attach(testInfo, pageA, 't2-04-a-accepted');

        // Key exchange over onion circuits completes (anonymous-mode
        // follow-up timeout is 45s — KEY_EXCHANGE_FOLLOWUP_TIMEOUT_ANONYMOUS_MS,
        // src/core/constants.ts:327, code-confirmed).
        await timedStage('t2', 'first_message_visible_both_sides', () => Promise.all([
            expect(chatMessage(pageA, firstMessage)).toBeVisible({ timeout: 45_000 }),
            expect(chatMessage(pageB, firstMessage)).toBeVisible({ timeout: 45_000 }),
        ]));
        await attach(testInfo, pageA, 't2-05-a-chat-active');
        await attach(testInfo, pageB, 't2-06-b-chat-active');

        // --- A replies ---
        const replyMessage = 'Confirmed — this is Alice, over Tor.';
        await timedStage('t2', 'a_reply', async () => {
            await sendChatMessage(pageA, replyMessage);
            await expect(chatMessage(pageB, replyMessage)).toBeVisible({ timeout: 45_000 });
        });
        await attach(testInfo, pageB, 't2-07-b-received-reply');

        // --- Mode-gating assertion: the call button is entirely ABSENT in
        // this direct chat header. ChatHeader.tsx: `canShowCallButtons =
        // !isGroup && networkMode === 'fast'` (code-confirmed) — in
        // fast-mode chats (two-peer.spec.ts / calls.spec.ts) the same
        // icon-only button (its `title` attribute IS its accessible name,
        // per calls.spec.ts's callButton() helper) IS present; that contrast
        // is the assertion here. ---
        await timedStage('t2', 'assert_call_button_absent_in_anonymous_chat', async () => {
            await expect(pageA.getByRole('button', { name: 'Start call', exact: true })).toHaveCount(0);
            await expect(pageB.getByRole('button', { name: 'Start call', exact: true })).toHaveCount(0);
        });
        await attach(testInfo, pageA, 't2-08-a-no-call-button');
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][t2] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) {
            await attachLogs(testInfo, peerA, 't2-a-main-process-logs');
            await attachLogs(testInfo, peerB, 't2-b-main-process-logs');
        }
        await peerA?.close().catch((error) => console.error('Failed to close peer A:', error));
        await peerB?.close().catch((error) => console.error('Failed to close peer B:', error));
        await onionBootstrap?.stop().catch((error) => console.error('Failed to stop onion-fronted bootstrap:', error));
    }
});
