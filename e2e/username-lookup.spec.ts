import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { launchApp, type LaunchedApp } from './electron';
import { startBootstrapNode, type BootstrapNode } from './bootstrap-node';
import {
    onboard,
    beginIdentityCreation,
    addBootstrapServer,
    waitForRealDhtConnection,
    completeRelayStep,
    completeIceStep,
    finishWizard,
    navigateToBootstrapSetup,
    sendContactRequest,
    acceptContactRequest,
    sendChatMessage,
    timedStage,
} from './onboard';
import { BOOTSTRAP_MULTIADDR, RELAY_MULTIADDR, STUN_URL, uniqueRunSuffix } from './config';

// Username-lookup round of e2e/test-roadmap.md. Exercises the DHT
// username-registry lookup surface (src/core/username/username-registry.ts)
// through the real "New Conversation" UI, which is the ONLY renderer-facing
// entry point that resolves a typed username to a peer ID — there is no
// dedicated "search a username" IPC/dialog in the app (grepped
// src/electron/ipc-handlers.ts and src/ui; confirmed absent). Every claim
// below is labeled doc-confirmed / code-confirmed / unverified inline.
//
// Scenario map (target shapes in launch-checklist context vs. what's here):
//   A. Happy-path lookup+contact — LEAN by design. two-peer.spec.ts already
//      covers full bidirectional messaging end to end, but it adds its
//      contact by PEER ID (sendContactRequest(pageA, peerIdB, ...) — see
//      that file's line ~78), never exercising UsernameRegistry.lookup() at
//      all. This test instead has B target A by USERNAME, so the DHT
//      username->peerID resolution path (message-handler.ts's
//      resolveUserRegistrationForSession, code-confirmed at
//      src/core/lib/message-handler.ts:2360-2382) is genuinely exercised —
//      not a duplicate of two-peer's coverage. Kept lean per the task brief:
//      one message each way (not two-peer's three-message battery), plus a
//      code-level check (kiyeovoAPI.getChats()) that the chat B ended up
//      with really points at A's peer ID — the strongest available
//      "resolved profile" evidence, since NewConversationDialog.tsx
//      (code-confirmed read) has no separate lookup-result/profile-preview
//      screen: typing an identifier and hitting Send either closes the
//      dialog (success) or shows an inline error (failure) — nothing in
//      between is rendered.
//   B. Nonexistent username — code-confirmed failure text and no-hang UX
//      (see attemptUsernameLookup's doc comment for the exact error-string
//      trace).
//   C. Duplicate registration — code-confirmed from username-registry.ts's
//      ensureUsernameAvailableForRegistration (throws ERRORS.USERNAME_TAKEN
//      = 'Username already taken' when an active record for a DIFFERENT
//      peerID already exists) and username-dht-validator.ts's
//      usernameRegistrationValidateUpdate (independently enforces the same
//      "owner_mismatch" rule at the DHT-validator level) — this is
//      first-writer-wins, defense-in-depth (app-level pre-check AND
//      DHT-level validator), not a silent overwrite. Real DHT: registers A's
//      name first, then has B attempt the identical name.
//   D. Publish failure surfaced (exercises 7fd7838) — LOCAL bootstrap only,
//      per the task's standing rule. Onboard with registration deferred
//      (the wizard's Register step is `optional: true` in
//      InitialSetupWizard.tsx's FAST_STEPS, so clicking the top-nav
//      "Continue" — not the in-step "Register username" button — advances
//      past it unregistered), then trigger registration via the footer's
//      "Register Identity" CTA (RegisterButton.tsx, rendered by
//      SidebarFooter.tsx whenever `!user.registered`). DEVIATION from the
//      literal "kill bootstrap, THEN attempt registration" task shape,
//      code-confirmed via a throwaway debug run: the app's connectivity
//      check (SidebarHeader.tsx / useDHTConnectionStatus.ts's push-based
//      `onDHTConnectionStatus`) noticed the killed bootstrap and flipped
//      `state.user.connected` to `false` within a few seconds every time,
//      and RegisterDialog.tsx's `formDisabled = dhtOffline ||
//      Boolean(isRegistering)` then disables the ENTIRE form — including
//      the "Register" submit button (`disabled` also requires `dhtReady =
//      isConnected === true`) — so killing the bootstrap first and THEN
//      opening the dialog reliably raced (and lost to) that UI-level gate:
//      the click just hangs on a permanently-disabled button, never
//      reaching the DHT-put codepath (7fd7838) at all. This test instead
//      clicks "Register" while still genuinely connected (button enabled,
//      no race) and kills the bootstrap immediately after — failing the
//      *in-flight* DHT put deterministically instead of racing a UI gate.
//      Notable finding in its own right: "zero peers accepted the publish"
//      (7fd7838) and "network already known to be down, can't even try"
//      are TWO distinct, non-overlapping designed failure surfaces — a real
//      user who waits even a few seconds after their bootstrap dies before
//      hitting Register sees the connectivity gate, never this scenario's
//      publish-failure copy. Failure text is asserted loosely (a
//      case-insensitive keyword set) rather than pinned to one exact
//      string: getPublishFailureError() (username-registry.ts:468-487) has
//      three distinct zero-accept messages depending on whether the DHT
//      walk produced rejections, errors, or neither. Empirically, killing
//      the bootstrap ~tens of milliseconds after the click consistently
//      produced the "rejected by DHT validators (1 peer(s) rejected)"
//      branch (the in-flight PUT's response, read back moments before the
//      peer fully disconnects, didn't echo our value) rather than the
//      "unreachable" branch — both are zero-accept failures, so both are
//      accepted by the loose match; the exact text is logged per-run for
//      the report rather than hard-pinned to this one observed branch.
//   E. Republish on reconnect (exercises 85db62b) — LOCAL bootstraps only.
//      RESHAPED from the originally-planned "kill the bootstrap, wipe its
//      datastore, restart it" design, based on a code-confirmed finding hit
//      while building this test: the app's own regular peers run the DHT
//      in SERVER mode, not client mode (`clientMode: false`,
//      src/core/network/node-factory.ts:306 — confirmed identical to
//      bootstrap.ts's own `clientMode: false`), so in a tiny 3-4-node local
//      network every peer (A, B, and later C too) is itself a potential
//      replica holder for a PUT/GET'd record via ordinary Kademlia
//      replication — wiping only the ONE dedicated bootstrap's on-disk
//      store does NOT reliably remove copies that may have landed on A's
//      or B's own node during the original publish or a prior lookup. A
//      throwaway run of the datastore-wipe design confirmed this
//      empirically: C's lookup still succeeded immediately after the wipe.
//      This is actually a faithful reflection of the real deployed network
//      (many clientMode:false peers all replicate), not a bug — it just
//      means "one bootstrap loses its data" isn't equivalent to "the
//      record is gone from the DHT". The reshaped test instead uses TWO
//      independent, never-federated local bootstrap "segments": A and B
//      onboard against segment 1 and register/look-up normally; C onboards
//      against segment 2 from the very start, so C's inability to see A is
//      guaranteed by construction (disjoint networks), not a race against
//      replication or timing. A then ADDS segment 2's bootstrap via the
//      real Setup > Bootstrap UI and retries (the same real "switch/add a
//      bootstrap" action network-edges.spec.ts's "repro" test drives) —
//      this is also a more faithful test of the feature's actual stated
//      purpose (doc-confirmed, Kiyeovo_desktop_technical_documentation.md
//      line 161: "...so a user who switched bootstraps becomes
//      discoverable in seconds...") than the original wipe-based design
//      was. A second, separate code-confirmed finding surfaced along the
//      way and forced B/C to be REGISTERED (not left unregistered, as
//      first planned): SidebarHeader.tsx's `handleShowNewConversationDialog`
//      (~line 251) requires `isRegistered` on the INITIATING side before it
//      will even open the "New Conversation" dialog — an unregistered
//      click just shows a toast ("Register before starting a new
//      conversation.") and does nothing else. This is undocumented in
//      Kiyeovo_desktop_technical_documentation.md (grepped, absent) and
//      means an unregistered user cannot look anyone up at all, not just
//      that they themselves aren't discoverable.
//
// Every scenario mints a fresh uniqueRunSuffix() username — the default
// infra is the real, persistent public DHT (e2e/config.ts) for A/B/C, so
// fixed names would collide with a prior run's registration.
test.setTimeout(6 * 60_000);

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

