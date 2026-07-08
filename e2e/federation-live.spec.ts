import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { launchApp, type LaunchedApp } from './electron';
import {
    onboard,
    sendContactRequest,
    acceptContactRequest,
    sendChatMessage,
    timedStage,
} from './onboard';
import { BOOTSTRAP_MULTIADDR, BOOTSTRAP_MULTIADDR_B, RELAY_MULTIADDR, STUN_URL, uniqueRunSuffix } from './config';

// Live-fleet federation acceptance test — the deploy-verification gate for
// the BOOTSTRAP_PEERS change (commit 1396694, src/core/bootstrap.ts: each
// deployed fast bootstrap now dials the OTHER deployed fast bootstraps on
// startup, so their kad-dht routing tables merge into one keyspace).
//
// This is deliberately NOT a duplicate of federation.spec.ts. That file
// proves the federation CODE works by spinning up two THROWAWAY LOCAL
// bootstrap processes (one started with BOOTSTRAP_PEERS pointing at the
// other) and asserting a cross-segment username lookup succeeds — strong
// evidence the mechanism is correct, zero evidence it was actually deployed
// and wired up correctly on the real fleet. This file targets TWO REAL,
// ALREADY-RUNNING deployed bootstrap nodes (BOOTSTRAP_MULTIADDR "A" and the
// new BOOTSTRAP_MULTIADDR_B "B" — see e2e/config.ts) and proves the live
// fleet itself is one DHT, not just that the code that federates it is
// correct in principle.
//
// CRITICAL DESIGN: the ONLY variable that differs between peer A and peer B
// across both scenarios is the bootstrap they onboard against. Both peers
// use the SAME relay (RELAY_MULTIADDR) and the SAME STUN server (STUN_URL).
// This isolates cross-bootstrap DHT federation as the one thing under test —
// if relay or STUN also differed between the two peers, a failure could be a
// relay/ICE difference rather than a DHT federation gap, muddying the
// headline finding this file exists to produce.
//
// Required env (no safe default for "a second real deployed node" — see
// BOOTSTRAP_MULTIADDR_B's doc comment in e2e/config.ts): both tests
// test.skip() with a clear message when KIYEOVO_E2E_BOOTSTRAP_B is unset,
// rather than silently no-op or fall back to a local bootstrap.
//
//   F1 — cross-bootstrap discovery + messaging (the headline scenario): A
//        registers against bootstrap A, B registers against bootstrap B (a
//        DIFFERENT deployed node). B looks up A BY USERNAME through the real
//        "New Conversation" UI. That lookup can only ever succeed if node
//        A's DHT registration is actually findable via node B's routing
//        table — i.e. the two nodes' kad-dht keyspaces have genuinely
//        merged. Contact request -> accept -> one message each way, then a
//        code-level assertion (kiyeovoAPI.getChats(), same as
//        username-lookup.spec.ts) that B's resulting chat really points at
//        A's real peer ID.
//
//   F2 — cross-bootstrap OFFLINE delivery: A and B become contacts (fresh
//        setup, not reusing F1's peers — each test in this suite tears down
//        its own peers independently, matching every other spec file's
//        convention), B's app then closes for real (process exit, profile
//        kept — offline-delivery.spec.ts's pattern) while still configured
//        to dial ONLY bootstrap B, A sends a message to the now-offline B,
//        and B relaunches against the same persisted profile (still B-only).
//        The offline message can only be picked up if the durable
//        per-recipient DHT bucket A wrote (via node A) is fetchable via node
//        B — proving the offline-bucket path is federated too, not just
//        username lookups.
//
// A genuine F1 failure (A's registration NOT found via B) is the single most
// valuable possible finding here: federation.spec.ts already proves the
// federation mechanism is correct in the code, so a live F1 failure would
// point specifically at the DEPLOYMENT (e.g. BOOTSTRAP_PEERS not actually
// set / not taking effect / one node not actually dialing the other) rather
// than at the feature itself. Both tests classify failures explicitly in
// their catch/finally blocks and dump main-process logs on failure so that
// distinction (real federation gap vs. test bug vs. slow-real-DHT
// infra-transient) can be made from the artifacts alone.
test.setTimeout(6 * 60_000);

const PASSWORD = 'Correct-Horse-Battery-Staple9!';

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

/** Reads the resolved `other_peer_id` for a direct chat by its counterpart username (same IPC the chat UI loads from — see username-lookup.spec.ts's identical helper). */
async function chatPeerIdForUsername(page: Page, username: string): Promise<string | undefined> {
    return page.evaluate(async (name) => {
        const result = await window.kiyeovoAPI.getChats();
        if (!result.success) return undefined;
        const chat = (result.chats as Array<Record<string, unknown>>).find((c) => c.username === name);
        return chat ? (chat.other_peer_id as string | undefined) : undefined;
    }, username);
}

