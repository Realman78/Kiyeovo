import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { launchApp, type LaunchedApp } from './electron';
import { startBootstrapNode, type BootstrapNode } from './bootstrap-node';
import { onboard, sendContactRequest, acceptContactRequest, sendChatMessage, timedStage } from './onboard';
import { BOOTSTRAP_MULTIADDR, RELAY_MULTIADDR, STUN_URL, USE_LOCAL_BOOTSTRAP, uniqueRunSuffix } from './config';

// Offline-delivery + reconnect flow (round 1 of e2e/test-roadmap.md): Alice and
// Bob onboard and become contacts, Bob's app then CLOSES (real process exit,
// not just navigating away) while keeping his on-disk profile, Alice sends him
// messages while he's down, and Bob relaunches against the SAME persisted
// profile — the *returning-user* unlock path (password prompt only, no
// network-mode/setup wizard — see Login.tsx/PasswordPrompt.tsx and
// src/electron/main.ts's detectRequiresNetworkModeSelection(), which reads a
// persisted "onboarded" flag from chat.db and is what actually skips the
// wizard for a relaunch against the same HOME/profile dir).
//
// Per docs (Kiyeovo_desktop_technical_documentation.md §5.3 "Offline
// fallback") and src/core/direct/offline-send-queue.ts +
// offline-message-manager.ts: a not-connected direct send returns immediately
// (optimistic row) and falls back to a durable per-recipient DHT bucket queue
// in the background; the row settles to a distinct `offline` send state
// (rendered as a small "offline" label under the bubble — see
// MessageRow.tsx:566-577) rather than "delivered". Pickup on the recipient
// side does not require any manual action: src/ui/pages/Main.tsx's
// syncRecentOfflineMessages effect fires as soon as the renderer sees DHT
// connectivity return (`canFetchOffline`), independently calling
// checkOfflineMessages() for the top direct chats — this is a genuine
// core-code-confirmed mechanism, not just an inferred behavior from the docs.
// The docs' "on-connect refetch nudge" (direct DIRECT_OFFLINE_REFETCH, 500ms
// delay) is Alice-side acceleration on top of that when she detects Bob
// reconnecting; the 5-minute OFFLINE_MESSAGE_CHECK_INTERVAL is the periodic
// fallback if both of those miss.
//
// Group-offline extension: deliberately NOT covered here (see the
// test-roadmap.md judgement call) — a third onboarded peer plus a real group
// create/activate round trip was observed today at ~17s/~44s on top of what's
// already a 3-stage direct scenario, which risks blowing the 6-minute cap on
// a slow-DHT day. Direct-offline is the core deliverable; group-offline is
// left as a follow-up (either its own spec or an addition to
// group-chat.spec.ts).
test.setTimeout(6 * 60_000);

const PASSWORD = 'Correct-Horse-Battery-Staple9!';