/**
 * Opens "New Conversation" — reimplemented locally rather than imported:
 * onboard.ts's equivalent is module-private, and blocking.spec.ts/
 * group-chat.spec.ts already establish the convention of each spec file
 * owning its own small copy of this helper.
 */
async function openNewConversationDialog(page: Page): Promise<void> {
    const emptyStateButton = page.getByRole('button', { name: 'Start a conversation' }).first();
    if (await emptyStateButton.isVisible().catch(() => false)) {
        await emptyStateButton.click();
        return;
    }
    await page.locator('button:has(svg.lucide-plus)').first().click();
    await page.getByRole('button', { name: 'New Conversation', exact: true }).click();
}

type LookupOutcome = { outcome: 'success' | 'not_found' | 'timeout'; errorText?: string };

/**
 * Drives one lookup/contact-request attempt through the real "New
 * Conversation" surface and reports which of the two designed terminal
 * states it reached — deliberately NOT assuming success the way onboard.ts's
 * `sendContactRequest` does (that helper retries clicking "Send" on the
 * assumption the target genuinely exists and the DHT is just slow, which is
 * the wrong assumption for a deliberately-absent-record check: retrying
 * would just paper over the very "not found" signal this helper needs to
 * observe and report).
 *
 * Error-text trace (code-confirmed, src/core/lib/message-handler.ts):
 * a DHT miss makes `resolveUserRegistrationForSession` (line ~2360) throw
 * `User '<id>' not found`; `sendMessage`'s catch hands that to
 * `handleSendMessageFailure` (line ~2583), whose own literal-string check
 * `errorText.includes("username not found")` (line 2597) does NOT match
 * (the thrown text says "User", never "username") — so it falls through to
 * `throw error`, which the outer catch (line ~3083) re-wraps as
 * `Failed to send message: User '<id>' not found`. Net effect: the
 * NewConversationDialog's inline error DOES end up containing "not found"
 * (case-insensitive `/not found/i` below), just via the outer wrapper, not
 * the dead-looking branch at line 2597 — worth flagging as a stale/
 * unreachable check, not a functional bug (the user-visible text is still
 * correct).
 */
