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
// onboarding). ZERO prior e2e coverage in any mode before this file.
//
// MANDATORY READING done before writing anything below: e2e/README.md,
// e2e/config.ts's PORT RANGES table, e2e/electron.ts, e2e/onboard.ts,
// e2e/bootstrap-node.ts, e2e/tor.ts, tor-mode.spec.ts, username-lookup.spec.ts;
// Kiyeovo_desktop_technical_documentation.md lines ~145-165 (trusted profile
// section); src/core/identity/profile-manager.ts (ProfileManager.
// exportProfileDesktop/importTrustedUser), src/core/db/database.ts
// (createTrustedDirectContact's one-transaction insert), src/core/lib/
// message-handler.ts (maybeUpgradeTrustedOutOfBandChat, sendMessage's
// initialUser/offline-bucket branch), src/core/direct/key-exchange.ts
// (initiateKeyExchange, authorizeContactRequest, resolveContactRequestSenderFromDht),
// src/core/transport/protocol-dialer.ts (dialProtocolWithRelayFallback), plus
// the UI: src/ui/components/sidebar/profile/ExportDialog.tsx (+ ProfilePage.tsx,
// which mounts it — reachable via the sidebar rail's "Profile" tab) and
// src/ui/components/sidebar/header/ImportTrustedUserDialog.tsx (reachable via
// SidebarHeader's "+" dropdown -> "Add user from file").
//
// Every claim below is labeled doc-confirmed / code-confirmed / unverified.
//
// --- MAJOR FINDINGS (both empirically reproduced, then code-traced; they
// drive S1's and S3's shapes) ---
// The doc (line ~157) says export "does not require registration ... so a
// peer can export and be reachable out-of-band without ever publishing a DHT
// username". In the current build that story breaks on BOTH ends:
//
// FINDING #1 — an unregistered IMPORTER cannot import at all. The "Add user
// from file" entry point is never gated behind `isRegistered` in the UI
// (unlike "New Conversation", which explicitly is — SidebarHeader.tsx's
// `handleShowNewConversationDialog` vs. `handleShowImportTrustedUserDialog`),
// and neither the doc nor the dialog warns about registration — yet a
// genuinely-unregistered importer's FIRST-EVER import always fails, with a
// raw, confusing, self-referential error: `User with peer_id '<the
// IMPORTER'S OWN peer ID>' not found in database`. Root cause: EVERY
// chat-creation path in `database.ts` — both the normal `createChat` (line
// 1657) and `createTrustedDirectContact` (line 1675, used by trusted import)
// — calls `assertUserExists(chat.created_by, mode)` where `chat.created_by`
// is always the LOCAL identity's OWN peer ID, i.e. every chat-creation call
// asserts the caller already has a `users` row for THEMSELVES. But nothing
// in this app ever inserts a self-row into `users` except one path:
// `UsernameRegistry.persistRegisteredUser` (username-registry.ts:539-566),
// which only runs after a SUCCESSFUL username registration. `users` is
// otherwise exclusively a contacts table (`insertUser`/`createUser`'s only
// other call sites all pass a REMOTE peer's data — key-exchange.ts:331,1274,
// 2744; group-responder.ts:474,631). So an unregistered identity has no
// `users` row for itself at all, and `assertUserExists(self)` throws on its
// very first chat-creation attempt of any kind.
//
// FINDING #2 — an unregistered EXPORTER cannot ACCEPT the resulting inbound
// contact request. The export itself works unregistered (code-confirmed:
// ProfileManager.exportProfileDesktop, profile-manager.ts:33-94, has no
// registration check; empirically confirmed in S1/S3), and the importer's
// contact request genuinely REACHES the unregistered exporter (receiving
// runs `resolveContactRequestSenderFromDht(SENDER)`, key-exchange.ts:923-929
// — it verifies the SENDER's registration, not the receiver's). But the
// Accept button is UI-gated: InvitationManager.tsx's handleAccept (lines
// 24-27) returns early with toast.warning('Finish registration first, then
// accept this contact request.') whenever `!isRegistered`. So the exporter
// can receive but never complete the contact.
//
// Net effect: the one feature explicitly pitched (doc + UI copy in
// ProfilePage.tsx: "it works even if you never register a public username")
// as usable without publishing a DHT username currently requires BOTH sides
// to register before the chat becomes live — the only genuinely
// registration-free steps are exporting the file and receiving/queuing the
// inbound request. Finding #1 additionally surfaces as an opaque
// internal-DB-shape error rather than any designed "please register first"
// message (finding #2 at least has designed copy). S1 reproduces both with
// real repros (not just code traces) before working around each by
// registering at the moment the app actually forces it.
//
// --- Scenario map ---
// S1 (fast mode). A exports fully unregistered (that step IS registration-
//   free, proven). B, also unregistered, first attempts the import to
//   reproduce FINDING #1 with the exact error text, then registers and
//   retries — now the import succeeds, (a) the resulting chat carries
//   `trusted_out_of_band: true`, (b) shows the customName, (c) B's first
//   message uses only the imported file's data for A's identity/keys — no
//   DHT username lookup of A (code-confirmed: message-handler.ts:3009-3010's
//   `getUserByPeerIdThenUsername` finds the locally-imported row before any
//   lookup is attempted, and key-exchange.ts:591's
//   `resolveRecipientOfflinePublicKeyBase64` checks the local DB row BEFORE
//   falling back to `usernameRegistry.lookupByPeerId`) — and the request
//   reaches the still-unregistered A. Then FINDING #2 is reproduced (A's
//   Accept click only yields the "Finish registration first" toast), A
//   registers, accepts, the message lands, and A replies — the chat is live
//   both ways.
// S2 (fast mode). Corrupted/truncated export file: ProfileManager.importProfile
//   (profile-manager.ts:97-125) JSON.parses the file then AES-GCM-decrypts it
//   (profile-manager.ts:237-260) BEFORE any database call is made at all, so a
//   truncated/corrupted file fails at the decrypt step with the designed
//   "Failed to decrypt profile - incorrect password or corrupted file" message
//   (profile-manager.ts:258) and never reaches `createTrustedDirectContact`'s
//   one-transaction insert (database.ts:1667-1682) — i.e. this failure mode
//   demonstrates the RETRY half of doc line ~156 ("chat creation failure rolls
//   back the contact insert and leaves retries clean") by construction: no
//   partial state is ever written for a pre-transaction failure, so importing
//   the ORIGINAL good file right after must succeed with no cleanup needed.
//   Chosen over the "re-import an already-imported profile" alternative
//   because it is the one that can actually be forced deterministically
//   in-process (a corrupted byte), rather than needing a real mid-transaction
//   failure (which would need a genuine `insertUser`/`insertChatWithParticipants`
//   race — see the file's final-report notes on this). Both peers are fully
//   REGISTERED in this scenario (unlike S1/S3) — deliberately, to keep this
//   scenario about the corrupted-file/retry behavior only, not re-litigate
//   the importer-registration finding above.
// S3 (Tor mode, 12-min budget per the round-6 carryover). Two anonymous
//   instances. The task's literal brief says "neither registers" — tried
//   first, and (as expected from S1's finding, which is mode-agnostic: the
//   `assertUserExists`/`persistRegisteredUser` code path has no fast/
//   anonymous branching) B's import fails immediately with the same
//   self-referential "not found in database" error, entirely LOCALLY, before
//   any Tor dialing happens at all. B then registers (A, the exporter, stays
//   unregistered through export, import, and the inbound dial — registering
//   only at the very end, when finding #2's Accept gate forces it) and
//   retries, to actually reach the round's KEY INVESTIGATION
//   (traced in code before writing this test): the exported profile (UserProfilePlaintext,
//   profile-manager.ts:51-61) carries username, peerId, signingPublicKey,
//   offlinePublicKey, notificationsPublicKey, defaultInboxKey (=the shared
//   secret), createdAt, signature — NO network address of any kind (no onion
//   address, no multiaddr field at all). So when B dials A after import, the
//   ONLY thing available is A's bare peer ID; the dial goes through
//   dialProtocolWithRelayFallback -> `node.dialProtocol(targetPeerId, protocol)`
//   (protocol-dialer.ts), which is libp2p's OWN kad-dht peer-routing
//   (`findPeer`) resolving a PeerId to multiaddrs via the DHT routing table —
//   a completely different mechanism from the app's own username-registry DHT
//   records, and independent of whether either peer ever registered a
//   username. Expected mechanism, stated before running: as long as A is
//   connected to the shared anonymous DHT (which onboarding alone
//   guarantees, registration or not), A's onion address should be
//   peer-routable by peer ID alone. The test confirms it: B's contact
//   request reaches A while A is STILL unregistered (no username-registry
//   record for A exists anywhere at dial time — the request rendering on
//   A's UI is itself the proof of peer-ID-only routing, corroborated by
//   A's main-process key_exchange_init stream logs). A then registers
//   (finding #2's Accept gate, mode-agnostic), accepts, and replies over
//   onion circuits.
// S4: not reached (S1-S3 exhausted the budget worth spending; see final
//   report).
//
// Every scenario mints fresh uniqueRunSuffix() usernames for every
// registration it performs (all against the real, persistent public DHT in
// S1/S2; S3's registrations go to its own throwaway onion-fronted bootstrap).

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
    await testInfo.attach(name, { body: peer.logs.join(''), contentType: 'text/plain' });
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
// S1. Export/import happy path + the round's two central findings, both
// empirically reproduced before being worked around in-test: (1) an
// unregistered IMPORTER's first import fails with a self-referential DB
// error; (2) an unregistered EXPORTER cannot ACCEPT the importer's inbound
// contact request either (InvitationManager.tsx:24-27 gates Accept on
// `isRegistered` with only a toast). Net: the "no registration needed"
// trusted-profile story currently requires BOTH sides to register before the
// chat becomes live — the only genuinely registration-free steps are the
// export itself and receiving/queuing the request.
// ---------------------------------------------------------------------------
test('trusted profile export/import: unregistered importer hits a self-referential DB error, unregistered exporter cannot accept; both work after registering @slow', async () => {
    test.setTimeout(6 * 60_000);
    const testInfo = test.info();
    const testStart = Date.now();
    let peerA: LaunchedApp | undefined;
    let peerB: LaunchedApp | undefined;
    let scratchDir: string | undefined;
    let failed = false;

    const runSuffix = uniqueRunSuffix();
    const usernameA = `ti_a_${runSuffix}`;
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
        // Both start UNREGISTERED: A (the exporter) to prove the EXPORT step
        // itself and RECEIVING a contact request are registration-free, and
        // to reproduce finding #2 (the Accept gate); B (the importer) to
        // reproduce finding #1 (the self-referential import error). Both
        // findings are worked around in-test by registering at the moment
        // the app actually forces it.
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

        // --- FINDING REPRO: B (unregistered) attempts the import. Expected,
        // per the file-header trace, to fail with a self-referential
        // "not found in database" error naming B's OWN peer ID, thrown by
        // `assertUserExists(chat.created_by)` (database.ts:1675) inside
        // `createTrustedDirectContact`'s transaction — B has no `users` row
        // for itself because it never registered (only
        // `persistRegisteredUser`, username-registry.ts:539-566, ever inserts
        // a self-row). Neither the doc nor the ImportTrustedUserDialog UI
        // (never `isRegistered`-gated, unlike "New Conversation") predicts
        // this. ---
        await openImportDialog(pageB);
        const firstAttempt = await timedStage('s1', 'b_import_while_unregistered_fails', () => attemptImport(appB, pageB, {
            filePath: exportedFilePath,
            password: EXPORT_PASSWORD,
            customName: customNameForA,
        }));
        console.log(`[s1] FINDING repro: unregistered-importer outcome=${firstAttempt.outcome} errorText="${firstAttempt.errorText ?? '(none)'}"`);
        await attach(testInfo, pageB, 's1-04-b-import-failed-while-unregistered');
        expect(firstAttempt.outcome).toBe('error');
        expect(firstAttempt.errorText ?? '').toContain('not found in database');
        expect(firstAttempt.errorText ?? '').toContain(peerIdB);

        // No partial/orphaned state from the failed attempt.
        expect((await pageB.evaluate(async () => {
            const result = await window.kiyeovoAPI.getChats();
            return result.success ? result.chats.length : -1;
        }))).toBe(0);

        // --- Work around the finding: close the still-open (errored) import
        // dialog (the footer's Register CTA sits behind it), B registers
        // (the app-level equivalent of the "please register first" message
        // the UI never actually shows), THEN retries the identical import. ---
        await pageB.getByRole('button', { name: 'Close', exact: true }).first().click();
        await expect(pageB.getByRole('heading', { name: 'Add user from file' })).toBeHidden({ timeout: 10_000 });
        await timedStage('s1', 'b_registers_to_work_around_finding', () => registerViaFooterCta(pageB, usernameB));
        await attach(testInfo, pageB, 's1-05-b-registered');
        expect((await pageB.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(true);

        await openImportDialog(pageB);
        await stubOpenDialog(appB, exportedFilePath);
        await pageB.getByRole('button', { name: /Browse|Change File/ }).click();
        await expect(pageB.getByText(path.basename(exportedFilePath), { exact: true })).toBeVisible({ timeout: 10_000 });
        await pageB.getByPlaceholder('Enter profile password...').fill(EXPORT_PASSWORD);
        await pageB.getByPlaceholder('Leave empty to use name from file...').fill(customNameForA);
        await pageB.getByRole('button', { name: 'Import', exact: true }).click();
        await expect(pageB.getByText('Profile imported successfully!')).toBeVisible({ timeout: 20_000 });
        await attach(testInfo, pageB, 's1-06-b-imported-after-registering');

        const importedFingerprintText = await pageB.locator('.font-mono.text-xs.break-all').first().textContent();
        expect((importedFingerprintText ?? '').trim()).toBe(fingerprintA);
        console.log(`[s1] fingerprint match confirmed: ${fingerprintA}`);

        await pageB.getByRole('button', { name: 'Done', exact: true }).click();

        // --- (a) chat exists with the trusted_out_of_band marker, (b) shows
        // the customName, code-confirmed via the same getChats() surface
        // username-lookup.spec.ts's chatPeerIdForUsername uses. ---
        const bChats = await pageB.evaluate(async () => {
            const result = await window.kiyeovoAPI.getChats();
            return result.success ? result.chats : [];
        });
        const importedChat = (bChats as Array<Record<string, unknown>>).find((c) => c.other_peer_id === peerIdA);
        expect(importedChat, 'B should have a chat with A keyed by A\'s real peer ID').toBeTruthy();
        expect(importedChat?.trusted_out_of_band).toBe(true);
        expect(importedChat?.username).toBe(customNameForA);
        console.log(`[s1] B's imported chat: trusted_out_of_band=${importedChat?.trusted_out_of_band} username=${importedChat?.username} other_peer_id=${importedChat?.other_peer_id}`);

        // --- (c) messages flow: B sends first, USING ONLY the imported data
        // for A's identity/keys — no DHT username lookup of A, who is STILL
        // unregistered at this point. ---
        const probeMessage = 'Hi Alice — reaching you via your exported profile.';
        await expect(pageB.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 15_000 });
        await timedStage('s1', 'b_sends_first_message', () => sendChatMessage(pageB, probeMessage));
        await expect(chatMessage(pageB, probeMessage)).toBeVisible({ timeout: 15_000 });
        await attach(testInfo, pageB, 's1-07-b-sent-first-message');

        // The request DOES reach A while A is unregistered (B is registered,
        // so A's `authorizeContactRequest` -> `resolveContactRequestSenderFromDht(B)`
        // succeeds; A being unregistered plays no role in RECEIVING) — this
        // alone proves reaching an unregistered exporter works at the
        // protocol level.
        await timedStage('s1', 'contact_request_reaches_unregistered_a', async () => {
            await expect(pageA.getByText(usernameB, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
        });
        await attach(testInfo, pageA, 's1-08-a-request-visible-while-unregistered');

        // --- FINDING #2 REPRO: A (unregistered) clicks Accept -> only a
        // warning toast, no accept. Code-confirmed: InvitationManager.tsx's
        // handleAccept (lines 24-27) returns early with
        // toast.warning('Finish registration first, then accept this contact
        // request.') whenever `!isRegistered` — so the doc's "reachable
        // out-of-band without ever publishing a DHT username" (line ~157)
        // cannot complete end to end: the exporter can RECEIVE but never
        // ACCEPT while unregistered. ---
        await timedStage('s1', 'a_accept_gated_while_unregistered', async () => {
            await pageA.getByText(usernameB, { exact: true }).first().click();
            await expect(pageA.getByRole('button', { name: 'Accept', exact: true })).toBeVisible({ timeout: 15_000 });
            await pageA.getByRole('button', { name: 'Accept', exact: true }).click();
            // .first(): the same copy can render twice (toast + aria-live
            // announcement — same duplication network-edges.spec.ts documents
            // for the bootstrap error), which trips strict mode otherwise.
            await expect(pageA.getByText('Finish registration first, then accept this contact request.').first()).toBeVisible({ timeout: 10_000 });
            // Still unregistered, composer never appeared.
            await expect(pageA.getByPlaceholder('Type a message...')).toHaveCount(0);
        });
        await attach(testInfo, pageA, 's1-09-a-accept-gated-unregistered');
        expect((await pageA.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(false);

        // --- Work around finding #2: A registers (the pending request's 5-min
        // decision window — PENDING_KEY_EXCHANGE_EXPIRATION,
        // src/core/constants.ts:319 — and B's initiator wait, which covers
        // the whole window plus grace (getKeyExchangeWaitExpiresAt,
        // key-exchange.ts:81-83), both easily outlast a ~5-30s registration),
        // then accepts for real. ---
        await timedStage('s1', 'a_registers_to_work_around_accept_gate', () => registerViaFooterCta(pageA, usernameA));
        await timedStage('s1', 'a_accepts_after_registering', () => (
            acceptContactRequestWithRetry(pageA, usernameB)
        ));
        await attach(testInfo, pageA, 's1-10-a-accepted-after-registering');

        await timedStage('s1', 'first_message_visible_on_a', () => (
            expect(chatMessage(pageA, probeMessage)).toBeVisible({ timeout: 30_000 })
        ));

        // --- A replies — the chat is fully live both ways. ---
        const replyMessage = 'Got it — this really is Alice, out of band.';
        await timedStage('s1', 'a_replies', async () => {
            await sendChatMessage(pageA, replyMessage);
            await expect(chatMessage(pageB, replyMessage)).toBeVisible({ timeout: 30_000 });
        });
        await attach(testInfo, pageB, 's1-11-b-received-reply');
        await attach(testInfo, pageA, 's1-12-a-final-state');
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

        // Both REGISTERED here (unlike S1) — this scenario is deliberately
        // about the corrupted-file/retry behavior only; S1 already
        // established that an unregistered importer can't complete ANY
        // import at all (see file header), which would otherwise mask the
        // corrupted-vs-good-file distinction this test exists to isolate.
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
// S3. Anonymous mode: trusted import over Tor. First reproduces finding #1
// mode-agnostically (neither registers, exactly per the task's literal
// brief), then registers B to reach the round's KEY INVESTIGATION: does the
// dial (peer ID only, no address in the exported profile) reach A — still
// unregistered at dial time — over onion circuits? Finally reproduces
// finding #2's Accept gate for A, registers A, and completes the chat. See
// file-header comment for the expected mechanism (libp2p kad-dht peer
// routing) stated before running.
// ---------------------------------------------------------------------------
test('trusted profile export/import over Tor: peer-ID-only dial reaches the exporter via DHT peer routing @slow', async () => {
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

        // --- A exports over Tor (export has no mode branching at all —
        // ProfileManager is mode-agnostic, so this is expected to work
        // identically to fast mode). ---
        await timedStage('s3', 'a_exports_profile_over_tor', () => (
            exportTrustedProfile(appA, pageA, { label: 'Alice (tor export)', filePath: exportedFilePath })
        ));
        await attach(testInfo, pageA, 's3-03-a-exported-over-tor');

        // --- FINDING REPRO, mode-agnostic: B (unregistered) attempts the
        // import over anonymous mode's own DB/IPC stack. Expected to fail
        // with the SAME self-referential error as S1 — entirely locally,
        // before any Tor dialing is even attempted (`assertUserExists` has
        // no fast/anonymous branch). ---
        await openImportDialog(pageB);
        const firstAttempt = await timedStage('s3', 'b_import_while_unregistered_fails', () => attemptImport(appB, pageB, {
            filePath: exportedFilePath,
            password: EXPORT_PASSWORD,
            customName: 'alice-via-tor',
        }));
        console.log(`[s3] FINDING repro (anonymous mode): outcome=${firstAttempt.outcome} errorText="${firstAttempt.errorText ?? '(none)'}"`);
        await attach(testInfo, pageB, 's3-04-b-import-failed-while-unregistered');
        expect(firstAttempt.outcome).toBe('error');
        expect(firstAttempt.errorText ?? '').toContain('not found in database');
        expect(firstAttempt.errorText ?? '').toContain(peerIdB);

        // --- B registers (A, the exporter, still never does) to reach the
        // real investigation. Close the still-open (errored) import dialog
        // first — the footer's Register CTA sits behind it. ---
        await pageB.getByRole('button', { name: 'Close', exact: true }).first().click();
        await expect(pageB.getByRole('heading', { name: 'Add user from file' })).toBeHidden({ timeout: 10_000 });
        await timedStage('s3', 'b_registers_over_tor_to_work_around_finding', () => registerViaFooterCta(pageB, usernameB));
        await attach(testInfo, pageB, 's3-05-b-registered-over-tor');
        expect((await pageB.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(true);

        await openImportDialog(pageB);
        await stubOpenDialog(appB, exportedFilePath);
        await pageB.getByRole('button', { name: /Browse|Change File/ }).click();
        await expect(pageB.getByText(path.basename(exportedFilePath), { exact: true })).toBeVisible({ timeout: 10_000 });
        await pageB.getByPlaceholder('Enter profile password...').fill(EXPORT_PASSWORD);
        await pageB.getByPlaceholder('Leave empty to use name from file...').fill('alice-via-tor');
        await pageB.getByRole('button', { name: 'Import', exact: true }).click();
        await expect(pageB.getByText('Profile imported successfully!')).toBeVisible({ timeout: 20_000 });
        await attach(testInfo, pageB, 's3-06-b-imported-over-tor-after-registering');
        await pageB.getByRole('button', { name: 'Done', exact: true }).click();

        const bChats = await pageB.evaluate(async () => {
            const result = await window.kiyeovoAPI.getChats();
            return result.success ? result.chats : [];
        });
        const importedChat = (bChats as Array<Record<string, unknown>>).find((c) => c.other_peer_id === peerIdA);
        expect(importedChat?.trusted_out_of_band).toBe(true);

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
        await attach(testInfo, pageB, 's3-07-b-sent-first-message-over-tor');

        await timedStage('s3', 'contact_request_reaches_unregistered_a_over_tor', async () => {
            await expect(pageA.getByText(usernameB, { exact: true }).first()).toBeVisible({ timeout: 180_000 });
        });
        await attach(testInfo, pageA, 's3-08-a-request-visible-while-unregistered');

        const aLogsSoFar = peerA.logs.join('');
        const dialReachedA = /key_exchange_init|KEY-EXCHANGE\]\[INIT_STREAM\]/i.test(aLogsSoFar);
        console.log(`[s3] KEY INVESTIGATION confirmed: peer-ID-only dial via libp2p kad-dht peer routing reached A over Tor (no address at all was carried in the exported profile); log evidence present=${dialReachedA}`);
        expect((await pageA.evaluate(() => window.kiyeovoAPI.getUserState())).isRegistered).toBe(false);

        // --- FINDING #2 is mode-agnostic too (InvitationManager.tsx:24-27):
        // A, unregistered, cannot ACCEPT — register first, then accept. The
        // pending request's 5-min decision window comfortably outlasts a
        // Tor-DHT registration (~10-40s observed in tor-mode.spec.ts). ---
        await timedStage('s3', 'a_registers_over_tor_to_work_around_accept_gate', () => (
            registerViaFooterCta(pageA, `ti_tor_a_${runSuffix}`)
        ));
        // Retry-tolerant accept (see acceptContactRequestWithRetry's doc
        // comment) — doubly relevant over Tor, where onion rendezvous jitter
        // makes a finalization-timeout/re-surface cycle even more likely.
        await timedStage('s3', 'a_accepts_after_registering_over_tor', () => (
            acceptContactRequestWithRetry(pageA, usernameB, 180_000)
        ));
        await attach(testInfo, pageA, 's3-09-a-accepted-over-tor');

        await timedStage('s3', 'first_message_visible_on_a_over_tor', () => (
            expect(chatMessage(pageA, probeMessage)).toBeVisible({ timeout: 45_000 })
        ));
        await attach(testInfo, pageA, 's3-10-a-message-visible-over-tor');

        // --- A replies over Tor — the imported chat is fully live. ---
        const replyMessage = 'Confirmed — Alice, reached over Tor purely by peer ID.';
        await timedStage('s3', 'a_replies_over_tor', async () => {
            await sendChatMessage(pageA, replyMessage);
            await expect(chatMessage(pageB, replyMessage)).toBeVisible({ timeout: 45_000 });
        });
        await attach(testInfo, pageB, 's3-11-b-received-reply-over-tor');
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