test('direct messages sent while a peer is offline are delivered after they relaunch with the same profile @slow', async () => {
    const testInfo = test.info();
    const testStart = Date.now();
    let bootstrap: BootstrapNode | undefined;
    let peerA: LaunchedApp | undefined;
    let peerB: LaunchedApp | undefined;
    let failed = false;

    const runSuffix = uniqueRunSuffix();
    const usernameA = `alice_${runSuffix}`;
    const usernameB = `bob_${runSuffix}`;

    try {
        // Port 19503 (not the bare default 19501, which two-peer.spec.ts
        // owns) — see e2e/config.ts's "PORT RANGES" table.
        const bootstrapMultiaddr = USE_LOCAL_BOOTSTRAP
            ? (bootstrap = await startBootstrapNode(19503)).multiaddr
            : BOOTSTRAP_MULTIADDR;

        [peerA, peerB] = await Promise.all([
            launchApp({ p2pPort: 9111 }),
            launchApp({ p2pPort: 9112 }),
        ]);
        const { page: pageA } = peerA;
        let pageB = peerB.page;
        // Bob's profile dir + p2p port are reused verbatim on relaunch — the
        // profile IS his identity/database, so this is what makes it "the same
        // returning user" rather than a fresh onboarding.
        const bobProfileDir = peerB.profileDir;

        const onboardOptions = {
            password: PASSWORD,
            bootstrapMultiaddr,
            relayMultiaddr: RELAY_MULTIADDR,
            stunUrl: STUN_URL,
        };
        const [{ peerId: peerIdA }, { peerId: peerIdB }] = await timedStage('offline', 'onboard_both_peers', () => Promise.all([
            onboard(pageA, { ...onboardOptions, username: usernameA }),
            onboard(pageB, { ...onboardOptions, username: usernameB }),
        ]));
        expect(peerIdA).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20,}$/);
        expect(peerIdB).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20,}$/);
        expect(peerIdA).not.toBe(peerIdB);

        await attach(testInfo, pageA, 'a-onboarded');
        await attach(testInfo, pageB, 'b-onboarded');

        // --- Step 1: become contacts and confirm a live (online) message works ---
        const firstMessage = 'Hello from Alice — first contact!';
        await timedStage('offline', 'contact_request+accept', async () => {
            await sendContactRequest(pageA, peerIdB, firstMessage);
            await expect(pageB.getByText(usernameA, { exact: true })).toBeVisible({ timeout: 20_000 });
            await acceptContactRequest(pageB, usernameA);
        });
        await timedStage('offline', 'live_message_confirmed', () => Promise.all([
            expect(chatMessage(pageB, firstMessage)).toBeVisible({ timeout: 30_000 }),
            expect(chatMessage(pageA, firstMessage)).toBeVisible({ timeout: 30_000 }),
        ]));
        await attach(testInfo, pageA, 'a-chat-active-live');
        await attach(testInfo, pageB, 'b-chat-active-live');

        // --- Step 2: Bob's app closes (real process exit), profile persists ---
        await timedStage('offline', 'bob_closes_keeping_profile', async () => {
            await peerB!.close({ keepProfile: true });
        });
        console.log(`[timing][offline] Bob's profileDir kept at ${bobProfileDir}`);

        // --- Step 3: while Bob is down, Alice sends direct messages ---
        const offlineMessage1 = 'Bob, are you there? (sent while you were offline #1)';
        const offlineMessage2 = 'Second one, in case you missed the first (#2)';
        await timedStage('offline', 'alice_sends_while_bob_down', async () => {
            await sendChatMessage(pageA, offlineMessage1);
            // The send is non-blocking (optimistic 'sending' row) and settles in
            // the background to a distinct 'offline' state once the durable
            // per-recipient DHT bucket write completes (see file-level comment) —
            // this is the "sane state" the docs promise for a not-connected
            // recipient, as opposed to 'delivered' or an error.
            await expect(offlineSendLabel(pageA, offlineMessage1)).toBeVisible({ timeout: 30_000 });
            await sendChatMessage(pageA, offlineMessage2);
            await expect(offlineSendLabel(pageA, offlineMessage2)).toBeVisible({ timeout: 30_000 });
        });
        await attach(testInfo, pageA, 'a-sent-while-bob-offline');

        // --- Step 4: Bob relaunches against the SAME profile (returning user) ---
        let bobUnlockedAt = 0;
        await timedStage('offline', 'bob_relaunch_returning_user_unlock', async () => {
            peerB = await launchApp({ p2pPort: 9112, profileDir: bobProfileDir });
            pageB = peerB.page;
            await pageB.waitForLoadState('domcontentloaded');

            // Returning-user path: no "Choose Network Mode" screen (the mode is
            // already persisted — detectRequiresNetworkModeSelection() reads
            // NETWORK_MODE_ONBOARDED_SETTING_KEY from chat.db and is false), and
            // no "NEW IDENTITY"/recovery-phrase wizard — straight to the unlock
            // password prompt (Login.tsx -> PasswordPrompt.tsx, isNewPassword
            // false since a password already exists on this profile).
            await expect(pageB.getByText('UNLOCK IDENTITY')).toBeVisible({ timeout: 30_000 });
            await expect(pageB.getByText('Choose Network Mode')).toHaveCount(0);
            await pageB.getByPlaceholder('Enter decryption key...').fill(PASSWORD);
            await pageB.getByRole('button', { name: 'Decrypt & Access' }).click();

            // Lands back in the main chat UI with Alice's contact/chat already
            // present (persisted locally in chat.db) — no re-onboarding, no
            // re-adding the contact.
            await expect(sidebarChatEntry(pageB, usernameA)).toBeVisible({ timeout: 60_000 });
            bobUnlockedAt = Date.now();
        });
        await attach(testInfo, pageB, 'b-relaunched-unlocked');

        // --- Step 5: assert Bob receives the messages sent while he was down ---
        // Opens the chat (also triggers MessagesContainer's own
        // checkOfflineMessagesForChat on mount, on top of Main.tsx's automatic
        // syncRecentOfflineMessages effect that already fired as soon as
        // canFetchOffline flipped true after reconnecting to the DHT).
        await sidebarChatEntry(pageB, usernameA).click();
        await timedStage('offline', 'bob_receives_offline_messages', async () => {
            await Promise.all([
                expect(chatMessage(pageB, offlineMessage1)).toBeVisible({ timeout: 90_000 }),
                expect(chatMessage(pageB, offlineMessage2)).toBeVisible({ timeout: 90_000 }),
            ]);
        });
        console.log(
            `[timing][offline] offline-bucket pickup latency (relaunch-unlock -> both messages visible): ` +
            `${((Date.now() - bobUnlockedAt) / 1000).toFixed(1)}s`,
        );
        await attach(testInfo, pageB, 'b-received-offline-messages');

        // --- Step 6: Bob replies, proving the reconnect is fully bidirectional ---
        const replyMessage = 'Bob here — got both, sorry I was offline!';
        await timedStage('offline', 'bob_reply_after_reconnect', async () => {
            await sendChatMessage(pageB, replyMessage);
            await expect(chatMessage(pageA, replyMessage)).toBeVisible({ timeout: 30_000 });
        });
        await attach(testInfo, pageA, 'a-received-bob-reply-after-reconnect');
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][offline] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) {
            await attachLogs(testInfo, peerA, 'a-main-process-logs');
            await attachLogs(testInfo, peerB, 'b-main-process-logs');
        }
        await peerA?.close().catch((error) => console.error('Failed to close peer A:', error));
        // Final teardown deletes Bob's profile too (default close() behavior) —
        // nothing left keeping it around once the test is done.
        await peerB?.close().catch((error) => console.error('Failed to close peer B:', error));
        await bootstrap?.stop().catch((error) => console.error('Failed to stop bootstrap node:', error));
    }
});