async function attemptUsernameLookup(
    page: Page,
    identifier: string,
    message: string,
    timeoutMs = 60_000,
): Promise<LookupOutcome> {
    await openNewConversationDialog(page);
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
        // eslint-disable-next-line no-await-in-loop
        await page.waitForTimeout(1_000);
    }
    return { outcome: 'timeout' };
}

/**
 * Re-clicks "Send" on an already-open, already-filled New Conversation
 * dialog (left open by a prior `attemptUsernameLookup` 'not_found' result)
 * until it closes (success) or the timeout elapses. Used by scenario E to
 * poll for the debounced republish landing, without re-typing the identifier
 * each time.
 */
async function retryLookupUntilSuccess(page: Page, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const dialogVisible = await page.getByRole('heading', { name: 'New Conversation' }).isVisible().catch(() => false);
        if (!dialogVisible) return;
        await page.getByRole('button', { name: 'Send' }).click();
        // eslint-disable-next-line no-await-in-loop
        await page.waitForTimeout(4_000);
    }
    throw new Error(`Lookup did not succeed within ${timeoutMs}ms of retrying`);
}

async function getUserState(page: Page): Promise<{ peerId: string | null; username: string | null; isRegistered: boolean }> {
    return page.evaluate(() => window.kiyeovoAPI.getUserState());
}

/** Reads the resolved `other_peer_id` for a direct chat by its counterpart username, via the same getChats() IPC the chat UI loads from. */
async function chatPeerIdForUsername(page: Page, username: string): Promise<string | undefined> {
    return page.evaluate(async (name) => {
        const result = await window.kiyeovoAPI.getChats();
        if (!result.success) return undefined;
        const chat = (result.chats as Array<Record<string, unknown>>).find((c) => c.username === name);
        return chat ? (chat.other_peer_id as string | undefined) : undefined;
    }, username);
}

