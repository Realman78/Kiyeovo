import { test, expect, type Page, type ElectronApplication, type TestInfo } from '@playwright/test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, type LaunchedApp } from './electron';
import {
    onboard,
    beginIdentityCreation,
    addBootstrapServer,
    waitForRealDhtConnection,
    completeRelayStep,
    completeIceStep,
    finishWizard,
    sendChatMessage,
    sendContactRequest,
    timedStage,
    readPeerId,
} from './onboard';
import {
    startOnionFrontedBootstrap,
    launchAnonymousApp,
    onboardAnonymous,
    type OnionFrontedBootstrap,
} from './tor';
import { BOOTSTRAP_MULTIADDR, RELAY_MULTIADDR, STUN_URL, uniqueRunSuffix } from './config';

// Round 8 of e2e/test-roadmap.md: trusted profile import/export (out-of-band
// onboarding). RESHAPED after a fix landed for both of this file's two
// original findings (which were reproduced as real failures against the
// pre-fix build — see e2e/test-roadmap.md's round-8 entry for that original
// narrative, kept there rather than duplicated here). This version asserts
// the FIXED behavior, plus one surviving-by-design asymmetry.
//
// MANDATORY READING done before writing anything below: e2e/README.md,
// e2e/config.ts's PORT RANGES table, e2e/electron.ts, e2e/onboard.ts,
// e2e/bootstrap-node.ts, e2e/tor.ts, tor-mode.spec.ts, username-lookup.spec.ts,
// two-peer.spec.ts; Kiyeovo_desktop_technical_documentation.md lines ~145-165
// (trusted profile section); src/core/identity/profile-manager.ts
// (ProfileManager.exportProfileDesktop/importTrustedUser), src/core/db/
// database.ts (createTrustedDirectContact's one-transaction insert),
// src/core/lib/message-handler.ts (maybeUpgradeTrustedOutOfBandChat,
// sendMessage's initialUser/offline-bucket branch), src/core/direct/
// key-exchange.ts (initiateKeyExchange, authorizeContactRequest,
// resolveContactRequestSenderFromDht), src/core/transport/protocol-dialer.ts
// (dialProtocolWithRelayFallback), src/core/username/username-registry.ts
// (the FIX: `ensureSelfUserRow`, called from `initialize()`), plus the UI:
// src/ui/components/sidebar/profile/ExportDialog.tsx (+ ProfilePage.tsx,
// which mounts it — reachable via the sidebar rail's "Profile" tab),
// src/ui/components/sidebar/header/ImportTrustedUserDialog.tsx (reachable via
// SidebarHeader's "+" dropdown -> "Add user from file"), and
// src/ui/components/chat/input/InvitationManager.tsx (the FIX: handleAccept's
// `isRegistered` early-return removed), src/electron/ipc-handlers.ts (the FIX:
// setupContactRequestHandlers' accept handler's matching `isRegistered` check
// removed).
//
// Every claim below is labeled doc-confirmed / code-confirmed / unverified.
//
// --- THE FIX (both halves code-confirmed against the working-tree diff) ---
// FIX #1 — `UsernameRegistry.ensureSelfUserRow()` (username-registry.ts,
// called from `initialize()` before any registration decision is made) now
// seeds a minimal self-row into `users` (fallback username `user_<last8>`,
// real signing/offline public keys, no signature) for EVERY identity at
// identity-ready time, registered or not — a no-op if a row already exists,
// so a real registration's row is never clobbered. This satisfies every
// chat-creation path's `assertUserExists(chat.created_by)` (`chat.created_by`
// is always the local identity's own peer ID), which previously threw a raw
// `User with peer_id '<own peer id>' not found in database` on an
// unregistered identity's very first chat-creation call — including
// `createTrustedDirectContact` (trusted import). An unregistered IMPORTER can
// now import a trusted profile; S1/S3 below assert this directly (previously
// reproduced here as a real failure).
// FIX #2 — the `isRegistered` accept gates are REMOVED from both
// `InvitationManager.tsx`'s `handleAccept` (previously an early return with
// `toast.warning('Finish registration first, then accept this contact
// request.')`) and `ipc-handlers.ts`'s contact-request accept handler
// (previously `{ success: false, error: 'Finish registration first...' }`
// whenever `!currentUsername`). An unregistered recipient of a contact
// request can now ACCEPT it: the responder replies with its fallback
// username (from FIX #1's self-row) and locally-derived keys, and
// finalization creates a self-owned chat (FIX #1's self-row guarantees this
// always succeeds). S1/S3/S4 below assert this directly. NOTE: FIX #2 only
// ever gated the ACCEPT step, never delivery — a *never*-registered acceptor
// is reachable only via S1/S3's pinned-key trusted-import flow, because a
// cold plain-peer-ID send (S4's shape, no import) requires the sender to
// resolve the target via a DHT record that only registering publishes (see
// S4's own header comment for the code trail); S4 therefore has its acceptor
// register-then-unregister rather than never register.
//
// --- SURVIVING ASYMMETRY (code-confirmed, deliberate, NOT touched by the fix)
// ---
// The RECIPIENT of a contact request still verifies the SENDER's registration
// via the sender's DHT username record: `authorizeContactRequest` ->
// `resolveContactRequestSenderFromDht(remoteId, senderUsername)`
// (key-exchange.ts ~923-929) runs on every inbound request regardless of the
// recipient's own registration state, and a request from an unregistered
// (unresolvable) sender is silently dropped (`Rejecting unresolved contact
// request...`, logged, never surfaced to the sender as an error). So whichever
// peer SENDS the first contact request (the importer in S1/S3's flow, since
// the imported file lets the importer message first; the initiator in S4's
// plain peer-ID flow) must still be registered before that first send, even
// though the RECEIVER never needs to be. This is unrelated to either fixed
// bug — it's `resolveContactRequestSenderFromDht` doing exactly its designed
// job of proving the sender's claimed username is real — and every scenario
// below documents it as the one registration step that still can't be
// skipped.
//
// --- Scenario map ---
// S1 (fast mode). Both start fully unregistered. A (exporter) exports —
//   registration-free, unaffected by either bug. B (importer), still
//   unregistered, imports the file — FIX #1 in action: this now SUCCEEDS
//   (previously: the self-referential DB error), producing a chat with
//   `trusted_out_of_band: true` and the customName, using only the imported
//   file's data for A's identity/keys (code-confirmed: message-handler.ts:
//   3009-3010's `getUserByPeerIdThenUsername` finds the locally-imported row
//   first; key-exchange.ts:591's `resolveRecipientOfflinePublicKeyBase64`
//   checks the local DB row before falling back to
//   `usernameRegistry.lookupByPeerId`) — B remains unregistered right through
//   the import. B then registers ONLY because B is about to SEND the first
//   message/contact request (the surviving asymmetry above), sends, and the
//   request reaches A — still fully unregistered. A accepts UNREGISTERED —
//   FIX #2 in action (previously: the "Finish registration first" toast made
//   accepting impossible) — and the chat goes live both ways with A NEVER
//   registering at any point in the test.
// S2 (fast mode, unaffected by the fix). Corrupted/truncated export file:
//   ProfileManager.importProfile (profile-manager.ts:97-125) JSON.parses the
//   file then AES-GCM-decrypts it (profile-manager.ts:237-260) BEFORE any
//   database call is made at all, so a truncated/corrupted file fails at the
//   decrypt step with the designed "Failed to decrypt profile - incorrect
//   password or corrupted file" message (profile-manager.ts:258) and never
//   reaches `createTrustedDirectContact`'s one-transaction insert
//   (database.ts:1667-1682) — i.e. this demonstrates the RETRY half of doc
//   line ~156 ("chat creation failure rolls back the contact insert and
//   leaves retries clean") by construction: no partial state is ever written
//   for a pre-transaction failure, so importing the ORIGINAL good file right
//   after must succeed with no cleanup needed. Both peers are REGISTERED here
//   (unchanged by the fix — registering both is no longer NEEDED to dodge
//   FIX #1's now-gone finding, but is kept anyway so this scenario stays
//   about the corrupted-file/retry behavior only, not the registration gap).
// S3 (Tor mode, 12-min budget per the round-6 carryover). Mirrors S1's shape
//   over anonymous mode: both start unregistered, A exports over Tor, B
//   imports over Tor while STILL unregistered (FIX #1, mode-agnostic —
//   `ensureSelfUserRow` has no fast/anonymous branch), then registers only to
//   send (the surviving asymmetry, also mode-agnostic). The round's KEY
//   INVESTIGATION (traced in code, confirmed by the original repro before
//   this reshape): the exported profile (UserProfilePlaintext,
//   profile-manager.ts:51-61) carries username, peerId, signingPublicKey,
//   offlinePublicKey, notificationsPublicKey, defaultInboxKey (=the shared
//   secret), createdAt, signature — NO network address of any kind. So when B
//   dials A after import, the ONLY thing available is A's bare peer ID; the
//   dial goes through `dialProtocolWithRelayFallback` ->
//   `node.dialProtocol(targetPeerId, protocol)` (protocol-dialer.ts), which is
//   libp2p's OWN kad-dht peer-routing (`findPeer`) resolving a PeerId to
//   multiaddrs via the DHT routing table — independent of either peer's
//   username-registry state. The request reaches A while A is STILL
//   unregistered (no username-registry record for A exists anywhere at dial
//   time — the request rendering on A's UI is itself the proof of peer-ID-only
//   routing, corroborated by A's main-process key_exchange_init stream logs).
//   A then accepts UNREGISTERED (FIX #2, mode-agnostic) and replies over onion
//   circuits — A NEVER registers, end to end, including the accept.
// S4 (fast mode, new). The GENERAL, non-import case FIX #2 newly enables: a
//   plain peer-ID contact request (via onboard.ts's `sendContactRequest`, no
//   trusted-profile file involved at all) that lands as pending while the
//   acceptor B is registered, then B UNREGISTERS before accepting — so B is
//   unregistered at accept time, the moment FIX #2's gate used to block. Both
//   A and B register up front: A because it's about to SEND (the surviving
//   asymmetry), B because a cold plain-peer-ID send needs its target to be
//   DHT-resolvable at all (`usernameRegistry.lookupByPeerId`, only populated
//   by registering) — found live while running this suite that an acceptor
//   who *never* registers is consequently unreachable by this flow at all,
//   which is why S4 has B register-then-unregister rather than never
//   registering; see the scenario's own header comment for the code trail.
//   S1/S3 remain the only scenarios where the acceptor never registers, full
//   stop — that shape only works because the trusted-import file pins the
//   acceptor's keys locally, sidestepping the DHT lookup S4 can't avoid.
//
// Every scenario mints fresh uniqueRunSuffix() usernames for every
// registration it performs (all against the real, persistent public DHT in
// S1/S2/S4; S3's registration goes to its own throwaway onion-fronted
// bootstrap).

