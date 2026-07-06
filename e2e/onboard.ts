import { expect, type Page } from '@playwright/test';

/**
 * Per-stage timing instrumentation. The real infra's latency varies a lot
 * stage-to-stage (DHT dial vs. relay reservation vs. username-publish DHT
 * put vs. key exchange), so every run logs a breakdown — this is what lets a
 * slow or hung run be diagnosed from console output alone instead of
 * guessing which step is the bottleneck.
 */
export async function timedStage<T>(label: string, name: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
        return await fn();
    } finally {
        console.log(`[timing][${label}] ${name}: ${((Date.now() - start) / 1000).toFixed(1)}s`);
    }
}

/**
 * Drives the full "get a fresh profile from zero to able-to-chat" flow for one
 * app instance, going through the *real* guided first-run setup wizard end to
 * end (rather than skipping it) now that the suite points at real, deployed
 * infra (see e2e/config.ts):
 *
 *   1. Network Mode screen -> Fast
 *   2. Identity creation (password + confirm) -> "I wrote it down" on the
 *      recovery-phrase dialog
 *   3. First-run setup guide -> "Start setup" (instead of skipping)
 *   4. Guided wizard, in order (src/ui/components/sidebar/setup/InitialSetupWizard.tsx):
 *        a. Bootstrap: add the given bootstrap multiaddr, retry until the
 *           app reports real DHT connectivity.
 *        b. Relay: add the given relay multiaddr and ASSERT the app obtains
 *           a circuit-relay-v2 reservation (see completeRelayStep — this is
 *           regression coverage for the relay slot-exhaustion incident).
 *        c. Register: register a username (required on *both* sides of a
 *           contact exchange — see the `isRegistered` gates in
 *           SidebarHeader.tsx and InvitationManager.tsx).
 *        d. Calls (ICE): add the given STUN server.
 *      Then "Finish setup" -> "Start chatting" on the wizard's ready screen.
 *
 * Returns this instance's own Peer ID (read via kiyeovoAPI.getUserState(), no
 * DOM parsing needed) so the other peer can target it from "New Conversation".
 */
export async function onboard(
    page: Page,
    options: {
        password: string;
        username: string;
        bootstrapMultiaddr: string;
        relayMultiaddr: string;
        stunUrl: string;
    },
): Promise<{ peerId: string }> {
    const { password, username, bootstrapMultiaddr, relayMultiaddr, stunUrl } = options;
    const label = username;
    const onboardStart = Date.now();

    await page.waitForLoadState('domcontentloaded');

    await timedStage(label, 'network_mode+identity+recovery', async () => {
        // --- 1. Network mode ---
        await expect(page.getByText('Choose Network Mode')).toBeVisible({ timeout: 30_000 });
        await page.getByRole('button', { name: 'Fast', exact: true }).click();

        // --- 2. Identity creation ---
        await expect(page.getByText('NEW IDENTITY')).toBeVisible({ timeout: 30_000 });
        await page.getByPlaceholder('Enter password...').fill(password);
        await page.getByPlaceholder('Confirm password...').fill(password);
        await page.getByRole('button', { name: 'Create Identity' }).click();

        await expect(page.getByText('RECOVERY PHRASE')).toBeVisible({ timeout: 15_000 });
        await page.getByRole('button', { name: "I wrote it down" }).click();

        // --- 3. Go through the guided first-run setup wizard for real ---
        await expect(page.getByText("Let's get Kiyeovo connected!")).toBeVisible({ timeout: 60_000 });
        await page.getByRole('button', { name: 'Start setup' }).click();
    });

    // --- 4a. Bootstrap ---
    await timedStage(label, 'bootstrap', () => completeBootstrapStep(page, bootstrapMultiaddr));
    // --- 4b. Relay ---
    await timedStage(label, 'relay', () => completeRelayStep(page, relayMultiaddr));
    // --- 4c. Register a username ---
    await timedStage(label, 'register', () => completeRegisterStep(page, username));
    // --- 4d. STUN/TURN (Calls) ---
    await timedStage(label, 'ice', () => completeIceStep(page, stunUrl));

    await timedStage(label, 'finish_wizard', async () => {
        // --- Ready screen -> land in Chats ---
        await expect(page.getByText("You're ready to use Kiyeovo")).toBeVisible({ timeout: 15_000 });
        await page.getByRole('button', { name: 'Start chatting' }).click();
    });

    const userState = await page.evaluate(() => window.kiyeovoAPI.getUserState());
    if (!userState.peerId) {
        throw new Error('kiyeovoAPI.getUserState() returned no peerId after onboarding');
    }

    console.log(`[timing][${label}] TOTAL onboard(): ${((Date.now() - onboardStart) / 1000).toFixed(1)}s`);
    return { peerId: userState.peerId };
}