// ---------------------------------------------------------------------------
// A. Happy path: lookup by username, contact, one message each way.
// ---------------------------------------------------------------------------
test('B looks up A by username and contacts them; the resolved chat points at A\'s real peer ID @slow', async () => {
    const testInfo = test.info();
    const testStart = Date.now();
    let peerA: LaunchedApp | undefined;
    let peerB: LaunchedApp | undefined;
    let failed = false;

    const runSuffix = uniqueRunSuffix();
    const usernameA = `ul_a_${runSuffix}`;
    const usernameB = `ul_b_${runSuffix}`;

    try {
        [peerA, peerB] = await Promise.all([
            launchApp({ p2pPort: 9181 }),
            launchApp({ p2pPort: 9182 }),
        ]);
        const { page: pageA } = peerA;
        const { page: pageB } = peerB;

        const onboardOptions = {
            password: PASSWORD,
            bootstrapMultiaddr: BOOTSTRAP_MULTIADDR,
            relayMultiaddr: RELAY_MULTIADDR,
            stunUrl: STUN_URL,
        };
        const [{ peerId: peerIdA }] = await timedStage('lookup', 'onboard_both_peers', () => Promise.all([
            onboard(pageA, { ...onboardOptions, username: usernameA }),
            onboard(pageB, { ...onboardOptions, username: usernameB }),
        ]));
        await attach(testInfo, pageA, 'a-onboarded');
        await attach(testInfo, pageB, 'b-onboarded');

        // --- B targets A by USERNAME (not peer ID) — this is the actual DHT
        // lookup surface under test; two-peer.spec.ts never exercises it. ---
        const firstMessage = 'Hi — found you by username!';
        await timedStage('lookup', 'username_lookup_contact_request', async () => {
            await sendContactRequest(pageB, usernameA, firstMessage);
            await expect(pageA.getByText(usernameB, { exact: true })).toBeVisible({ timeout: 20_000 });
            await acceptContactRequest(pageA, usernameB);
        });
        await attach(testInfo, pageB, 'b-sent-via-username');
        await attach(testInfo, pageA, 'a-accepted');

        await timedStage('lookup', 'first_message_visible', () => Promise.all([
            expect(chatMessage(pageA, firstMessage)).toBeVisible({ timeout: 30_000 }),
            expect(chatMessage(pageB, firstMessage)).toBeVisible({ timeout: 30_000 }),
        ]));

        // --- Code-level "resolved profile" evidence: B's own chat row for
        // usernameA must carry A's REAL peer ID, not a same-named impostor
        // or a stale/wrong resolution. This is the lookup surface's most
        // concrete, non-DOM-text assertion. ---
        const resolvedPeerId = await chatPeerIdForUsername(pageB, usernameA);
        expect(resolvedPeerId).toBe(peerIdA);

        // --- One message each way (kept lean; two-peer.spec.ts already
        // covers the fuller bidirectional battery). ---
        const reply = 'Confirmed — this really is Alice.';
        await timedStage('lookup', 'a_reply', async () => {
            await sendChatMessage(pageA, reply);
            await expect(chatMessage(pageB, reply)).toBeVisible({ timeout: 30_000 });
        });
        await attach(testInfo, pageB, 'b-received-reply');
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][lookup] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) {
            await attachLogs(testInfo, peerA, 'a-main-process-logs');
            await attachLogs(testInfo, peerB, 'b-main-process-logs');
        }
        await peerA?.close().catch((error) => console.error('Failed to close peer A:', error));
        await peerB?.close().catch((error) => console.error('Failed to close peer B:', error));
    }
});

// ---------------------------------------------------------------------------
// B. Nonexistent username: no-hang, designed not-found UX, app stays usable.
// ---------------------------------------------------------------------------
test('looking up a never-registered username surfaces a not-found error without hanging @slow', async () => {
    const testInfo = test.info();
    const testStart = Date.now();
    let peer: LaunchedApp | undefined;
    let failed = false;
    const runSuffix = uniqueRunSuffix();
    const usernameSelf = `ul_bself_${runSuffix}`;
    const neverRegistered = `ul_never_${runSuffix}`;

    try {
        peer = await launchApp({ p2pPort: 9183 });
        const { page } = peer;

        await timedStage('notfound', 'onboard', () => onboard(page, {
            password: PASSWORD,
            username: usernameSelf,
            bootstrapMultiaddr: BOOTSTRAP_MULTIADDR,
            relayMultiaddr: RELAY_MULTIADDR,
            stunUrl: STUN_URL,
        }));

        const result = await timedStage('notfound', 'lookup_never_registered', () => (
            attemptUsernameLookup(page, neverRegistered, 'anybody home?', 45_000)
        ));
        console.log(`[notfound] outcome=${result.outcome} errorText=${result.errorText ?? '(none)'}`);
        expect(result.outcome).toBe('not_found');
        expect(result.errorText ?? '').toMatch(/not found/i);
        await attach(testInfo, page, 'notfound-error-shown');

        // No hang, app stays usable: the dialog is still interactive (Close
        // works), and a fresh New Conversation attempt can be opened again
        // right after — proof the failed lookup didn't wedge the UI.
        // Dialog.tsx renders its own icon-only "Close" (aria-label) affordance
        // in addition to the form's own footer "Close" button — both share
        // the accessible name, so `.first()` disambiguates (either one
        // closing the dialog demonstrates the same thing).
        await page.getByRole('button', { name: 'Close', exact: true }).first().click();
        await expect(page.getByRole('heading', { name: 'New Conversation' })).toBeHidden({ timeout: 10_000 });
        await openNewConversationDialog(page);
        await expect(page.getByRole('heading', { name: 'New Conversation' })).toBeVisible({ timeout: 10_000 });
        await page.getByRole('button', { name: 'Close', exact: true }).first().click();
        await attach(testInfo, page, 'notfound-app-still-usable');
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][notfound] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) await attachLogs(testInfo, peer, 'main-process-logs');
        await peer?.close().catch((error) => console.error('Failed to close peer:', error));
    }
});

