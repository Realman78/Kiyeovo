import { test, expect, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './electron';
import { onboard } from './onboard';
import { RELAY_MULTIADDR, STUN_URL, uniqueRunSuffix } from './config';

// Reproduces the field report: two peers on DIFFERENT deployed bootstraps that
// are federated (BOOTSTRAP_PEERS mesh). A registers on SFO; B looks A up on
// Nuremberg. Same relay/STUN so the ONLY variable is which bootstrap each peer
// dials. Both peers run on this one box (same network), so this isolates
// cross-bootstrap DISCOVERY from any NAT/relay-delivery concern.
//
// Retries the lookup for a while to tell "never findable" (federation broken)
// apart from "eventually findable" (propagation delay).

const SFO_BOOTSTRAP = '/ip4/167.172.115.233/tcp/9000/p2p/12D3KooWKDrpSzWYyCaJ4gfNGY5XUjUYN9tVZe8t9biMMY9HxU8K';
const NBG_BOOTSTRAP = '/ip4/178.104.248.235/tcp/9000/p2p/12D3KooWM2gccLekXRBhtQFCLYQH3ceTDpDcxBp5uNPwMScETr74';
const SFO_RELAY = '/ip4/167.172.115.233/tcp/4002/p2p/12D3KooWDfn9gv6mQsb8CBCmXRPLbBzDaZrcZD8HiQ4a3rgNp4MM';
const NBG_RELAY = '/ip4/178.104.248.235/tcp/4002/p2p/12D3KooWEKo9h8Rux6gRwoi9t7m1n2RnfoSAHGa2WZYw4LrTXSwH';

const PASSWORD = 'Correct-Horse-Battery-Staple9!';
test.setTimeout(6 * 60_000);

async function openNewConversationDialog(page: Page): Promise<void> {
  const emptyStateButton = page.getByRole('button', { name: 'Start a conversation' }).first();
  if (await emptyStateButton.isVisible().catch(() => false)) {
    await emptyStateButton.click();
    return;
  }
  await page.locator('button:has(svg.lucide-plus)').first().click();
  await page.getByRole('button', { name: 'New Conversation', exact: true }).click();
}

/** Re-clicks Send until the dialog closes (found) or the window elapses. Logs each miss with elapsed time. */
async function lookupUntilFound(page: Page, identifier: string, timeoutMs: number): Promise<boolean> {
  await openNewConversationDialog(page);
  await expect(page.getByRole('heading', { name: 'New Conversation' })).toBeVisible({ timeout: 10_000 });
  await page.getByPlaceholder('Enter peer ID or username...').fill(identifier);
  await page.getByPlaceholder('Compose an inital greeting...').fill('federation cross-bootstrap probe');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page.getByRole('button', { name: 'Send' }).click();
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(5_000);
    // eslint-disable-next-line no-await-in-loop
    const stillOpen = await page.getByRole('heading', { name: 'New Conversation' }).isVisible().catch(() => true);
    if (!stillOpen) { console.log(`[fedlive] FOUND after ${Math.round((Date.now() - start) / 1000)}s`); return true; }
    console.log(`[fedlive] still not found at ${Math.round((Date.now() - start) / 1000)}s`);
  }
  return false;
}

test('cross-bootstrap: A registered on SFO is discoverable from B on Nuremberg @slow', async () => {
  let peerA: LaunchedApp | undefined;
  let peerB: LaunchedApp | undefined;
  const suffix = uniqueRunSuffix();
  const usernameA = `fedlive_a_${suffix}`;
  const usernameB = `fedlive_b_${suffix}`;
  try {
    [peerA, peerB] = await Promise.all([launchApp({ p2pPort: 9201 }), launchApp({ p2pPort: 9202 })]);

    await Promise.all([
      onboard(peerA.page, { password: PASSWORD, username: usernameA, bootstrapMultiaddr: SFO_BOOTSTRAP, relayMultiaddr: RELAY_MULTIADDR, stunUrl: STUN_URL }),
      onboard(peerB.page, { password: PASSWORD, username: usernameB, bootstrapMultiaddr: NBG_BOOTSTRAP, relayMultiaddr: RELAY_MULTIADDR, stunUrl: STUN_URL }),
    ]);
    console.log(`[fedlive] A=${usernameA} on SFO, B=${usernameB} on Nuremberg — both onboarded`);

    // Give the registration a moment to settle, then look A up from B (different bootstrap).
    const found = await lookupUntilFound(peerB.page, usernameA, 120_000);
    console.log(`[fedlive] cross-bootstrap discovery (B@NBG -> A@SFO): ${found ? 'SUCCESS' : 'FAILED'}`);
    expect(found).toBe(true);
  } finally {
    await peerA?.close().catch(() => {});
    await peerB?.close().catch(() => {});
  }
});

// The record-address fix: A and B are on DIFFERENT relays. B can only reach A if
// it learns A's relay from A's published record and dials A via it (without the
// fix this is the NO_RESERVATION cross-relay failure the field report hit).
test('cross-relay: B on Nuremberg-relay reaches A on SFO-relay via A\'s record address @slow', async () => {
  let peerA: LaunchedApp | undefined;
  let peerB: LaunchedApp | undefined;
  const suffix = uniqueRunSuffix();
  const usernameA = `xrelay_a_${suffix}`;
  const usernameB = `xrelay_b_${suffix}`;
  try {
    [peerA, peerB] = await Promise.all([launchApp({ p2pPort: 9203 }), launchApp({ p2pPort: 9204 })]);

    await Promise.all([
      onboard(peerA.page, { password: PASSWORD, username: usernameA, bootstrapMultiaddr: SFO_BOOTSTRAP, relayMultiaddr: SFO_RELAY, stunUrl: STUN_URL }),
      onboard(peerB.page, { password: PASSWORD, username: usernameB, bootstrapMultiaddr: NBG_BOOTSTRAP, relayMultiaddr: NBG_RELAY, stunUrl: STUN_URL }),
    ]);
    console.log(`[xrelay] A=${usernameA} on SFO-relay, B=${usernameB} on Nuremberg-relay — both onboarded`);

    const reached = await lookupUntilFound(peerB.page, usernameA, 120_000);
    console.log(`[xrelay] cross-relay reach (B@NBG-relay -> A@SFO-relay): ${reached ? 'SUCCESS' : 'FAILED'}`);
    expect(reached).toBe(true);
  } finally {
    await peerA?.close().catch(() => {});
    await peerB?.close().catch(() => {});
  }
});