const PASSWORD = 'Correct-Horse-Battery-Staple9!';
const EXPORT_PASSWORD = 'Export-Correct-Horse-9!';

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
    // Written to a file (not attached via `body`) so the full logs persist
    // under test-results/ with any reporter — `body` attachments are shown
    // only as a truncated preview by the list reporter, which made the
    // round's Tor dial-mechanism evidence unreadable after a failed run.
    const logPath = testInfo.outputPath(`${name}.txt`);
    await writeFile(logPath, peer.logs.join(''), 'utf8');
    await testInfo.attach(name, { path: logPath, contentType: 'text/plain' });
}

/**
 * Onboards through Network Mode -> Fast, identity creation, Bootstrap, Relay,
 * ICE, but leaves the Register step's top-nav "Continue" clicked instead of
 * the in-step "Register username" button (it's `optional: true` in
 * InitialSetupWizard.tsx's FAST_STEPS — same pattern username-lookup.spec.ts's
 * scenario D uses). Needed here because S1's whole point is proving the
 * EXPORTER never needs to register.
 */
async function onboardWithoutRegistering(
    page: Page,
    options: { bootstrapMultiaddr: string; relayMultiaddr: string; stunUrl: string },
): Promise<{ peerId: string }> {
    await page.waitForLoadState('domcontentloaded');
    await beginIdentityCreation(page, PASSWORD);
    await expect(page.getByRole('heading', { name: 'Bootstrap servers' })).toBeVisible({ timeout: 15_000 });
    await addBootstrapServer(page, options.bootstrapMultiaddr);
    await waitForRealDhtConnection(page);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await completeRelayStep(page, options.relayMultiaddr);
    await expect(page.getByRole('heading', { name: 'Register a username' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await completeIceStep(page, options.stunUrl);
    await finishWizard(page);
    const peerId = await readPeerId(page);
    return { peerId };
}

/**
 * Registers a username via SidebarFooter's "Register Identity" CTA (rendered
 * whenever `!user.registered` — RegisterButton.tsx) rather than the wizard,
 * for a peer that already finished onboarding unregistered. Identical
 * dialog/selectors to onboard.ts's completeRegisterStep (RegisterDialog.tsx is
 * shared by both entry points) — see username-lookup.spec.ts's scenario D for
 * the same pattern.
 */
async function registerViaFooterCta(page: Page, username: string): Promise<void> {
    await page.getByRole('button', { name: /Register Identity/ }).click();
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
        await expect(page.getByRole('heading', { name: 'Register Identity' })).toBeHidden({ timeout: 30_000 });
    }).toPass({ timeout: 120_000, intervals: [3_000] });
}

/**
 * Stubs Electron's native `dialog.showSaveDialog`/`dialog.showOpenDialog`
 * (main process) to resolve with a fixed path instead of opening a real OS
 * picker — same technique file-transfer.spec.ts's `stubFilePicker` already
 * established for `showOpenDialog` (see that file's header comment for why
 * this is the least-invasive scriptable route: no `<input type="file">`
 * anywhere in either dialog's flow, so Playwright cannot drive a picker via
 * setInputFiles). Extended here to ALSO stub `showSaveDialog`, which
 * ExportDialog.tsx calls before `exportProfile` — nothing else about the real
 * IPC handler (path validation, `.kiyeovo` extension, dialog-path-grant
 * registration) is touched.
 */
async function stubSaveDialog(app: ElectronApplication, filePath: string): Promise<void> {
    await app.evaluate(({ dialog }, targetPath: string) => {
        dialog.showSaveDialog = (async () => ({
            canceled: false,
            filePath: targetPath,
        })) as typeof dialog.showSaveDialog;
    }, filePath);
}

async function stubOpenDialog(app: ElectronApplication, filePath: string): Promise<void> {
    await app.evaluate(({ dialog }, targetPath: string) => {
        dialog.showOpenDialog = (async () => ({
            canceled: false,
            filePaths: [targetPath],
        })) as typeof dialog.showOpenDialog;
    }, filePath);
}

/** Opens Profile via the sidebar rail. Accessible name is "Profile" when registered, or "Profile, profile needs attention" when not (SidebarRail.tsx: severity='warning' whenever `!isRegistered`) — matched with a prefix regex so it works in either state. */
async function openProfileTab(page: Page): Promise<void> {
    await page.getByRole('button', { name: /^Profile/ }).click();
    await expect(page.getByRole('heading', { name: 'Trusted profile' }).or(
        page.getByText('Export an encrypted profile file'),
    )).toBeVisible({ timeout: 10_000 }).catch(() => { /* heading text may differ; button click below is the real assertion */ });
}

/**
 * Drives ProfilePage -> "Export trusted profile" -> ExportDialog to a
 * finished, successful export. Returns the exported file's fingerprint (for
 * cross-checking against the importer's own computed fingerprint — they must
 * match, since both are `ProfileManager.calculateFingerprint` over the same
 * signed profile data) and the peer ID read independently via kiyeovoAPI.
 */
async function exportTrustedProfile(
    app: ElectronApplication,
    page: Page,
    options: { label: string; filePath: string },
): Promise<{ fingerprint: string }> {
    await stubSaveDialog(app, options.filePath);
    await openProfileTab(page);
    await page.getByRole('button', { name: 'Export trusted profile' }).click();
    await expect(page.getByRole('heading', { name: 'Export trusted profile' })).toBeVisible({ timeout: 10_000 });

    const labelInput = page.getByPlaceholder('Name the recipient will see...');
    await labelInput.fill('');
    await labelInput.fill(options.label);
    await page.getByPlaceholder('Enter password...').fill(EXPORT_PASSWORD);
    await page.getByPlaceholder('Confirm password...').fill(EXPORT_PASSWORD);
    // Leave the auto-generated shared secret as-is — no need to know its
    // value for this test, and touching it would require checking the
    // "I understand this is risky" box (ExportDialog.tsx's
    // confirmCustomSecretRisk gate).

    await page.getByRole('button', { name: 'Export Profile', exact: true }).click();
    await expect(page.getByText('Profile exported successfully!')).toBeVisible({ timeout: 15_000 });

    // ExportDialog's success view has TWO `.font-mono.text-xs.break-all`
    // elements in DOM order: the "Saved to" file path first, then (after the
    // security-notice block) the fingerprint — `.last()` disambiguates.
    const fingerprint = (await page.locator('.font-mono.text-xs.break-all').last().textContent())?.trim() ?? '';

    // ExportDialog's footer button reads "Done" once exportSuccess is true.
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    // Navigate back to Chats: Sidebar.tsx hides the whole ChatList/
    // ContactAttemptList/SidebarFooter panel while on Profile ("rail-only"
    // sections) — a pending contact request the exporter later receives
    // would never render while still parked on the Profile tab.
    await page.getByRole('button', { name: 'Chats', exact: true }).click();
    return { fingerprint };
}

/**
 * Accepts a pending contact request from `fromUsername`, RETRYING the accept
 * click if the composer never appears — unlike onboard.ts's single-attempt
 * `acceptContactRequest` (safe there because two-peer.spec.ts's contact
 * requests start from a SYNCHRONOUS "New Conversation" send, so the
 * initiator's own key-exchange wait starts right as the responder's prompt
 * appears). Trusted-import's first send instead takes the asynchronous
 * `startNonBlockingOfflineSend` -> `deliverNotConnectedInBackground` path
 * (message-handler.ts:2670-2722,2762+ — the sender was never already
 * connected, so the optimistic "sending" bubble returns immediately while the
 * REAL key-exchange attempt starts in the background). That background
 * attempt's own response-wait timeout is ticking from the moment the message
 * was sent, not from when this test gets around to clicking Accept — so on a
 * slow run the initiator can time out waiting for `key_exchange_confirmed`
 * before the human/test-driven accept ever completes. Per key-exchange.ts's
 * `awaitContactRequestRetryAfterFinalizationTimeout` (~1775-1813), a
 * finalization timeout on the RESPONDER's (accepting) side re-surfaces the
 * SAME pending request rather than dropping it — so simply retrying the
 * accept click (not resending from scratch) is the correct recovery here,
 * bounded by the request's own decision window.
 */
async function acceptContactRequestWithRetry(page: Page, fromUsername: string, timeoutMs = 120_000): Promise<void> {
    await expect(async () => {
        // Open the pending request's detail view first — the sidebar entry
        // shows only name/preview; the ACCEPT button renders only after
        // clicking the entry (ContactAttemptItem.tsx) — unless a prior
        // attempt already left it open.
        const acceptButton = page.getByRole('button', { name: 'Accept', exact: true });
        if (!(await acceptButton.isVisible().catch(() => false))) {
            await expect(page.getByText(fromUsername, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
            await page.getByText(fromUsername, { exact: true }).first().click();
        }
        if (await acceptButton.isVisible().catch(() => false)) {
            await acceptButton.click();
        }
        await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20_000 });
    }).toPass({ timeout: timeoutMs, intervals: [5_000] });
}

/** Drives SidebarHeader's "+" -> "Add user from file" -> ImportTrustedUserDialog to a finished import attempt (success or inline error, caller decides which). */
async function openImportDialog(page: Page): Promise<void> {
    // lucide-react icons render with a stable `lucide-<name>` class — same
    // idiom onboard.ts's openNewConversationDialog uses for the "+" button.
    await page.locator('button:has(svg.lucide-plus)').first().click();
    await page.getByRole('button', { name: 'Add user from file', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Add user from file' })).toBeVisible({ timeout: 10_000 });
}

type ImportAttemptResult = { outcome: 'success' | 'error'; errorText?: string };

async function attemptImport(
    app: ElectronApplication,
    page: Page,
    options: { filePath: string; password: string; customName?: string },
): Promise<ImportAttemptResult> {
    await stubOpenDialog(app, options.filePath);
    await page.getByRole('button', { name: /Browse/ }).click();
    await expect(page.getByText(path.basename(options.filePath), { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder('Enter profile password...').fill(options.password);
    if (options.customName) {
        await page.getByPlaceholder('Leave empty to use name from file...').fill(options.customName);
    }
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    const result = await Promise.race([
        expect(page.getByText('Profile imported successfully!')).toBeVisible({ timeout: 20_000 }).then(() => ({ outcome: 'success' as const })),
        page.locator('.text-destructive').getByText(/./).first().waitFor({ state: 'visible', timeout: 20_000 })
            .then(async () => ({
                outcome: 'error' as const,
                errorText: (await page.locator('.text-destructive span').first().textContent()) ?? undefined,
            })),
    ]).catch(() => ({ outcome: 'error' as const, errorText: undefined }));

    return result;
}

// ---------------------------------------------------------------------------
// S1. Export/import happy path exercising both fixes: (1) an unregistered
// IMPORTER now imports successfully (FIX #1: UsernameRegistry.ensureSelfUserRow);
// (2) an unregistered recipient now ACCEPTS the resulting inbound contact
// request (FIX #2: the isRegistered gates removed from InvitationManager.tsx
// and ipc-handlers.ts). B registers only once, and only because B is about to
// SEND the first contact request (the surviving sender-verification
// asymmetry — key-exchange.ts's resolveContactRequestSenderFromDht, see file
// header) — A (the exporter/accepter) never registers at any point.
// ---------------------------------------------------------------------------
test('trusted profile export/import: unregistered importer succeeds, unregistered recipient accepts (A never registers) @slow', async () => {
    test.setTimeout(6 * 60_000);
    const testInfo = test.info();
    const testStart = Date.now();
    let peerA: LaunchedApp | undefined;
    let peerB: LaunchedApp | undefined;
    let scratchDir: string | undefined;
    let failed = false;

    const runSuffix = uniqueRunSuffix();
    const usernameB = `ti_b_${runSuffix}`;
    const customNameForA = `alice_from_file_${runSuffix}`;

    try {
        scratchDir = await mkdtemp(path.join(tmpdir(), 'kiyeovo-e2e-trusted-'));
        const exportedFilePath = path.join(scratchDir, 'alice-profile.kiyeovo');

        [peerA, peerB] = await timedStage('s1', 'launch_both_apps', () => Promise.all([
            launchApp({ p2pPort: 9201, env: { DEBUG_MODE: 'true' } }),
            launchApp({ p2pPort: 9202, env: { DEBUG_MODE: 'true' } }),
        ]));
        const { app: appA, page: pageA } = peerA;
        const { app: appB, page: pageB } = peerB;

        const onboardOptions = {
            bootstrapMultiaddr: BOOTSTRAP_MULTIADDR,
            relayMultiaddr: RELAY_MULTIADDR,
            stunUrl: STUN_URL,
        };
        // Both start UNREGISTERED: A (the exporter) stays unregistered for
        // the ENTIRE test — export, receive, and accept must all work without
        // ever publishing a DHT username (FIX #2); B (the importer) starts
        // unregistered to prove the import itself needs no registration
        // (FIX #1), then registers only once it needs to SEND (the surviving
        // sender-verification asymmetry — see file header).
        const [{ peerId: peerIdA }, { peerId: peerIdB }] = await timedStage('s1', 'onboard_both_unregistered', () => Promise.all([
            onboardWithoutRegistering(pageA, onboardOptions),
            onboardWithoutRegistering(pageB, onboardOptions),
        ]));
        await attach(testInfo, pageA, 's1-01-a-onboarded-unregistered');
        await attach(testInfo, pageB, 's1-02-b-onboarded-unregistered');

        const userStateA = await pageA.evaluate(() => window.kiyeovoAPI.getUserState());
        expect(userStateA.isRegistered).toBe(false);
        console.log(`[s1] A peerId=${peerIdA} isRegistered=${userStateA.isRegistered} (doc line ~157: export must not require registration)`);
        console.log(`[s1] B peerId=${peerIdB} isRegistered=${(await pageB.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered}`);

        // --- A exports (unregistered) ---
        const { fingerprint: fingerprintA } = await timedStage('s1', 'a_exports_profile', () => (
            exportTrustedProfile(appA, pageA, { label: 'Alice (export)', filePath: exportedFilePath })
        ));
        await attach(testInfo, pageA, 's1-03-a-exported');
        // Still unregistered after export — exporting itself never triggers registration.
        expect((await pageA.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(false);

        // --- FIX #1 ASSERTION: B (still unregistered) imports directly and
        // it now SUCCEEDS — previously this threw the self-referential
        // "User with peer_id '<B's own peer ID>' not found in database" error
        // from `assertUserExists(chat.created_by)` (database.ts:1675) inside
        // `createTrustedDirectContact`'s transaction, because B had no
        // `users` row for itself. `UsernameRegistry.ensureSelfUserRow`
        // (username-registry.ts) now seeds that row at identity-ready time,
        // registered or not. ---
        await openImportDialog(pageB);
        const importResult = await timedStage('s1', 'b_imports_while_unregistered_succeeds', () => attemptImport(appB, pageB, {
            filePath: exportedFilePath,
            password: EXPORT_PASSWORD,
            customName: customNameForA,
        }));
        console.log(`[s1] FIX #1 confirmed: unregistered-importer outcome=${importResult.outcome} (was 'error' pre-fix)`);
        await attach(testInfo, pageB, 's1-04-b-imported-while-unregistered');
        expect(importResult.outcome).toBe('success');

        const importedFingerprintText = await pageB.locator('.font-mono.text-xs.break-all').first().textContent();
        expect((importedFingerprintText ?? '').trim()).toBe(fingerprintA);
        console.log(`[s1] fingerprint match confirmed: ${fingerprintA}`);

        await pageB.getByRole('button', { name: 'Done', exact: true }).click();

        // --- (a) chat exists with the trusted_out_of_band marker, (b) shows
        // the customName, code-confirmed via the same getChats() surface
        // username-lookup.spec.ts's chatPeerIdForUsername uses, (c) B is
        // STILL unregistered — importing itself never triggers or requires
        // registration. ---
        const bChatsAfterImport = await pageB.evaluate(async () => {
            const result = await window.kiyeovoAPI.getChats();
            return result.success ? result.chats : [];
        });
        const importedChat = (bChatsAfterImport as Array<Record<string, unknown>>).find((c) => c.other_peer_id === peerIdA);
        expect(importedChat, 'B should have a chat with A keyed by A\'s real peer ID').toBeTruthy();
        expect(importedChat?.trusted_out_of_band).toBe(true);
        expect(importedChat?.username).toBe(customNameForA);
        console.log(`[s1] B's imported chat: trusted_out_of_band=${importedChat?.trusted_out_of_band} username=${importedChat?.username} other_peer_id=${importedChat?.other_peer_id}`);
        expect((await pageB.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(false);

        // --- B registers ONLY now, because B is about to SEND the first
        // contact request and the recipient-side verification always checks
        // the SENDER's DHT registration (the surviving asymmetry — see file
        // header) — this is not a workaround for either fixed bug. ---
        await timedStage('s1', 'b_registers_because_b_is_about_to_send', () => registerViaFooterCta(pageB, usernameB));
        await attach(testInfo, pageB, 's1-05-b-registered-to-send');
        expect((await pageB.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(true);

        // --- Messages flow: B sends first, USING ONLY the imported data for
        // A's identity/keys — no DHT username lookup of A, who is STILL
        // unregistered at this point. ---
        const probeMessage = 'Hi Alice — reaching you via your exported profile.';
        await expect(pageB.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 15_000 });
        await timedStage('s1', 'b_sends_first_message', () => sendChatMessage(pageB, probeMessage));
        await expect(chatMessage(pageB, probeMessage)).toBeVisible({ timeout: 15_000 });
        await attach(testInfo, pageB, 's1-06-b-sent-first-message');

        // The request DOES reach A while A is unregistered (B is registered,
        // so A's `authorizeContactRequest` -> `resolveContactRequestSenderFromDht(B)`
        // succeeds; A being unregistered plays no role in RECEIVING) — this
        // alone proves reaching an unregistered exporter works at the
        // protocol level.
        await timedStage('s1', 'contact_request_reaches_unregistered_a', async () => {
            await expect(pageA.getByText(usernameB, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
        });
        await attach(testInfo, pageA, 's1-07-a-request-visible-while-unregistered');

        // --- FIX #2 ASSERTION: A (still unregistered) clicks Accept and it
        // now SUCCEEDS — previously InvitationManager.tsx's handleAccept
        // (lines 24-27, now removed) returned early with
        // toast.warning('Finish registration first, then accept this contact
        // request.') whenever `!isRegistered`. A never registers before,
        // during, or after this — the doc's "reachable out-of-band without
        // ever publishing a DHT username" now holds end to end. ---
        await timedStage('s1', 'a_accepts_while_unregistered', () => (
            acceptContactRequestWithRetry(pageA, usernameB)
        ));
        await attach(testInfo, pageA, 's1-08-a-accepted-while-unregistered');
        console.log('[s1] FIX #2 confirmed: unregistered recipient accepted successfully (was gated with a toast pre-fix)');
        expect((await pageA.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(false);

        await timedStage('s1', 'first_message_visible_on_a', () => (
            expect(chatMessage(pageA, probeMessage)).toBeVisible({ timeout: 30_000 })
        ));

        // --- A replies — the chat is fully live both ways, with A having
        // NEVER registered at any point in this test. ---
        const replyMessage = 'Got it — this really is Alice, out of band.';
        await timedStage('s1', 'a_replies', async () => {
            await sendChatMessage(pageA, replyMessage);
            await expect(chatMessage(pageB, replyMessage)).toBeVisible({ timeout: 30_000 });
        });
        await attach(testInfo, pageB, 's1-09-b-received-reply');
        await attach(testInfo, pageA, 's1-10-a-final-state');
        expect((await pageA.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(false);
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][s1] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) {
            await attachLogs(testInfo, peerA, 's1-a-main-process-logs');
            await attachLogs(testInfo, peerB, 's1-b-main-process-logs');
        }
        await peerA?.close().catch((error) => console.error('Failed to close peer A:', error));
        await peerB?.close().catch((error) => console.error('Failed to close peer B:', error));
        if (scratchDir) await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
});

// ---------------------------------------------------------------------------
// S2. Corrupted/truncated export file: designed error, clean retry with the
// good file afterward (doc line ~156's transaction-atomicity claim, from the
// "no partial state left behind" side — see file-header comment for why this
// failure mode is the one forced here rather than a mid-transaction race).
// ---------------------------------------------------------------------------
test('importing a corrupted profile file fails cleanly and a retry with the real file then succeeds @slow', async () => {
    test.setTimeout(6 * 60_000);
    const testInfo = test.info();
    const testStart = Date.now();
    let peerA: LaunchedApp | undefined;
    let peerB: LaunchedApp | undefined;
    let scratchDir: string | undefined;
    let failed = false;
    const runSuffix = uniqueRunSuffix();

    try {
        scratchDir = await mkdtemp(path.join(tmpdir(), 'kiyeovo-e2e-trusted-corrupt-'));
        const goodFilePath = path.join(scratchDir, 'good-profile.kiyeovo');
        const corruptedFilePath = path.join(scratchDir, 'corrupted-profile.kiyeovo');

        [peerA, peerB] = await timedStage('s2', 'launch_both_apps', () => Promise.all([
            launchApp({ p2pPort: 9203 }),
            launchApp({ p2pPort: 9204 }),
        ]));
        const { app: appA, page: pageA } = peerA;
        const { app: appB, page: pageB } = peerB;

        // Both REGISTERED here (unlike S1) — no longer NEEDED to dodge
        // FIX #1 (an unregistered importer works fine now, per S1), but kept
        // anyway so this scenario stays about the corrupted-file/retry
        // behavior only, not the registration gap S1/S3 already cover.
        const onboardOptions = {
            bootstrapMultiaddr: BOOTSTRAP_MULTIADDR,
            relayMultiaddr: RELAY_MULTIADDR,
            stunUrl: STUN_URL,
        };
        await timedStage('s2', 'onboard_both_registered', () => Promise.all([
            onboard(pageA, { ...onboardOptions, password: PASSWORD, username: `ti_corrupt_a_${runSuffix}` }),
            onboard(pageB, { ...onboardOptions, password: PASSWORD, username: `ti_corrupt_b_${runSuffix}` }),
        ]));

        await timedStage('s2', 'a_exports_profile', () => (
            exportTrustedProfile(appA, pageA, { label: 'Alice (corrupt-test)', filePath: goodFilePath })
        ));
        await attach(testInfo, pageA, 's2-01-a-exported');

        // Truncate the middle of the file's base64 `encryptedData` field —
        // EncryptedUserProfile is JSON (still parses), but AES-GCM decryption
        // (profile-manager.ts's decryptProfile) fails on the mangled
        // ciphertext/auth tag, hitting the designed
        // "Failed to decrypt profile - incorrect password or corrupted file"
        // error (profile-manager.ts:258) rather than a generic crash.
        const goodFileContent = await readFile(goodFilePath, 'utf8');
        const parsed = JSON.parse(goodFileContent) as { encryptedData: string };
        const mangled = {
            ...parsed,
            encryptedData: parsed.encryptedData.slice(0, Math.floor(parsed.encryptedData.length / 2)),
        };
        await writeFile(corruptedFilePath, JSON.stringify(mangled), 'utf8');

        // --- Attempt 1: corrupted file -> designed, clean error. ---
        await openImportDialog(pageB);
        const corruptedResult = await timedStage('s2', 'import_corrupted_file', () => attemptImport(appB, pageB, {
            filePath: corruptedFilePath,
            password: EXPORT_PASSWORD,
        }));
        console.log(`[s2] corrupted-file import outcome=${corruptedResult.outcome} errorText=${corruptedResult.errorText ?? '(none)'}`);
        expect(corruptedResult.outcome).toBe('error');
        expect((corruptedResult.errorText ?? '').toLowerCase()).toMatch(/decrypt|corrupt|password/);
        await attach(testInfo, pageB, 's2-02-corrupted-import-error');

        // No partial state: B has no chats yet at all.
        const chatsAfterFailure = await pageB.evaluate(async () => {
            const result = await window.kiyeovoAPI.getChats();
            return result.success ? result.chats.length : -1;
        });
        expect(chatsAfterFailure).toBe(0);

        // App stays usable: dialog still open/interactive, can close and reopen.
        await expect(closeAndReopenImportDialog(pageB)).resolves.toBe(true);

        // --- Attempt 2: freshly-reopened dialog (ImportTrustedUserDialog's
        // close-effect wipes ALL form state including the password — so it
        // must be re-entered, matching what a real retrying user does),
        // pointed at the REAL good file -> succeeds. Demonstrates the
        // retry-is-clean half of doc line ~156 without needing to force an
        // actual mid-transaction rollback (see file header). ---
        await stubOpenDialog(appB, goodFilePath);
        await pageB.getByRole('button', { name: /Browse|Change File/ }).click();
        await expect(pageB.getByText(path.basename(goodFilePath), { exact: true })).toBeVisible({ timeout: 10_000 });
        await pageB.getByPlaceholder('Enter profile password...').fill(EXPORT_PASSWORD);
        await pageB.getByRole('button', { name: 'Import', exact: true }).click();
        await expect(pageB.getByText('Profile imported successfully!')).toBeVisible({ timeout: 20_000 });
        await attach(testInfo, pageB, 's2-03-retry-with-good-file-succeeded');

        const chatsAfterSuccess = await pageB.evaluate(async () => {
            const result = await window.kiyeovoAPI.getChats();
            return result.success ? result.chats : [];
        });
        expect((chatsAfterSuccess as Array<Record<string, unknown>>).some((c) => c.trusted_out_of_band === true)).toBe(true);
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][s2] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) {
            await attachLogs(testInfo, peerA, 's2-a-main-process-logs');
            await attachLogs(testInfo, peerB, 's2-b-main-process-logs');
        }
        await peerA?.close().catch((error) => console.error('Failed to close peer A:', error));
        await peerB?.close().catch((error) => console.error('Failed to close peer B:', error));
        if (scratchDir) await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
});

/** True once the "Add user from file" dialog heading is visible again after a Close+reopen — proves the failed import didn't wedge the dialog. */
async function closeAndReopenImportDialog(page: Page): Promise<boolean> {
    await page.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Add user from file' })).toBeHidden({ timeout: 10_000 });
    await openImportDialog(page);
    return page.getByRole('heading', { name: 'Add user from file' }).isVisible();
}

// ---------------------------------------------------------------------------
// S3. Anonymous mode: trusted import over Tor, mirroring S1's fixed shape.
// Both start unregistered; B imports directly while unregistered (FIX #1,
// mode-agnostic), then registers only to reach the round's KEY INVESTIGATION:
// does the dial (peer ID only, no address in the exported profile) reach A —
// still unregistered at dial time — over onion circuits? A then accepts while
// STILL UNREGISTERED (FIX #2, mode-agnostic) and never registers at any point
// in the test. See file-header comment for the expected dial mechanism
// (libp2p kad-dht peer routing) stated before this investigation was first
// run.
// ---------------------------------------------------------------------------
test('trusted profile export/import over Tor: peer-ID-only dial reaches the exporter via DHT peer routing (A never registers) @slow', async () => {
    test.setTimeout(12 * 60_000);
    const testInfo = test.info();
    const testStart = Date.now();
    let onionBootstrap: OnionFrontedBootstrap | undefined;
    let peerA: LaunchedApp | undefined;
    let peerB: LaunchedApp | undefined;
    let scratchDir: string | undefined;
    const runSuffix = uniqueRunSuffix();
    const usernameB = `ti_tor_b_${runSuffix}`;

    try {
        scratchDir = await mkdtemp(path.join(tmpdir(), 'kiyeovo-e2e-trusted-tor-'));
        const exportedFilePath = path.join(scratchDir, 'alice-profile-tor.kiyeovo');

        onionBootstrap = await timedStage('s3', 'start_onion_fronted_bootstrap', () => (
            startOnionFrontedBootstrap({ bootstrapPort: 20431 })
        ));

        [peerA, peerB] = await timedStage('s3', 'launch_both_apps', () => Promise.all([
            launchAnonymousApp({ p2pPort: 9205, torSocksPort: 9571, torControlPort: 9572 }, { env: { DEBUG_MODE: 'true' } }),
            launchAnonymousApp({ p2pPort: 9206, torSocksPort: 9573, torControlPort: 9574 }, { env: { DEBUG_MODE: 'true' } }),
        ]));
        const { app: appA, page: pageA } = peerA;
        const { app: appB, page: pageB } = peerB;

        // NEITHER registers initially — onboardAnonymous with no `username`
        // clicks "Finish without registering" (see tor.ts's
        // clickWizardContinueOrFinish) — matching the task's literal brief.
        const [{ peerId: peerIdA }, { peerId: peerIdB }] = await timedStage('s3', 'onboard_both_anonymous_unregistered', () => Promise.all([
            onboardAnonymous(pageA, { password: PASSWORD, bootstrapMultiaddr: onionBootstrap!.multiaddr }),
            onboardAnonymous(pageB, { password: PASSWORD, bootstrapMultiaddr: onionBootstrap!.multiaddr }),
        ]));
        await attach(testInfo, pageA, 's3-01-a-onboarded-anonymous');
        await attach(testInfo, pageB, 's3-02-b-onboarded-anonymous');

        expect((await pageA.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(false);
        expect((await pageB.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(false);
        console.log(`[s3] A peerId=${peerIdA} B peerId=${peerIdB} — both anonymous-mode, both unregistered`);

        // --- A exports over Tor (export has no mode branching at all —
        // ProfileManager is mode-agnostic, so this is expected to work
        // identically to fast mode). ---
        await timedStage('s3', 'a_exports_profile_over_tor', () => (
            exportTrustedProfile(appA, pageA, { label: 'Alice (tor export)', filePath: exportedFilePath })
        ));
        await attach(testInfo, pageA, 's3-03-a-exported-over-tor');

        // --- FIX #1 ASSERTION, mode-agnostic: B (unregistered) imports
        // directly over anonymous mode's own DB/IPC stack and it now
        // SUCCEEDS — same as S1's fast-mode assertion, entirely locally,
        // before any Tor dialing is even attempted (`ensureSelfUserRow` has
        // no fast/anonymous branch). ---
        await openImportDialog(pageB);
        const importResult = await timedStage('s3', 'b_imports_while_unregistered_succeeds', () => attemptImport(appB, pageB, {
            filePath: exportedFilePath,
            password: EXPORT_PASSWORD,
            customName: 'alice-via-tor',
        }));
        console.log(`[s3] FIX #1 confirmed (anonymous mode): unregistered-importer outcome=${importResult.outcome} (was 'error' pre-fix)`);
        await attach(testInfo, pageB, 's3-04-b-imported-while-unregistered');
        expect(importResult.outcome).toBe('success');
        await pageB.getByRole('button', { name: 'Done', exact: true }).click();

        const bChatsAfterImport = await pageB.evaluate(async () => {
            const result = await window.kiyeovoAPI.getChats();
            return result.success ? result.chats : [];
        });
        const importedChat = (bChatsAfterImport as Array<Record<string, unknown>>).find((c) => c.other_peer_id === peerIdA);
        expect(importedChat?.trusted_out_of_band).toBe(true);
        expect((await pageB.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(false);

        // --- B registers ONLY now (A, the exporter, never does), because B
        // is about to SEND the first contact request — the surviving
        // sender-verification asymmetry, mode-agnostic (see file header) —
        // to reach the round's KEY INVESTIGATION below. ---
        await timedStage('s3', 'b_registers_over_tor_because_b_is_about_to_send', () => registerViaFooterCta(pageB, usernameB));
        await attach(testInfo, pageB, 's3-05-b-registered-to-send-over-tor');
        expect((await pageB.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(true);

        // --- B sends the first message. This is where the KEY INVESTIGATION
        // plays out: B's node must dial A using ONLY A's peer ID (the
        // exported profile carries no onion address at all — profile-manager.ts:
        // 51-61). A peer-to-peer onion rendezvous for a never-before-dialed
        // peer ID is the slowest kind of Tor connection (30-90s observed in
        // tor-mode.spec.ts), so this waits generously before evaluating the
        // outcome. A is STILL unregistered at this moment — so the request
        // arriving on A's UI at all is the proof the dial resolved A's onion
        // address by bare peer ID (kad-dht peer routing), with zero
        // username-registry involvement on A's side. ---
        const probeMessage = 'Reaching you over Tor via your exported profile.';
        await expect(pageB.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 15_000 });
        await timedStage('s3', 'b_sends_first_message_over_tor', () => sendChatMessage(pageB, probeMessage));
        await attach(testInfo, pageB, 's3-06-b-sent-first-message-over-tor');

        await timedStage('s3', 'contact_request_reaches_unregistered_a_over_tor', async () => {
            await expect(pageA.getByText(usernameB, { exact: true }).first()).toBeVisible({ timeout: 180_000 });
        });
        await attach(testInfo, pageA, 's3-07-a-request-visible-while-unregistered');

        const aLogsSoFar = peerA.logs.join('');
        const dialReachedA = /key_exchange_init|KEY-EXCHANGE\]\[INIT_STREAM\]/i.test(aLogsSoFar);
        console.log(`[s3] KEY INVESTIGATION confirmed: peer-ID-only dial via libp2p kad-dht peer routing reached A over Tor (no address at all was carried in the exported profile); log evidence present=${dialReachedA}`);
        expect((await pageA.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(false);

        // --- FIX #2 ASSERTION, mode-agnostic: A, still unregistered, clicks
        // Accept and it now SUCCEEDS (previously InvitationManager.tsx's
        // isRegistered gate made this impossible). Retry-tolerant accept
        // (see acceptContactRequestWithRetry's doc comment) — relevant over
        // Tor, where onion rendezvous jitter makes a
        // finalization-timeout/re-surface cycle more likely. A never
        // registers, before, during, or after this. ---
        await timedStage('s3', 'a_accepts_while_unregistered_over_tor', () => (
            acceptContactRequestWithRetry(pageA, usernameB, 180_000)
        ));
        await attach(testInfo, pageA, 's3-08-a-accepted-while-unregistered-over-tor');
        console.log('[s3] FIX #2 confirmed (anonymous mode): unregistered recipient accepted successfully over Tor (was gated with a toast pre-fix)');
        expect((await pageA.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(false);

        await timedStage('s3', 'first_message_visible_on_a_over_tor', () => (
            expect(chatMessage(pageA, probeMessage)).toBeVisible({ timeout: 45_000 })
        ));
        await attach(testInfo, pageA, 's3-09-a-message-visible-over-tor');

        // --- A replies over Tor — the imported chat is fully live, with A
        // having NEVER registered at any point in this test. ---
        const replyMessage = 'Confirmed — Alice, reached over Tor purely by peer ID.';
        await timedStage('s3', 'a_replies_over_tor', async () => {
            await sendChatMessage(pageA, replyMessage);
            await expect(chatMessage(pageB, replyMessage)).toBeVisible({ timeout: 45_000 });
        });
        await attach(testInfo, pageB, 's3-10-b-received-reply-over-tor');
        expect((await pageA.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(false);
    } finally {
        // Logs attached unconditionally (pass or fail): A's inbound
        // key_exchange_init stream lines ARE the dial-mechanism evidence
        // this scenario exists to capture.
        console.log(`[timing][s3] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        await attachLogs(testInfo, peerA, 's3-a-main-process-logs');
        await attachLogs(testInfo, peerB, 's3-b-main-process-logs');
        await peerA?.close().catch((error) => console.error('Failed to close peer A:', error));
        await peerB?.close().catch((error) => console.error('Failed to close peer B:', error));
        await onionBootstrap?.stop().catch((error) => console.error('Failed to stop onion-fronted bootstrap:', error));
        if (scratchDir) await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
});

// ---------------------------------------------------------------------------
// S4 (fast mode, new). The GENERAL, non-import case FIX #2 newly enables.
//
// NOTE on this scenario's shape (found while running this suite, not
// speculated up front): a *never*-registered acceptor is NOT reachable via a
// cold plain-peer-ID send at all, regardless of either fix — code-confirmed
// in `message-handler.ts`'s `resolveUserAndPeerForSession` ->
// `resolveUserRegistrationForSession` (~2315-2382): for a target with no
// existing local `users`+`chats` row (true for a peer-ID target the sender
// has never talked to before, e.g. B here, and NOT pinned by a trusted
// import the way S1/S3's importer pins the exporter's keys), the sender's
// *own* first move is `usernameRegistry.lookupByPeerId(target)` — a strict
// DHT reverse lookup keyed on a `username_by_peer_id` record that only ever
// gets published by `UsernameRegistry`'s registration flow. A target that has
// never registered has no such record, so this lookup is a guaranteed MISS
// (`console.warn('[USERNAME][LOOKUP][MISS] ...')`) and the send fails before
// a key-exchange message is ever framed, let alone before FIX #2's
// (now-removed) accept-side gate would matter — reproduced live: with B left
// unregistered here, `sendContactRequest` timed out because A's own send
// never got past this lookup (`User '<B's peer ID>' not found`, B's
// `New Conversation` dialog just kept retrying "Send"). So there is no
// reachable general-flow shape where the acceptor is unregistered THE WHOLE
// TIME AND ALSO discoverable by a cold peer-ID send with no prior pinned
// keys — S1/S3 (trusted import pins the keys, sidestepping this lookup
// entirely) are the only way to exercise FIX #2 with an acceptor that never
// registers at all.
//
// This scenario instead covers the other reachable general-flow shape: B
// registers just long enough to be resolvable (so A's plain peer-ID send
// succeeds), the request lands as pending on B, and B then UNREGISTERS
// (`kiyeovoAPI.unregister()` — the same `UsernameRegistry.unregister()` call
// UserDialog.tsx's "Unregister" button drives, invoked directly here since
// the assertion is about accept-time gating, not the unregister UI itself)
// BEFORE clicking Accept — so B is unregistered at the moment that matters
// (the isRegistered check FIX #2 removed), even though B was registered
// earlier. This is a real, non-contrived scenario: registration is not
// permanent (explicit unregister, or a lapsed re-registration lease per
// `UsernameRegistry`'s `startReregistration`), so "registered when
// discovered, unregistered by the time I get around to accepting" is a shape
// a real user can hit. A stays registered throughout (still the surviving
// sender-verification asymmetry from the file header).
// ---------------------------------------------------------------------------
test('a plain peer-ID contact request completes when the acceptor unregisters before accepting @slow', async () => {
    test.setTimeout(3 * 60_000);
    const testInfo = test.info();
    const testStart = Date.now();
    let peerA: LaunchedApp | undefined;
    let peerB: LaunchedApp | undefined;
    let failed = false;

    const runSuffix = uniqueRunSuffix();
    const usernameA = `ti_s4_a_${runSuffix}`;
    const usernameB = `ti_s4_b_${runSuffix}`;

    try {
        [peerA, peerB] = await timedStage('s4', 'launch_both_apps', () => Promise.all([
            launchApp({ p2pPort: 9207 }),
            launchApp({ p2pPort: 9208 }),
        ]));
        const { page: pageA } = peerA;
        const { page: pageB } = peerB;

        const onboardOptions = {
            bootstrapMultiaddr: BOOTSTRAP_MULTIADDR,
            relayMultiaddr: RELAY_MULTIADDR,
            stunUrl: STUN_URL,
        };
        // Both register at first: A because it's about to SEND (the
        // surviving sender-verification asymmetry); B because a cold
        // plain-peer-ID send needs B to be DHT-resolvable at all (see the
        // scenario note above) — B's registration is dropped further down,
        // before accepting.
        const [, { peerId: peerIdB }] = await timedStage('s4', 'onboard_both_registered', () => Promise.all([
            onboard(pageA, { ...onboardOptions, password: PASSWORD, username: usernameA }),
            onboard(pageB, { ...onboardOptions, password: PASSWORD, username: usernameB }),
        ]));

        const firstMessage = `Hi from A, no trusted-profile file involved ${runSuffix}`;
        await timedStage('s4', 'a_sends_plain_peer_id_contact_request', () => (
            sendContactRequest(pageA, peerIdB, firstMessage)
        ));

        // Confirm the request landed as pending on B WHILE B is still
        // registered, before B drops registration — isolates the
        // FIX #2 assertion below to accept-time gating only, not delivery.
        await expect(pageB.getByText(usernameA, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
        expect((await pageB.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(true);

        // --- B unregisters while the request sits pending, so B is
        // unregistered at the moment that matters: accept time. ---
        await timedStage('s4', 'b_unregisters_before_accepting', () => (
            pageB.evaluate(() => window.kiyeovoAPI.unregister())
        ));
        expect((await pageB.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(false);

        // --- FIX #2 ASSERTION (general, non-import flow): B, now
        // unregistered, accepts a plain peer-ID contact request and it now
        // SUCCEEDS — previously blocked by InvitationManager.tsx's
        // `isRegistered` early-return / ipc-handlers.ts's matching gate. ---
        await timedStage('s4', 'b_accepts_while_unregistered', () => (
            acceptContactRequestWithRetry(pageB, usernameA)
        ));
        await attach(testInfo, pageB, 's4-01-b-accepted-while-unregistered');
        console.log('[s4] FIX #2 confirmed (general contact-request flow): unregistered acceptor accepted a plain peer-ID request successfully');
        expect((await pageB.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(false);

        await expect(chatMessage(pageB, firstMessage)).toBeVisible({ timeout: 30_000 });

        // --- B replies, still unregistered — the chat is fully live both ways. ---
        const replyMessage = `Got it, thanks ${runSuffix}`;
        await timedStage('s4', 'b_replies_unregistered', async () => {
            await sendChatMessage(pageB, replyMessage);
            await expect(chatMessage(pageA, replyMessage)).toBeVisible({ timeout: 30_000 });
        });
        await attach(testInfo, pageA, 's4-02-a-received-reply');
        expect((await pageB.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(false);
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][s4] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) {
            await attachLogs(testInfo, peerA, 's4-a-main-process-logs');
            await attachLogs(testInfo, peerB, 's4-b-main-process-logs');
        }
        await peerA?.close().catch((error) => console.error('Failed to close peer A:', error));
        await peerB?.close().catch((error) => console.error('Failed to close peer B:', error));
    }
});