/**
 * Locator for a message *bubble* in the currently open chat — see
 * two-peer.spec.ts for why this must be scoped to [data-message-bubble]
 * rather than a plain getByText (the sidebar chat-list preview renders the
 * same truncated text in a plain <p>).
 */
function chatMessage(page: Page, text: string) {
    return page.locator('[data-message-bubble]').getByText(text);
}

/**
 * Locator for the small per-message send-state label MessageRow.tsx renders
 * under a bubble once a background offline send settles
 * (`message.messageSentStatus === 'offline'` -> literal text "offline", see
 * MessageRow.tsx:566-577). Scoped to the row that also contains the given
 * message's own bubble text, so it can't accidentally match a stray "offline"
 * elsewhere in the chat.
 */
function offlineSendLabel(page: Page, messageText: string) {
    // `animate-fade-in` (alongside `flex flex-col`) is MessageRow.tsx's outer
    // per-message row wrapper class (a sibling list, never nested inside
    // itself), so this scopes to the one row containing this message's own
    // bubble rather than any ancestor container.
    return page
        .locator('div.animate-fade-in', { has: chatMessage(page, messageText) })
        .getByText('offline', { exact: true });
}

/** Locator for a chat's entry in the sidebar list (see group-chat.spec.ts). */
function sidebarChatEntry(page: Page, name: string) {
    return page.locator('button').filter({ hasText: name });
}

async function attach(testInfo: TestInfo, page: Page, name: string) {
    const screenshotPath = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' });
}

/** Dumps a peer's captured main-process stdout/stderr as a test attachment (debugging aid on failure). */
async function attachLogs(testInfo: TestInfo, peer: LaunchedApp | undefined, name: string) {
    if (!peer) return;
    await testInfo.attach(name, { body: peer.logs.join(''), contentType: 'text/plain' });
}
