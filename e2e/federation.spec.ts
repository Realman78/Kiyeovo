import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { launchApp, type LaunchedApp } from './electron';
import { startBootstrapNode, type BootstrapNode } from './bootstrap-node';
import { onboard } from './onboard';
import { RELAY_MULTIADDR, STUN_URL, uniqueRunSuffix } from './config';

// Bootstrap federation acceptance test (BOOTSTRAP_PEERS in src/core/bootstrap.ts).
//
// This is the mirror image of username-lookup.spec.ts scenario E: that test
// stands up TWO independent, never-federated local bootstrap segments and
// asserts a username registered against segment 1 is NOT findable from segment
// 2 (disjoint DHTs by construction). This test stands up two segments that ARE
// federated — segment 2's bootstrap is started with BOOTSTRAP_PEERS pointing at
// segment 1's bootstrap, so on startup it dials segment 1 and their kad-dht
// routing tables merge into one keyspace — and asserts the opposite: a username
// registered via one bootstrap IS findable via the other.
//
// Acceptance semantics: before the BOOTSTRAP_PEERS change, bootstrap.ts ignored
// the env (it only listened, never dialed peers), so the two segments stayed
// islands and this cross-segment lookup would fail exactly like scenario E's.
// After the change it passes. So this doubles as the pass/fail gate for
// federating the deployed fleet.
//
// Local bootstraps only (spawns the real src/core/bootstrap.ts, so it exercises
// the actual code change — no image/deploy needed). Relay + ICE steps use the
// shared config infra like every other fast-mode spec; only the DHT layer is
// local, which is all federation touches.
test.setTimeout(6 * 60_000);

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

/** Opens "New Conversation" — own copy per the convention username-lookup.spec.ts / blocking.spec.ts establish (onboard.ts's equivalent is module-private). */
async function openNewConversationDialog(page: Page): Promise<void> {
    const emptyStateButton = page.getByRole('button', { name: 'Start a conversation' }).first();
    if (await emptyStateButton.isVisible().catch(() => false)) {
        await emptyStateButton.click();
        return;
    }
    await page.locator('button:has(svg.lucide-plus)').first().click();
    await page.getByRole('button', { name: 'New Conversation', exact: true }).click();
}

/**
 * Opens "New Conversation", fills a username lookup once, then re-clicks Send
 * until the dialog closes (success) or the window elapses (returns false).
 * Re-clicking (rather than a single attempt) absorbs DHT convergence after the
 * two bootstraps federate — the same "keep retrying the same open dialog"
 * shape as username-lookup.spec.ts's retryLookupUntilSuccess. A miss leaves the
 * dialog open with fields intact, so the next click just retries the lookup.
 */
async function lookupUsernameUntilSuccess(
    page: Page,
    identifier: string,
    message: string,
    timeoutMs: number,
): Promise<boolean> {
    await openNewConversationDialog(page);
    await expect(page.getByRole('heading', { name: 'New Conversation' })).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder('Enter peer ID or username...').fill(identifier);
    await page.getByPlaceholder('Compose an inital greeting...').fill(message);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await page.getByRole('button', { name: 'Send' }).click();
        // eslint-disable-next-line no-await-in-loop
        await page.waitForTimeout(4_000);
        // eslint-disable-next-line no-await-in-loop
        const dialogVisible = await page.getByRole('heading', { name: 'New Conversation' }).isVisible().catch(() => false);
        if (!dialogVisible) return true;
    }
    return false;
}

test('a username registered via one federated bootstrap is discoverable via a different one @slow', async () => {
    const testInfo = test.info();
    const testStart = Date.now();
    let bootstrap1: BootstrapNode | undefined;
    let bootstrap2: BootstrapNode | undefined;
    let peerA: LaunchedApp | undefined;
    let peerC: LaunchedApp | undefined;
    let failed = false;
    const runSuffix = uniqueRunSuffix();
    const usernameA = `fed_a_${runSuffix}`;
    const usernameC = `fed_c_${runSuffix}`;

    try {
        // Segment 1 first, so its full multiaddr (incl. /p2p/<id>) is known.
        bootstrap1 = await startBootstrapNode(20414);
        // Segment 2 federates with segment 1: on startup it dials bootstrap1 via
        // BOOTSTRAP_PEERS, so the two kad-dht routing tables merge. This is the
        // realistic "a new node joins the existing network" shape, and it's the
        // exact env the kiyeovo-infra CLI writes for the deployed fleet.
        bootstrap2 = await startBootstrapNode({
            port: 20415,
            env: { BOOTSTRAP_PEERS: bootstrap1.multiaddr },
        });

        [peerA, peerC] = await Promise.all([
            launchApp({ p2pPort: 9190 }),
            launchApp({ p2pPort: 9191 }),
        ]);

        // A onboards + registers against bootstrap1; C against bootstrap2. Each
        // client only ever dials its own bootstrap — the only path from C's
        // lookup to A's record is the federation link between the bootstraps.
        await Promise.all([
            onboard(peerA.page, {
                password: PASSWORD, username: usernameA,
                bootstrapMultiaddr: bootstrap1.multiaddr, relayMultiaddr: RELAY_MULTIADDR, stunUrl: STUN_URL,
            }),
            onboard(peerC.page, {
                password: PASSWORD, username: usernameC,
                bootstrapMultiaddr: bootstrap2.multiaddr, relayMultiaddr: RELAY_MULTIADDR, stunUrl: STUN_URL,
            }),
        ]);
        await attach(testInfo, peerA.page, 'fed-a-registered-segment1');
        await attach(testInfo, peerC.page, 'fed-c-registered-segment2');

        // The assertion: C (on bootstrap2) resolves A's username (registered via
        // bootstrap1). Only possible if the two DHTs merged — i.e. federation
        // works. Throws (fails the test) if the lookup never succeeds, which is
        // exactly the pre-change island behavior (BOOTSTRAP_PEERS ignored) this
        // test guards against.
        const resolved = await lookupUsernameUntilSuccess(peerC.page, usernameA, 'found you across the mesh', 90_000);
        console.log(`[federation] cross-bootstrap lookup (C->A) succeeded=${resolved}`);
        await attach(testInfo, peerC.page, 'fed-c-resolved-a-cross-bootstrap');
        expect(resolved).toBe(true);
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][federation] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) {
            await attachLogs(testInfo, peerA, 'a-main-process-logs');
            await attachLogs(testInfo, peerC, 'c-main-process-logs');
        }
        await peerA?.close().catch((error) => console.error('Failed to close peer A:', error));
        await peerC?.close().catch((error) => console.error('Failed to close peer C:', error));
        await bootstrap1?.stop().catch((error) => console.error('Failed to stop bootstrap segment 1:', error));
        await bootstrap2?.stop().catch((error) => console.error('Failed to stop bootstrap segment 2:', error));
    }
});