// ---------------------------------------------------------------------------
// C. Duplicate registration: first-writer-wins, surfaced as an inline error.
// ---------------------------------------------------------------------------
test('registering a username someone else already owns is rejected as already-taken @slow', async () => {
    const testInfo = test.info();
    const testStart = Date.now();
    let peerA: LaunchedApp | undefined;
    let peerB: LaunchedApp | undefined;
    let failed = false;
    const runSuffix = uniqueRunSuffix();
    const contestedUsername = `ul_c_owner_${runSuffix}`;
    const usernameBFallback = `ul_c_other_${runSuffix}`;

    try {
        [peerA, peerB] = await Promise.all([
            launchApp({ p2pPort: 9184 }),
            launchApp({ p2pPort: 9185 }),
        ]);
        const { page: pageA } = peerA;
        const { page: pageB } = peerB;

        // A fully onboards and registers the contested username; B only
        // drives itself up to (and through) the Bootstrap+Relay steps, in
        // parallel — B's own duplicate-registration ATTEMPT is sequenced
        // strictly after A's registration has fully succeeded (see below),
        // since B's app-level pre-check (ensureUsernameAvailableForRegistration)
        // needs A's record to already be live in the DHT to reject correctly.
        const driveBToRegisterStep = async () => {
            await beginIdentityCreation(pageB, PASSWORD);
            await expect(pageB.getByRole('heading', { name: 'Bootstrap servers' })).toBeVisible({ timeout: 15_000 });
            await addBootstrapServer(pageB, BOOTSTRAP_MULTIADDR);
            await waitForRealDhtConnection(pageB);
            await pageB.getByRole('button', { name: 'Continue', exact: true }).click();
            await completeRelayStep(pageB, RELAY_MULTIADDR);
            await expect(pageB.getByRole('heading', { name: 'Register a username' })).toBeVisible({ timeout: 15_000 });
        };

        await timedStage('duplicate', 'onboard_a_and_drive_b_to_register_step', () => Promise.all([
            onboard(pageA, {
                password: PASSWORD,
                username: contestedUsername,
                bootstrapMultiaddr: BOOTSTRAP_MULTIADDR,
                relayMultiaddr: RELAY_MULTIADDR,
                stunUrl: STUN_URL,
            }),
            driveBToRegisterStep(),
        ]));
        await attach(testInfo, pageA, 'a-registered-contested-username');

        // --- B attempts to register A's EXACT username ---
        await timedStage('duplicate', 'b_attempts_duplicate_registration', async () => {
            await pageB.getByRole('button', { name: 'Register username' }).click();
            await expect(pageB.getByRole('heading', { name: 'Register Identity' })).toBeVisible({ timeout: 15_000 });
            await pageB.getByPlaceholder('Enter username...').fill(contestedUsername);
            const rememberMeCheckbox = pageB.getByRole('checkbox', { name: /Auto-register on startup/ });
            if (await rememberMeCheckbox.isChecked()) {
                await rememberMeCheckbox.uncheck();
            }
            await pageB.getByRole('button', { name: 'Register', exact: true }).click();

            // Designed behavior (code-confirmed, username-registry.ts:385-447 +
            // 468-487): first-writer-wins. The DHT already holds an ACTIVE
            // record for `contestedUsername` bound to A's peer ID, so B's
            // `ensureUsernameAvailableForRegistration` pre-check throws
            // ERRORS.USERNAME_TAKEN = 'Username already taken' before any
            // publish is attempted — surfaced inline, dialog stays open. The
            // same copy ALSO renders in a toast + an aria-live announcement
            // (same pattern network-edges.spec.ts documents for the bootstrap
            // all-dead error) and RegisterDialog is itself `aria-label`led
            // "Register Identity" — scoping to that container disambiguates
            // the inline copy from the toast/announcement duplicates.
            await expect(pageB.getByLabel('Register Identity').getByText('Username already taken')).toBeVisible({ timeout: 30_000 });
            await expect(pageB.getByRole('heading', { name: 'Register Identity' })).toBeVisible();
        });
        await attach(testInfo, pageB, 'b-duplicate-rejected');

        // --- Not permanently stuck: B can still register a DIFFERENT name
        // right after, proving the rejection was specific to the contested
        // username, not a broken registration path. ---
        await timedStage('duplicate', 'b_registers_different_username', async () => {
            await pageB.getByPlaceholder('Enter username...').fill(usernameBFallback);
            await expect(async () => {
                const dialogStillOpen = await pageB.getByRole('heading', { name: 'Register Identity' })
                    .isVisible()
                    .catch(() => false);
                if (dialogStillOpen) {
                    await pageB.getByRole('button', { name: 'Register', exact: true }).click();
                }
                await expect(pageB.getByRole('heading', { name: 'Register Identity' })).toBeHidden({ timeout: 30_000 });
            }).toPass({ timeout: 90_000, intervals: [3_000] });
        });
        await attach(testInfo, pageB, 'b-registered-fallback-username');
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][duplicate] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) {
            await attachLogs(testInfo, peerA, 'a-main-process-logs');
            await attachLogs(testInfo, peerB, 'b-main-process-logs');
        }
        await peerA?.close().catch((error) => console.error('Failed to close peer A:', error));
        await peerB?.close().catch((error) => console.error('Failed to close peer B:', error));
    }
});

