import { test, expect } from '@playwright/test';
import { launchApp, type LaunchedApp } from './electron';
import { startBootstrapNode, type BootstrapNode } from './bootstrap-node';
import { onboard, sendContactRequest, acceptContactRequest, sendChatMessage, timedStage } from './onboard';
import { BOOTSTRAP_MULTIADDR, RELAY_MULTIADDR, STUN_URL, USE_LOCAL_BOOTSTRAP, uniqueRunSuffix } from './config';

// Real two-peer p2p flow: both instances create a fresh identity, go through
// the full guided setup wizard against real deployed infra (bootstrap, relay,
// STUN — see e2e/config.ts), register usernames (required on both sides — see
// onboard.ts), exchange a contact request/acceptance, then send a message
// each way. This exercises the app's actual libp2p DHT + direct-TCP path, not
// mocks, so it needs generous timeouts for DHT propagation and identity setup
// — the public infra is noticeably slower than the old throwaway local node.
test.setTimeout(6 * 60_000);

const PASSWORD = 'Correct-Horse-Battery-Staple9!';

test('two peers create identities, connect, and exchange messages both ways', async () => {
    const testInfo = test.info();
    const testStart = Date.now();
    let bootstrap: BootstrapNode | undefined;
    let peerA: LaunchedApp | undefined;
    let peerB: LaunchedApp | undefined;
    let failed = false;

    // Usernames register on the real, persistent public DHT by default (see
    // e2e/config.ts) — a fixed per-testId name would collide with a previous
    // run's registration, so mint a fresh random suffix every run.
    const runSuffix = uniqueRunSuffix();
    const usernameA = `alice_${runSuffix}`;
    const usernameB = `bob_${runSuffix}`;

    try {
        // KIYEOVO_E2E_LOCAL_BOOTSTRAP=1 restores the old throwaway-local-node
        // path; otherwise dial the real bootstrap infra directly.
        const bootstrapMultiaddr = USE_LOCAL_BOOTSTRAP
            ? (bootstrap = await startBootstrapNode()).multiaddr
            : BOOTSTRAP_MULTIADDR;

        // Distinct libp2p listen ports so both instances can be live at once
        // (avoiding 9001, the app's hardcoded default, in case a dev instance
        // happens to be running on this host).
        [peerA, peerB] = await Promise.all([
            launchApp({ p2pPort: 9101 }),
            launchApp({ p2pPort: 9102 }),
        ]);
        const { page: pageA } = peerA;
        const { page: pageB } = peerB;

        const onboardOptions = {
            password: PASSWORD,
            bootstrapMultiaddr,
            relayMultiaddr: RELAY_MULTIADDR,
            stunUrl: STUN_URL,
        };
        const [{ peerId: peerIdA }, { peerId: peerIdB }] = await timedStage('exchange', 'onboard_both_peers', () => Promise.all([
            onboard(pageA, { ...onboardOptions, username: usernameA }),
            onboard(pageB, { ...onboardOptions, username: usernameB }),
        ]));
        expect(peerIdA).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20,}$/);
        expect(peerIdB).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20,}$/);
        expect(peerIdA).not.toBe(peerIdB);

        await attach(testInfo, pageA, 'a-onboarded');
        await attach(testInfo, pageB, 'b-onboarded');

        // --- A sends a contact request (first message) to B, by Peer ID; B accepts ---
        const firstMessage = 'Hello from Alice — first contact!';
        // Honest single-attempt path: one contact request, one accept. The key-exchange
        // follow-up timeout that used to drop the accept side's pending request has been
        // fixed (src/core/direct/key-exchange.ts — the confirm no longer waits behind a DHT
        // lookup, and the finalization read is sized to a real round-trip), so no
        // resend-retry workaround is needed here.
        await timedStage('exchange', 'contact_request+accept', async () => {
            await sendContactRequest(pageA, peerIdB, firstMessage);
            await expect(pageB.getByText(usernameA, { exact: true })).toBeVisible({ timeout: 20_000 });
            await acceptContactRequest(pageB, usernameA);
        });
        await attach(testInfo, pageA, 'a-sent-contact-request');
        await attach(testInfo, pageB, 'b-sees-contact-attempt');

        // Chat becomes active on both sides once the key exchange completes.
        // Scoped to [data-message-bubble] (MessageRow.tsx): the sidebar chat-list
        // preview (ChatPreview.tsx) renders the same truncated text in a plain
        // <p>, so an unscoped getByText() matches both and trips strict mode.
        await timedStage('exchange', 'first_message_visible', () => Promise.all([
            expect(chatMessage(pageB, firstMessage)).toBeVisible({ timeout: 30_000 }),
            expect(chatMessage(pageA, firstMessage)).toBeVisible({ timeout: 30_000 }),
        ]));
        await attach(testInfo, pageA, 'a-chat-active');
        await attach(testInfo, pageB, 'b-chat-active');

        // --- B replies ---
        const replyMessage = 'Hey Alice, Bob here — got your message!';
        await timedStage('exchange', 'b_reply', async () => {
            await sendChatMessage(pageB, replyMessage);
            await expect(chatMessage(pageA, replyMessage)).toBeVisible({ timeout: 30_000 });
        });
        await attach(testInfo, pageA, 'a-received-reply');

        // --- A replies back, just to nail down both directions ---
        const secondMessage = 'Great to hear from you — loud and clear.';
        await timedStage('exchange', 'a_reply', async () => {
            await sendChatMessage(pageA, secondMessage);
            await expect(chatMessage(pageB, secondMessage)).toBeVisible({ timeout: 30_000 });
        });
        await attach(testInfo, pageB, 'b-received-second-message');
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][exchange] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        // testInfo.status isn't populated yet inside the test body itself (only
        // once the runner finishes the test), so a local flag is what actually
        // detects failure here for attaching debug logs.
        if (failed) {
            await attachLogs(testInfo, peerA, 'a-main-process-logs');
            await attachLogs(testInfo, peerB, 'b-main-process-logs');
        }
        await peerA?.close().catch((error) => console.error('Failed to close peer A:', error));
        await peerB?.close().catch((error) => console.error('Failed to close peer B:', error));
        await bootstrap?.stop().catch((error) => console.error('Failed to stop bootstrap node:', error));
    }
});

/**
 * Locator for a message *bubble* in the currently open chat, disambiguated
 * from the sidebar chat-list's truncated last-message preview (which renders
 * the same text and would otherwise trip Playwright's strict-mode duplicate
 * check). MessageRow.tsx marks each bubble with a bare `data-message-bubble`
 * attribute; ChatPreview.tsx's sidebar snippet never carries it.
 */
function chatMessage(page: import('@playwright/test').Page, text: string) {
    return page.locator('[data-message-bubble]').getByText(text);
}

async function attach(testInfo: import('@playwright/test').TestInfo, page: import('@playwright/test').Page, name: string) {
    const screenshotPath = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' });
}

/** Dumps a peer's captured main-process stdout/stderr as a test attachment (debugging aid on failure). */
async function attachLogs(testInfo: import('@playwright/test').TestInfo, peer: LaunchedApp | undefined, name: string) {
    if (!peer) return;
    await testInfo.attach(name, { body: peer.logs.join(''), contentType: 'text/plain' });
}