/**
 * Adds the bootstrap multiaddr and retries the dial until the app reports
 * real DHT connectivity (kiyeovoAPI.getDHTConnectionStatus()) — not the
 * separate, ping-based per-node liveness indicator shown in the node list,
 * which past experience (against a sandboxed local node) found unreliable
 * even once the underlying DHT connection was actually up. The public
 * bootstrap node is slower to dial than the old throwaway local one, so this
 * retries generously.
 */
async function completeBootstrapStep(page: Page, bootstrapMultiaddr: string): Promise<void> {
    await expect(page.getByRole('heading', { name: 'Bootstrap servers' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Add bootstrap server' }).click();
    await page.getByPlaceholder(/ip4\/1\.2\.3\.4/).fill(bootstrapMultiaddr);
    await page.getByRole('button', { name: 'Add server' }).click();

    await waitForRealDhtConnection(page);

    await page.getByRole('button', { name: 'Continue', exact: true }).click();
}

/**
 * Clicks "Retry connection" and polls kiyeovoAPI.getDHTConnectionStatus() —
 * real DHT connectivity, not the separate ping-based per-node liveness shown
 * in the node list, which past experience found unreliable — until it
 * reports connected.
 *
 * Important quirk (src/core/index.ts retryBootstrap / emitDhtStatus): the
 * core resets its DHT status to `null` ("bootstrap_retry_in_progress") the
 * instant a retry starts, and only confirms real connectivity a few seconds
 * *after* the retry call resolves (see POST_RETRY_VERIFY_DELAY_FAST_MS in
 * src/core/network/reconnect-controller.ts, scheduled via
 * schedulePostRetryVerify). So each attempt below gives that settle window a
 * chance to land *before* clicking retry again — re-clicking immediately
 * would just perpetually reset the status back to null out from under the
 * check and could loop forever without ever observing a real `true`.
 */
async function waitForRealDhtConnection(page: Page): Promise<void> {
    // Observed real timing against the deployed bootstrap: dial + verify
    // completes in ~3.5s on a working attempt. 5 attempts x (15s settle-wait
    // cap + 8s poll) = 115s worst case, well above the observed norm without
    // approaching the test's 6-minute hard cap.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
        await page.getByRole('button', { name: 'Retry connection' }).click();
        await expect(page.getByRole('button', { name: 'Retrying…' })).toBeHidden({ timeout: 15_000 });

        try {
            await expect.poll(async () => {
                const status = await page.evaluate(() => window.kiyeovoAPI.getDHTConnectionStatus());
                return status.success ? status.connected : 'error';
            }, { timeout: 8_000, intervals: [2_000] }).toBe(true);
            return;
        } catch {
            // Not connected yet within this attempt's settle window — loop and retry.
        }
    }
    throw new Error('Bootstrap never reported real DHT connectivity after repeated retries');
}

/**
 * Adds the relay multiaddr and ASSERTS the app obtains a circuit-relay-v2
 * reservation, failing the run loudly if the relay refuses.
 *
 * History — this assertion is regression coverage for a real incident: the
 * deployed relay (e2e/config.ts) used to refuse *every* reservation with a
 * protocol-level RESERVATION_REFUSED. Root cause was not app code: the relay
 * ran with js-libp2p's default maxReservations=15, and this suite's own
 * short-lived test peers had exhausted all 15 slots (the reservation TTL
 * outlived the peers). The operator fixed the server on 2026-07-05
 * (maxReservations=512, reservationTtl=900000ms, service restarted) and
 * reservations now confirm in about a second — see RELAY-VERIFICATION.md at
 * the repo root for the evidence. While the refusal looked like immovable
 * infra, this step was deliberately best-effort (2 short attempts, warn and
 * continue); now that the relay is healthy it hard-fails instead, so the
 * suite screams if slot exhaustion (or any other refusal) ever recurs.
 *
 * Why the assertion polls kiyeovoAPI.retryRelays() rather than the UI:
 * - kiyeovoAPI.getRelayStatus() always returns `connected: null` for
 *   Fast-mode relays (GET_RELAY_STATUS in src/electron/ipc-handlers.ts), so
 *   there is no read-only status to poll.
 * - RelaySetup's "Connected to N of M relay server(s)" toast — the old
 *   best-effort signal — proved unreliable even on success: a run whose
 *   main-process logs showed "[IPC] Relay retry complete connected=1/1"
 *   still never matched the toast text in time.
 * - retryRelays() is the exact IPC the wizard's "Retry connection" button
 *   drives, and it is effectively a status read once the reservation exists:
 *   dialConfiguredFastRelays (src/core/network/node-relays.ts) short-circuits
 *   with "reservation already active" instead of re-dialing.
 */
async function completeRelayStep(page: Page, relayMultiaddr: string): Promise<void> {
    await expect(page.getByRole('heading', { name: 'Relay servers' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Add relay server' }).click();
    await page.getByPlaceholder(/ip4\/1\.2\.3\.4/).fill(relayMultiaddr);
    await page.getByRole('button', { name: 'Add server' }).click();

    // Adding the relay already triggers a server-side reservation attempt
    // (ADD_RELAY_NODE auto-applies via retryRelays()), so on a healthy relay
    // the first poll usually confirms immediately. Observed timings: ~0.8s
    // dial-to-reserved on success; ~300ms for a RESERVATION_REFUSED refusal.
    // 30s is generous headroom for slow-infra days without approaching the
    // test's 6-minute hard cap.
    await expect.poll(async () => {
        const result = await page.evaluate(() => window.kiyeovoAPI.retryRelays());
        return result.success ? result.connected : 0;
    }, {
        message:
            'Relay never confirmed a circuit-relay-v2 reservation (kiyeovoAPI.retryRelays() reported ' +
            'connected=0 for the whole window). If the main-process logs show RESERVATION_REFUSED, check ' +
            'the relay server\'s reservation slots — maxReservations exhaustion caused exactly this before ' +
            '(see RELAY-VERIFICATION.md).',
        timeout: 30_000,
        intervals: [500, 1_000, 2_000],
    }).toBeGreaterThanOrEqual(1);

    await page.getByRole('button', { name: 'Continue', exact: true }).click();
}

/** Registers a username via the wizard's dedicated Register step, then continues. */
async function completeRegisterStep(page: Page, username: string): Promise<void> {
    await expect(page.getByRole('heading', { name: 'Register a username' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Register username' }).click();
    await expect(page.getByRole('heading', { name: 'Register Identity' })).toBeVisible({ timeout: 15_000 });
    await page.getByPlaceholder('Enter username...').fill(username);

    // Never opt into the "Auto-register on startup" keychain-backed remember-me
    // checkbox. Important: it defaults to CHECKED for a never-configured
    // identity (see GET_AUTO_REGISTER in src/electron/ipc-handlers.ts —
    // "Default ON when the user has never set a preference"), so it must be
    // explicitly unchecked rather than just left alone.
    const rememberMeCheckbox = page.getByRole('checkbox', { name: /Auto-register on startup/ });
    if (await rememberMeCheckbox.isChecked()) {
        await rememberMeCheckbox.uncheck();
    }

    // Registration against the real DHT can be outright REJECTED, not just
    // slow: observed "Registration failed: Error: Peer ID registration
    // rejected by DHT validators (3 peer(s) rejected)" in main-process logs
    // (src/core/username/username-registry.ts), especially right after the
    // node has just joined the network. RegisterDialog.tsx surfaces that as
    // an inline error and leaves the dialog open with "Register" clickable
    // again — it does not retry itself. A plain "wait for the dialog to
    // close" therefore hangs for the *entire* timeout on a failed attempt
    // instead of failing fast, which is what produced the ~90-120s register
    // times seen in earlier runs. Retry the click instead — but only if the
    // dialog is still open: a slow-but-successful registration can close it
    // just past a single attempt's wait, and re-clicking "Register" on a
    // dialog that's already gone just hangs waiting for a vanished button.
    await expect(async () => {
        const dialogStillOpen = await page.getByRole('heading', { name: 'Register Identity' })
            .isVisible()
            .catch(() => false);
        if (dialogStillOpen) {
            await page.getByRole('button', { name: 'Register', exact: true }).click();
        }
        await expect(page.getByRole('heading', { name: 'Register Identity' })).toBeHidden({ timeout: 30_000 });
    }).toPass({ timeout: 120_000, intervals: [3_000] });

    await page.getByRole('button', { name: 'Continue', exact: true }).click();
}

/** Adds a STUN server (optional step) and finishes the wizard. */
async function completeIceStep(page: Page, stunUrl: string): Promise<void> {
    await expect(page.getByRole('heading', { name: 'STUN/TURN servers' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Add STUN/TURN server' }).click();
    await page.getByPlaceholder('stun:stun.l.google.com:19302').fill(stunUrl);
    await page.getByRole('button', { name: 'Add server' }).click();

    await page.getByRole('button', { name: 'Finish setup' }).click();
}

/**
 * Opens "New Conversation". Uses the empty-chat-list CTA when there are no
 * chats yet; falls back to the header's "+" > New Conversation menu
 * otherwise (needed on a retried send — see sendContactRequest — once a
 * chat with the target already exists from an earlier attempt, which hides
 * the empty-state CTA).
 */
async function openNewConversationDialog(page: Page): Promise<void> {
    const emptyStateButton = page.getByRole('button', { name: 'Start a conversation' }).first();
    if (await emptyStateButton.isVisible().catch(() => false)) {
        await emptyStateButton.click();
        return;
    }
    // lucide-react icons render with a stable `lucide-<name>` class
    // (createLucideIcon.js) — the header's "+" button (SidebarHeader.tsx) has
    // no accessible name of its own, so this is the least-fragile way to
    // target it.
    await page.locator('button:has(svg.lucide-plus)').first().click();
    await page.getByRole('button', { name: 'New Conversation', exact: true }).click();
}

/** Opens "New Conversation" and sends the first message (the contact request). */
export async function sendContactRequest(
    page: Page,
    peerIdOrUsername: string,
    message: string,
): Promise<void> {
    await openNewConversationDialog(page);
    await expect(page.getByRole('heading', { name: 'New Conversation' })).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder('Enter peer ID or username...').fill(peerIdOrUsername);
    await page.getByPlaceholder('Compose an inital greeting...').fill(message);

    // Peer routing for a freshly-registered peer goes through a real DHT
    // username lookup + key exchange round trip against the public infra —
    // observed ~20-25s end to end (vs. near-instant on the old local node) —
    // so each attempt below needs a generous per-attempt wait before deciding
    // to retry, or the retry ends up clicking "Send" again (and resending the
    // message) while the first attempt is still in flight.
    await expect(async () => {
        await page.getByRole('button', { name: 'Send' }).click();
        await expect(page.getByRole('heading', { name: 'New Conversation' })).toBeHidden({ timeout: 45_000 });
    }).toPass({ timeout: 100_000, intervals: [5_000, 10_000] });
}

/**
 * Clicks the (single) pending contact-attempt entry with the given sender
 * username and accepts it.
 *
 * Over the real infra, the accepting side occasionally hits a stream-read
 * timeout completing the key exchange ("inbound stream read timed out after
 * 5000ms ... Failed to handle key exchange message" in
 * src/core/direct/key-exchange.ts) — and unlike a plain UI error, the
 * pending contact-attempt entry is then dropped entirely (confirmed via
 * screenshots: the "Contact Requests" section and its "Key exchange ...
 * failed or timed out" toast both disappear, with no way to retry left in
 * the UI), even though the *sender* may already believe the chat is active.
 * A single accept attempt is therefore all this helper does — recovering
 * from that state means resending the contact request from scratch, which
 * is the caller's responsibility (see two-peer.spec.ts).
 */
export async function acceptContactRequest(page: Page, fromUsername: string): Promise<void> {
    await page.getByText(fromUsername, { exact: true }).first().click();
    await page.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 30_000 });
}

/** Types and sends a message in the currently-open chat. */
export async function sendChatMessage(page: Page, message: string): Promise<void> {
    await page.getByPlaceholder('Type a message...').fill(message);
    await page.getByRole('button', { name: 'Send message' }).click();
}