/** Locator for a chat's entry in the sidebar list (see offline-delivery.spec.ts's identical helper). */
function sidebarChatEntry(page: Page, name: string) {
    return page.locator('button').filter({ hasText: name });
}

/** Locator for the small per-message "offline" send-state label under a bubble (see offline-delivery.spec.ts's identical helper). */
function offlineSendLabel(page: Page, messageText: string) {
    return page
        .locator('div.animate-fade-in', { has: chatMessage(page, messageText) })
        .getByText('offline', { exact: true });
}

const SKIP_MESSAGE =
    'KIYEOVO_E2E_BOOTSTRAP_B is not set — this file needs TWO real, DIFFERENT deployed bootstrap ' +
    'addresses to prove the live fleet is federated (KIYEOVO_E2E_BOOTSTRAP for node A, ' +
    'KIYEOVO_E2E_BOOTSTRAP_B for a different node B). Skipping the live-fleet federation gate.';

// ---------------------------------------------------------------------------
// F1 — cross-bootstrap discovery + messaging (headline scenario).
// ---------------------------------------------------------------------------
test('F1: a username registered via deployed bootstrap A is discoverable and messageable via deployed bootstrap B @slow', async () => {
    test.skip(!BOOTSTRAP_MULTIADDR_B, SKIP_MESSAGE);

    const testInfo = test.info();
    const testStart = Date.now();
    let peerA: LaunchedApp | undefined;
    let peerB: LaunchedApp | undefined;
    let failed = false;

    const runSuffix = uniqueRunSuffix();
    const usernameA = `fedlive_a_${runSuffix}`;
    const usernameB = `fedlive_b_${runSuffix}`;

    console.log(`[federation-live][F1] bootstrap A=${BOOTSTRAP_MULTIADDR}`);
    console.log(`[federation-live][F1] bootstrap B=${BOOTSTRAP_MULTIADDR_B}`);

    try {
        [peerA, peerB] = await Promise.all([
            launchApp({ p2pPort: 9241 }),
            launchApp({ p2pPort: 9242 }),
        ]);
        const { page: pageA } = peerA;
        const { page: pageB } = peerB;

        // Only the bootstrap differs between A and B — same relay, same STUN
        // (see file-level "CRITICAL DESIGN" comment) — so any lookup failure
        // below can only be a DHT federation gap, not a relay/ICE mismatch.
        const [{ peerId: peerIdA }] = await timedStage('fedlive-f1', 'onboard_both_peers', () => Promise.all([
            onboard(pageA, {
                password: PASSWORD, username: usernameA,
                bootstrapMultiaddr: BOOTSTRAP_MULTIADDR, relayMultiaddr: RELAY_MULTIADDR, stunUrl: STUN_URL,
            }),
            onboard(pageB, {
                password: PASSWORD, username: usernameB,
                bootstrapMultiaddr: BOOTSTRAP_MULTIADDR_B!, relayMultiaddr: RELAY_MULTIADDR, stunUrl: STUN_URL,
            }),
        ]));
        await attach(testInfo, pageA, 'f1-a-registered-bootstrap-a');
        await attach(testInfo, pageB, 'f1-b-registered-bootstrap-b');

        // --- The core proof: B (dials ONLY bootstrap B) looks up A (registered
        // ONLY via bootstrap A) BY USERNAME. sendContactRequest() retries the
        // real "New Conversation" Send button for up to 100s total, absorbing
        // ordinary DHT propagation latency — but if the two nodes' keyspaces
        // never actually merged, this will exhaust its retries and throw,
        // failing the test. That failure IS the finding: see file-level
        // comment on why an F1 failure here is the most valuable possible
        // result of this whole suite. ---
        const firstMessage = 'Hi from bootstrap A — found you across the live fleet!';
        await timedStage('fedlive-f1', 'cross_bootstrap_username_lookup+accept', async () => {
            await sendContactRequest(pageB, usernameA, firstMessage);
            await expect(pageA.getByText(usernameB, { exact: true })).toBeVisible({ timeout: 20_000 });
            await acceptContactRequest(pageA, usernameB);
        });
        console.log('[federation-live][F1] cross-bootstrap username lookup succeeded — the live fleet is one DHT.');
        await attach(testInfo, pageB, 'f1-b-resolved-a-cross-bootstrap');
        await attach(testInfo, pageA, 'f1-a-accepted');

        await timedStage('fedlive-f1', 'first_message_visible', () => Promise.all([
            expect(chatMessage(pageA, firstMessage)).toBeVisible({ timeout: 30_000 }),
            expect(chatMessage(pageB, firstMessage)).toBeVisible({ timeout: 30_000 }),
        ]));

        // --- Code-level "resolved profile" evidence: B's chat row for
        // usernameA must carry A's REAL peer ID (same assertion shape as
        // username-lookup.spec.ts's scenario A). ---
        const resolvedPeerId = await chatPeerIdForUsername(pageB, usernameA);
        expect(resolvedPeerId).toBe(peerIdA);

        // --- One message each way. ---
        const reply = 'Confirmed — this really is A, reachable through B\'s bootstrap.';
        await timedStage('fedlive-f1', 'a_reply', async () => {
            await sendChatMessage(pageA, reply);
            await expect(chatMessage(pageB, reply)).toBeVisible({ timeout: 30_000 });
        });
        await attach(testInfo, pageB, 'f1-b-received-reply');
    } catch (error) {
        failed = true;
        console.log(
            '[federation-live][F1] FAILED — classify carefully: this could be (a) a real cross-bootstrap ' +
            'federation gap on the deployed fleet (BOOTSTRAP_PEERS not effective between these two nodes), ' +
            '(b) a test bug, or (c) infra-transient (real DHT propagation slower than the retry budget). ' +
            'federation.spec.ts passing separately (local, code-level federation) while THIS test fails ' +
            'points specifically at (a) — the deployment, not the mechanism. See attached main-process logs.',
        );
        throw error;
    } finally {
        console.log(`[timing][federation-live][F1] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) {
            await attachLogs(testInfo, peerA, 'f1-a-main-process-logs');
            await attachLogs(testInfo, peerB, 'f1-b-main-process-logs');
        }
        await peerA?.close().catch((error) => console.error('Failed to close peer A:', error));
        await peerB?.close().catch((error) => console.error('Failed to close peer B:', error));
    }
});

// ---------------------------------------------------------------------------
// F2 — cross-bootstrap OFFLINE delivery.
// ---------------------------------------------------------------------------
test('F2: a message sent while B is offline is delivered after B relaunches, still pointed only at deployed bootstrap B @slow', async () => {
    test.skip(!BOOTSTRAP_MULTIADDR_B, SKIP_MESSAGE);

    const testInfo = test.info();
    const testStart = Date.now();
    let peerA: LaunchedApp | undefined;
    let peerB: LaunchedApp | undefined;
    let failed = false;

    const runSuffix = uniqueRunSuffix();
    const usernameA = `fedlive_a_${runSuffix}`;
    const usernameB = `fedlive_b_${runSuffix}`;

    console.log(`[federation-live][F2] bootstrap A=${BOOTSTRAP_MULTIADDR}`);
    console.log(`[federation-live][F2] bootstrap B=${BOOTSTRAP_MULTIADDR_B}`);

    try {
        [peerA, peerB] = await Promise.all([
            launchApp({ p2pPort: 9243 }),
            launchApp({ p2pPort: 9244 }),
        ]);
        const { page: pageA } = peerA;
        let pageB = peerB.page;
        // Bob's (B's) profile dir + p2p port are reused verbatim on relaunch —
        // same "returning user, same identity" shape as offline-delivery.spec.ts
        // — and crucially his bootstrap config (bootstrap B only) is persisted
        // in his own profile, so the relaunch below never re-adds a bootstrap:
        // it dials ONLY node B again, exactly as before going offline.
        const bobProfileDir = peerB.profileDir;

        await timedStage('fedlive-f2', 'onboard_both_peers', () => Promise.all([
            onboard(pageA, {
                password: PASSWORD, username: usernameA,
                bootstrapMultiaddr: BOOTSTRAP_MULTIADDR, relayMultiaddr: RELAY_MULTIADDR, stunUrl: STUN_URL,
            }),
            onboard(pageB, {
                password: PASSWORD, username: usernameB,
                bootstrapMultiaddr: BOOTSTRAP_MULTIADDR_B!, relayMultiaddr: RELAY_MULTIADDR, stunUrl: STUN_URL,
            }),
        ]));
        await attach(testInfo, pageA, 'f2-a-registered-bootstrap-a');
        await attach(testInfo, pageB, 'f2-b-registered-bootstrap-b');

        // --- Step 1: become contacts (cross-bootstrap lookup again — F1 is
        // the dedicated headline test for this path, so failing fast here
        // instead of retrying forever just surfaces the same finding sooner)
        // and confirm a live message works before taking B offline. ---
        const firstMessage = 'Hello across the live fleet — first contact!';
        await timedStage('fedlive-f2', 'contact_request+accept', async () => {
            await sendContactRequest(pageA, usernameB, firstMessage);
            await expect(pageB.getByText(usernameA, { exact: true })).toBeVisible({ timeout: 20_000 });
            await acceptContactRequest(pageB, usernameA);
        });
        await timedStage('fedlive-f2', 'live_message_confirmed', () => Promise.all([
            expect(chatMessage(pageB, firstMessage)).toBeVisible({ timeout: 30_000 }),
            expect(chatMessage(pageA, firstMessage)).toBeVisible({ timeout: 30_000 }),
        ]));
        await attach(testInfo, pageA, 'f2-a-chat-active-live');
        await attach(testInfo, pageB, 'f2-b-chat-active-live');

        // --- Step 2: B's app closes for real (process exit), profile persists. ---
        await timedStage('fedlive-f2', 'b_closes_keeping_profile', async () => {
            await peerB!.close({ keepProfile: true });
        });
        console.log(`[timing][federation-live][F2] B's profileDir kept at ${bobProfileDir}`);

        // --- Step 3: while B is down, A sends a message. A only ever dials
        // bootstrap A, so the durable per-recipient DHT bucket write this
        // triggers (offline-send-queue.ts / offline-message-manager.ts) can
        // only land somewhere B's own node (dialing only bootstrap B) can
        // later fetch if the two nodes' DHTs are genuinely federated. ---
        const offlineMessage = 'B, this was sent to your DHT bucket via node A while you were offline.';
        await timedStage('fedlive-f2', 'a_sends_while_b_down', async () => {
            await sendChatMessage(pageA, offlineMessage);
            await expect(offlineSendLabel(pageA, offlineMessage)).toBeVisible({ timeout: 30_000 });
        });
        await attach(testInfo, pageA, 'f2-a-sent-while-b-offline');

        // --- Step 4: B relaunches against the SAME profile — still dialing
        // ONLY bootstrap B (no bootstrap re-added; see profileDir comment
        // above). Returning-user path: straight to the unlock prompt. ---
        let bobUnlockedAt = 0;
        await timedStage('fedlive-f2', 'b_relaunch_returning_user_unlock', async () => {
            peerB = await launchApp({ p2pPort: 9244, profileDir: bobProfileDir });
            pageB = peerB.page;
            await pageB.waitForLoadState('domcontentloaded');

            await expect(pageB.getByText('UNLOCK IDENTITY')).toBeVisible({ timeout: 30_000 });
            await expect(pageB.getByText('Choose Network Mode')).toHaveCount(0);
            await pageB.getByPlaceholder('Enter decryption key...').fill(PASSWORD);
            await pageB.getByRole('button', { name: 'Decrypt & Access' }).click();

            await expect(sidebarChatEntry(pageB, usernameA)).toBeVisible({ timeout: 60_000 });
            bobUnlockedAt = Date.now();
        });
        await attach(testInfo, pageB, 'f2-b-relaunched-unlocked');

        // --- Step 5: assert B receives the offline message — the proof that
        // the offline bucket A wrote (via node A) was fetched via node B. A
        // failure here (with F1 passing) would specifically implicate the
        // offline-bucket replication/federation path, not username lookup. ---
        await sidebarChatEntry(pageB, usernameA).click();
        await timedStage('fedlive-f2', 'b_receives_offline_message', async () => {
            await expect(chatMessage(pageB, offlineMessage)).toBeVisible({ timeout: 90_000 });
        });
        console.log(
            `[timing][federation-live][F2] cross-bootstrap offline-bucket pickup latency ` +
            `(relaunch-unlock -> message visible): ${((Date.now() - bobUnlockedAt) / 1000).toFixed(1)}s`,
        );
        await attach(testInfo, pageB, 'f2-b-received-offline-message');

        // --- Step 6: B replies, proving the reconnect is fully bidirectional. ---
        const replyMessage = 'B here — got it, sorry I was offline!';
        await timedStage('fedlive-f2', 'b_reply_after_reconnect', async () => {
            await sendChatMessage(pageB, replyMessage);
            await expect(chatMessage(pageA, replyMessage)).toBeVisible({ timeout: 30_000 });
        });
        await attach(testInfo, pageA, 'f2-a-received-b-reply-after-reconnect');
    } catch (error) {
        failed = true;
        console.log(
            '[federation-live][F2] FAILED — classify carefully: (a) a real cross-bootstrap offline-bucket ' +
            'federation gap (the record A wrote via node A never replicated/was never fetchable via node B), ' +
            '(b) a test bug, or (c) infra-transient (slow real DHT / replication lag beyond the wait window). ' +
            'If F1 in this same file passed, that isolates the gap to the offline-bucket path specifically ' +
            'rather than DHT federation in general. See attached main-process logs.',
        );
        throw error;
    } finally {
        console.log(`[timing][federation-live][F2] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) {
            await attachLogs(testInfo, peerA, 'f2-a-main-process-logs');
            await attachLogs(testInfo, peerB, 'f2-b-main-process-logs');
        }
        await peerA?.close().catch((error) => console.error('Failed to close peer A:', error));
        // Final teardown deletes B's profile too (default close() behavior).
        await peerB?.close().catch((error) => console.error('Failed to close peer B:', error));
    }
});