// ---------------------------------------------------------------------------
// D. Publish failure surfaced (7fd7838): zero-accept, not a false success.
// ---------------------------------------------------------------------------
test('registering with a dead local bootstrap surfaces a publish failure, never a false success @slow', async () => {
    const testInfo = test.info();
    const testStart = Date.now();
    let bootstrap: BootstrapNode | undefined;
    let peer: LaunchedApp | undefined;
    let failed = false;
    const runSuffix = uniqueRunSuffix();
    const username = `ul_d_${runSuffix}`;

    try {
        bootstrap = await timedStage('publishfail', 'start_local_bootstrap', () => startBootstrapNode(20411));

        peer = await launchApp({ p2pPort: 9186, env: { DEBUG_MODE: 'true' } });
        const { page } = peer;

        // --- Onboard with registration DEFERRED: the wizard's Register step
        // is `optional: true` (InitialSetupWizard.tsx FAST_STEPS) — clicking
        // the top-nav "Continue" (not the in-step "Register username"
        // button) advances past it while still unregistered. ---
        await timedStage('publishfail', 'onboard_without_registering', async () => {
            await beginIdentityCreation(page, PASSWORD);
            await expect(page.getByRole('heading', { name: 'Bootstrap servers' })).toBeVisible({ timeout: 15_000 });
            await addBootstrapServer(page, bootstrap!.multiaddr);
            await waitForRealDhtConnection(page);
            await page.getByRole('button', { name: 'Continue', exact: true }).click();
            await completeRelayStep(page, RELAY_MULTIADDR);
            await expect(page.getByRole('heading', { name: 'Register a username' })).toBeVisible({ timeout: 15_000 });
            await page.getByRole('button', { name: 'Continue', exact: true }).click();
            await completeIceStep(page, STUN_URL);
            await finishWizard(page);
        });

        const stateBeforeKill = await getUserState(page);
        expect(stateBeforeKill.isRegistered).toBe(false);
        // The unregistered footer CTA (SidebarFooter.tsx's RegisterButton,
        // rendered whenever `!user.registered`) is what a real user would
        // click — confirm it's actually there before relying on it below.
        await expect(page.getByRole('button', { name: /Register Identity/ })).toBeVisible({ timeout: 10_000 });
        await attach(testInfo, page, 'publishfail-unregistered-main-ui');

        // --- Open the Register Identity CTA and fill the username WHILE
        // still connected to the (still-alive) local bootstrap. ---
        //
        // Deliberate deviation from the "kill first, then attempt" literal
        // task shape, code-confirmed via a throwaway debug run: the app's
        // connectivity check (SidebarHeader.tsx/useDHTConnectionStatus.ts's
        // push-based `onDHTConnectionStatus`, backed by
        // src/core/index.ts's checkDHTStatus, which — code-confirmed —
        // schedules a ONE-TIME `timer_5s` + recurring `timer_30s` check,
        // apparently anchored close to when the bootstrap step itself
        // succeeds rather than app launch) noticed the killed bootstrap and
        // flipped `state.user.connected` to `false` within just a few
        // seconds in every observed run. RegisterDialog.tsx's
        // `formDisabled = dhtOffline || Boolean(isRegistering)` (dhtOffline =
        // `isConnected === false`) then disables the ENTIRE form — including
        // the "Register" submit button itself (its own `disabled` prop
        // additionally requires `dhtReady = isConnected === true`) — so
        // "kill bootstrap, THEN open the dialog and click Register" races
        // the periodic checker and reliably lost that race in testing: the
        // click just hung waiting for a button that had already gone
        // permanently disabled, never reaching the DHT-put codepath
        // (7fd7838) this scenario exists to exercise at all. Clicking
        // "Register" while still genuinely connected (button enabled, no
        // race) and killing the bootstrap immediately afterward instead
        // fails the *in-flight* DHT put — the same `getPublishFailureError`
        // zero-accept codepath, reached deterministically instead of by
        // racing a UI gate. This is itself a notable finding: the "zero
        // peers accepted the publish" failure (7fd7838) and the "network
        // already known to be down, can't even try" gate are TWO distinct,
        // non-overlapping designed failure surfaces — a real user who waits
        // even a few seconds after their bootstrap dies before hitting
        // Register will see the connectivity gate, not this scenario's
        // publish-failure copy.
        await page.getByRole('button', { name: /Register Identity/ }).click();
        await expect(page.getByRole('heading', { name: 'Register Identity' })).toBeVisible({ timeout: 15_000 });
        await page.getByPlaceholder('Enter username...').fill(username);

        await timedStage('publishfail', 'click_register_then_kill_bootstrap_in_flight', async () => {
            await page.getByRole('button', { name: 'Register', exact: true }).click();
            await bootstrap!.stop();
            bootstrap = undefined;
            console.log('[timing][publishfail] local bootstrap killed right after clicking Register');

            // Designed failure UX (getPublishFailureError, username-registry.ts:
            // 468-487): a publish that reaches zero accepting peers is a
            // reported FAILURE, never a false "registered". The exact wording
            // depends on whether the DHT walk against the now-dead bootstrap
            // produced rejections, errors, or neither — matched loosely here
            // and the concrete text logged for the report rather than
            // pinned, since this empirical branch is exactly what this test
            // exists to observe. Scoped to the dialog (aria-labelled
            // "Register Identity", same as scenario C) since the identical
            // copy also renders in a toast, colliding in strict mode
            // otherwise.
            await expect(page.getByRole('heading', { name: 'Register Identity' })).toBeVisible({ timeout: 45_000 });
            const registerDialog = page.getByLabel('Register Identity');
            await expect(
                registerDialog.locator('span').filter({ hasText: /fail|reject|unreachable|unable|no reachable|not found/i }),
            ).toBeVisible({ timeout: 45_000 });
        });
        const registerDialogForLog = page.getByLabel('Register Identity');
        const errorSpanText = await registerDialogForLog.locator('span').filter({
            hasText: /fail|reject|unreachable|unable|no reachable|not found/i,
        }).first().textContent().catch(() => null);
        console.log(`[publishfail] observed error text: ${errorSpanText ?? '(none captured)'}`);
        await attach(testInfo, page, 'publishfail-error-shown');

        const stateAfterFailure = await getUserState(page);
        expect(stateAfterFailure.isRegistered).toBe(false);
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][publishfail] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) await attachLogs(testInfo, peer, 'main-process-logs');
        await peer?.close().catch((error) => console.error('Failed to close peer:', error));
        await bootstrap?.stop().catch((error) => console.error('Failed to stop bootstrap node:', error));
    }
});

// ---------------------------------------------------------------------------
// E. Republish on reconnect (85db62b): survives a same-address, wiped-store
// bootstrap restart.
// ---------------------------------------------------------------------------
test('username republishes to a newly-added bootstrap segment on reconnect @slow', async () => {
    const testInfo = test.info();
    const testStart = Date.now();
    let bootstrap1: BootstrapNode | undefined;
    let bootstrap2: BootstrapNode | undefined;
    let peerA: LaunchedApp | undefined;
    let peerB: LaunchedApp | undefined;
    let peerC: LaunchedApp | undefined;
    let failed = false;
    const runSuffix = uniqueRunSuffix();
    const usernameA = `ul_e_${runSuffix}`;
    const usernameB = `ul_e_b_${runSuffix}`;
    const usernameC = `ul_e_c_${runSuffix}`;

    try {
        // Two INDEPENDENT local bootstrap "segments" that never federate with
        // each other (see the file-level comment for why this replaced the
        // originally-planned single-bootstrap datastore wipe). A and B live
        // in segment 1; C lives, from the start, in segment 2 — a
        // completely disjoint DHT with no shared peer, so C genuinely cannot
        // see segment 1's records by construction, not by luck/timing.
        [bootstrap1, bootstrap2] = await timedStage('republish', 'start_two_segments', () => Promise.all([
            startBootstrapNode(20412),
            startBootstrapNode(20413),
        ]));

        [peerA, peerB, peerC] = await Promise.all([
            launchApp({ p2pPort: 9187 }),
            launchApp({ p2pPort: 9188 }),
            launchApp({ p2pPort: 9189 }),
        ]);
        const { page: pageA } = peerA;
        const { page: pageB } = peerB;
        const { page: pageC } = peerC;

        await timedStage('republish', 'onboard_all_three_registered', () => Promise.all([
            onboard(pageA, {
                password: PASSWORD, username: usernameA,
                bootstrapMultiaddr: bootstrap1!.multiaddr, relayMultiaddr: RELAY_MULTIADDR, stunUrl: STUN_URL,
            }),
            onboard(pageB, {
                password: PASSWORD, username: usernameB,
                bootstrapMultiaddr: bootstrap1!.multiaddr, relayMultiaddr: RELAY_MULTIADDR, stunUrl: STUN_URL,
            }),
            // C onboards against segment 2 from the very start — it has
            // never dialed segment 1 or any of its peers.
            onboard(pageC, {
                password: PASSWORD, username: usernameC,
                bootstrapMultiaddr: bootstrap2!.multiaddr, relayMultiaddr: RELAY_MULTIADDR, stunUrl: STUN_URL,
            }),
        ]));
        await attach(testInfo, pageA, 'republish-a-registered-segment1');

        // --- Sanity check: B (same segment as A) can look A up. Proves
        // registration genuinely succeeded in segment 1. ---
        await timedStage('republish', 'same_segment_lookup_succeeds', async () => {
            const before = await attemptUsernameLookup(pageB, usernameA, 'same segment as you', 45_000);
            console.log(`[republish] same-segment (B->A) lookup outcome=${before.outcome}`);
            expect(before.outcome).toBe('success');
        });

        // --- C (segment 2, never federated with segment 1) must NOT see A
        // — deterministically, by construction, not by racing a wipe. ---
        await timedStage('republish', 'cross_segment_lookup_not_found', async () => {
            const crossSegment = await attemptUsernameLookup(pageC, usernameA, 'can you see me yet?', 45_000);
            console.log(`[republish] cross-segment (C->A) lookup outcome=${crossSegment.outcome}`);
            expect(crossSegment.outcome).toBe('not_found');
        });
        await attach(testInfo, pageC, 'republish-c-not-found-cross-segment');

        // --- A adds segment 2's bootstrap and retries — a real "switch/add
        // a bootstrap" user action. Per src/core/index.ts:592-638, a
        // successful retryBootstrap() with connectedCount>0 calls
        // republishUsernameOnReconnect.schedule(), debounced
        // BOOTSTRAP_RECONNECT_REPUBLISH_DEBOUNCE_MS=5s
        // (src/core/constants.ts:177) before actually re-publishing —
        // this time reaching segment 2 too, since A is now a directly
        // known peer of bootstrap2. ---
        await timedStage('republish', 'a_adds_segment2_and_reconnects', async () => {
            await navigateToBootstrapSetup(pageA);
            await addBootstrapServer(pageA, bootstrap2!.multiaddr);
            await waitForRealDhtConnection(pageA);
        });
        console.log('[timing][republish] A connected to segment 2; debounced republish should follow within ~5s');
        await attach(testInfo, pageA, 'republish-a-added-segment2');

        // --- C's still-open dialog (left open by the 'not_found' outcome
        // above) keeps retrying the SAME lookup until the debounced
        // republish lands. Generous but bounded window: 5s debounce +
        // FAST_PUBLISH_EARLY_RETURN_MS=10s (username-registry.ts) + real DHT
        // put roundtrip + this test's own poll granularity. ---
        await timedStage('republish', 'after_republish_lookup_succeeds', () => (
            retryLookupUntilSuccess(pageC, 60_000)
        ));
        await attach(testInfo, pageC, 'republish-c-succeeds-after-republish');
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][republish] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) {
            await attachLogs(testInfo, peerA, 'a-main-process-logs');
            await attachLogs(testInfo, peerB, 'b-main-process-logs');
            await attachLogs(testInfo, peerC, 'c-main-process-logs');
        }
        await peerA?.close().catch((error) => console.error('Failed to close peer A:', error));
        await peerB?.close().catch((error) => console.error('Failed to close peer B:', error));
        await peerC?.close().catch((error) => console.error('Failed to close peer C:', error));
        await bootstrap1?.stop().catch((error) => console.error('Failed to stop bootstrap segment 1:', error));
        await bootstrap2?.stop().catch((error) => console.error('Failed to stop bootstrap segment 2:', error));
    }
});
