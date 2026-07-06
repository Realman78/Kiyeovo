import { expect, type Page, type TestInfo } from '@playwright/test';
import { launchApp, type LaunchedApp } from './electron';
import { startBootstrapNode, type BootstrapNode } from './bootstrap-node';
import { onboard, sendContactRequest, acceptContactRequest, timedStage } from './onboard';
import { BOOTSTRAP_MULTIADDR, RELAY_MULTIADDR, STUN_URL, USE_LOCAL_BOOTSTRAP, uniqueRunSuffix } from './config';

// Reusable "populated world" fixture (round 2 of e2e/test-roadmap.md): three
// real onboarded peers — Alice, Bob, Charlie — with Alice<->Bob and
// Alice<->Charlie established as direct contacts (Bob and Charlie deliberately
// never become contacts of each other — see group-chat.spec.ts's file-level
// comment for why) plus one group containing all three, driven all the way to
// 'active' on every side. This is the exact setup group-chat.spec.ts performs
// standalone; it's extracted here so file-transfer.spec.ts (and future rounds
// — blocking/removal, calls) can start from a realistic populated world
// instead of a bare pair, which is what makes wrong-chat routing and
// cross-chat contamination assertable.
//
// group-chat.spec.ts itself is deliberately left as its own standalone,
// already-passing implementation rather than refactored to call this
// function — duplicating this setup logic is a smaller risk than touching a
// slow, expensive-to-debug real-infra suite for a behavior-neutral refactor.

export const WORLD_PASSWORD = 'Correct-Horse-Battery-Staple9!';

export interface ThreePeerWorld {
    bootstrap?: BootstrapNode;
    /** Mutable — a caller that relaunches a peer (e.g. an offline/reconnect
     * scenario) should reassign this field so `teardown()` closes the *current*
     * instance rather than a stale one it no longer owns. */
    peerAlice: LaunchedApp;
    peerBob: LaunchedApp;
    peerCharlie: LaunchedApp;
    pageAlice: Page;
    pageBob: Page;
    pageCharlie: Page;
    peerIdAlice: string;
    peerIdBob: string;
    peerIdCharlie: string;
    usernameAlice: string;
    usernameBob: string;
    usernameCharlie: string;
    groupName: string;
    runSuffix: string;
    /** [timing] log label prefix this world's setup stages were logged under. */
    label: string;
    /** Closes all three peers (reading the current peer/page fields, so a
     * caller-side relaunch is honored) and stops the local bootstrap node, if
     * one was started. */
    teardown(): Promise<void>;
}

export interface SetupThreePeerWorldOptions {
    /** libp2p listen ports used are basePort, basePort+1, basePort+2 (Alice/Bob/Charlie). */
    basePort: number;
    /** Prefix for this setup's [timing] stage logs. Defaults to 'world'. */
    label?: string;
}

export async function setupThreePeerWorld(options: SetupThreePeerWorldOptions): Promise<ThreePeerWorld> {
    const { basePort, label = 'world' } = options;
    let bootstrap: BootstrapNode | undefined;
    let peerAlice: LaunchedApp | undefined;
    let peerBob: LaunchedApp | undefined;
    let peerCharlie: LaunchedApp | undefined;

    // Fresh random suffix every run — usernames AND the group name register/
    // persist on the real, shared DHT (see e2e/config.ts), so fixed names
    // would collide with a previous run's state.
    const runSuffix = uniqueRunSuffix();
    const usernameAlice = `alice_${runSuffix}`;
    const usernameBob = `bob_${runSuffix}`;
    const usernameCharlie = `charlie_${runSuffix}`;
    const groupName = `grp_${runSuffix}`;

    try {
        const bootstrapMultiaddr = USE_LOCAL_BOOTSTRAP
            ? (bootstrap = await startBootstrapNode()).multiaddr
            : BOOTSTRAP_MULTIADDR;

        [peerAlice, peerBob, peerCharlie] = await Promise.all([
            launchApp({ p2pPort: basePort }),
            launchApp({ p2pPort: basePort + 1 }),
            launchApp({ p2pPort: basePort + 2 }),
        ]);
        const { page: pageAlice } = peerAlice;
        const { page: pageBob } = peerBob;
        const { page: pageCharlie } = peerCharlie;

        const onboardOptions = {
            password: WORLD_PASSWORD,
            bootstrapMultiaddr,
            relayMultiaddr: RELAY_MULTIADDR,
            stunUrl: STUN_URL,
        };
        const [{ peerId: peerIdAlice }, { peerId: peerIdBob }, { peerId: peerIdCharlie }] = await timedStage(
            label, 'onboard_all_three', () => Promise.all([
                onboard(pageAlice, { ...onboardOptions, username: usernameAlice }),
                onboard(pageBob, { ...onboardOptions, username: usernameBob }),
                onboard(pageCharlie, { ...onboardOptions, username: usernameCharlie }),
            ]),
        );
        expect(peerIdAlice).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20,}$/);
        expect(peerIdBob).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20,}$/);
        expect(peerIdCharlie).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20,}$/);
        expect(new Set([peerIdAlice, peerIdBob, peerIdCharlie]).size).toBe(3);

        // --- Contact prerequisites: Alice <-> Bob, Alice <-> Charlie only. ---
        await timedStage(label, 'contact_alice_bob', async () => {
            const firstMessage = 'Hi Bob, this is Alice — adding you as a contact.';
            await sendContactRequest(pageAlice, peerIdBob, firstMessage);
            await expect(pageBob.getByText(usernameAlice, { exact: true })).toBeVisible({ timeout: 20_000 });
            await acceptContactRequest(pageBob, usernameAlice);
            await Promise.all([
                expect(chatMessage(pageAlice, firstMessage)).toBeVisible({ timeout: 30_000 }),
                expect(chatMessage(pageBob, firstMessage)).toBeVisible({ timeout: 30_000 }),
            ]);
        });

        await timedStage(label, 'contact_alice_charlie', async () => {
            const firstMessage = 'Hi Charlie, this is Alice — adding you as a contact.';
            await sendContactRequest(pageAlice, peerIdCharlie, firstMessage);
            await expect(pageCharlie.getByText(usernameAlice, { exact: true })).toBeVisible({ timeout: 20_000 });
            await acceptContactRequest(pageCharlie, usernameAlice);
            await Promise.all([
                expect(chatMessage(pageAlice, firstMessage)).toBeVisible({ timeout: 30_000 }),
                expect(chatMessage(pageCharlie, firstMessage)).toBeVisible({ timeout: 30_000 }),
            ]);
        });

        // --- Alice creates the group and invites both Bob and Charlie. ---
        await timedStage(label, 'create_group', async () => {
            await openNewGroupDialog(pageAlice);
            await pageAlice.getByPlaceholder('Enter group name...').fill(groupName);
            await pageAlice.getByRole('button', { name: usernameBob, exact: true }).click();
            await pageAlice.getByRole('button', { name: usernameCharlie, exact: true }).click();
            await expect(pageAlice.getByText('Selected (2)')).toBeVisible();
            await pageAlice.getByRole('button', { name: 'Send Invites' }).click();
            await expect(pageAlice.getByRole('heading', { name: 'New Group' })).toBeHidden({ timeout: 20_000 });
        });

        await expect(sidebarChatEntry(pageAlice, groupName)).toBeVisible({ timeout: 15_000 });

        await timedStage(label, 'invites_delivered', () => Promise.all([
            waitForGroupInvite(pageBob, groupName),
            waitForGroupInvite(pageCharlie, groupName),
        ]));

        await timedStage(label, 'accept_invites', async () => {
            await acceptGroupInvite(pageBob, groupName);
            await acceptGroupInvite(pageCharlie, groupName);
        });

        await expect(sidebarChatEntry(pageBob, groupName)).toBeVisible({ timeout: 15_000 });
        await expect(sidebarChatEntry(pageCharlie, groupName)).toBeVisible({ timeout: 15_000 });

        // --- Wait for full activation on all three sides. ---
        await timedStage(label, 'group_active_all_three', async () => {
            await openChat(pageAlice, groupName);
            await openChat(pageBob, groupName);
            await openChat(pageCharlie, groupName);
            await Promise.all([
                expect(pageAlice.getByPlaceholder('Type a message...')).toBeEnabled({ timeout: 60_000 }),
                expect(pageBob.getByPlaceholder('Type a message...')).toBeEnabled({ timeout: 60_000 }),
                expect(pageCharlie.getByPlaceholder('Type a message...')).toBeEnabled({ timeout: 60_000 }),
            ]);
        });

        const world: ThreePeerWorld = {
            bootstrap,
            peerAlice,
            peerBob,
            peerCharlie,
            pageAlice,
            pageBob,
            pageCharlie,
            peerIdAlice,
            peerIdBob,
            peerIdCharlie,
            usernameAlice,
            usernameBob,
            usernameCharlie,
            groupName,
            runSuffix,
            label,
            teardown: async () => {
                await world.peerAlice?.close().catch((error) => console.error('Failed to close Alice:', error));
                await world.peerBob?.close().catch((error) => console.error('Failed to close Bob:', error));
                await world.peerCharlie?.close().catch((error) => console.error('Failed to close Charlie:', error));
                await world.bootstrap?.stop().catch((error) => console.error('Failed to stop bootstrap node:', error));
            },
        };
        return world;
    } catch (error) {
        // Best-effort teardown of whatever got created before the failure, so a
        // setup failure doesn't leak Electron processes/a bootstrap node into
        // the rest of the run.
        await peerAlice?.close().catch(() => undefined);
        await peerBob?.close().catch(() => undefined);
        await peerCharlie?.close().catch(() => undefined);
        await bootstrap?.stop().catch(() => undefined);
        throw error;
    }
}

/**
 * Locator for a message *bubble* in the currently open chat, disambiguated
 * from the sidebar chat-list's truncated last-message preview (which renders
 * the same/similar text and would otherwise trip Playwright's strict-mode
 * duplicate check). MessageRow.tsx marks every real bubble — text AND file —
 * with a bare `data-message-bubble` attribute (confirmed by reading the
 * component: the attribute sits on the shared bubble wrapper div, above the
 * per-type branch between plain text and <FileMessage>); ChatPreview.tsx's
 * sidebar snippet never carries it.
 */
export function chatMessage(page: Page, text: string) {
    return page.locator('[data-message-bubble]').getByText(text);
}

/**
 * Locator for a file/image message bubble containing the given file name
 * anywhere in its card (name, status, Accept/Reject buttons, etc.) — same
 * `[data-message-bubble]` scoping as chatMessage, but using `.filter({
 * hasText })` instead of `.getByText()` since a file bubble's own visible text
 * is split across several elements (icon, name, size, status) rather than one
 * exact string.
 */
export function fileBubble(page: Page, fileName: string) {
    return page.locator('[data-message-bubble]').filter({ hasText: fileName });
}

/**
 * Locator for a chat's entry in the sidebar list. Deliberately stricter than
 * group-chat.spec.ts's `button:has-text(name)` version: in a populated world
 * a chat row's *preview* line can legitimately contain another chat's name —
 * e.g. the group row's "bob_<suffix> joined the group" system-message preview
 * contains Bob's username, so a plain hasText filter for "bob_<suffix>"
 * strict-mode-collides with the group row (observed on this suite's first
 * runs). ChatPreview.tsx renders the chat's own name in a dedicated
 * `<span title={chat.name}>` inside the row button, and nothing else in the
 * row carries a title attribute with a chat name, so anchoring on that span
 * uniquely identifies the row regardless of what the preview text says. Also
 * inherently disambiguated from the chat header's title (an <h3>, not inside
 * a <button> — see ChatHeader.tsx).
 */
export function sidebarChatEntry(page: Page, name: string) {
    return page.locator('button').filter({ has: page.locator(`span[title="${name}"]`) });
}

/** Locator for the unread-count badge (ChatPreview.tsx) on a given chat's sidebar row, if present. */
export function unreadBadge(page: Page, chatName: string) {
    return sidebarChatEntry(page, chatName).locator('div.rounded-full.bg-primary');
}

/** Opens a chat (direct or group) from the sidebar list by its display name. */
export async function openChat(page: Page, name: string) {
    await sidebarChatEntry(page, name).click();
}

/**
 * Opens the "New Group" dialog via the sidebar header's "+" menu. Reuses the
 * lucide-plus button targeting trick from onboard.ts's
 * openNewConversationDialog (SidebarHeader.tsx's "+" button has no accessible
 * name of its own).
 */
async function openNewGroupDialog(page: Page): Promise<void> {
    await page.locator('button:has(svg.lucide-plus)').first().click();
    await page.getByRole('button', { name: 'New Group', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New Group' })).toBeVisible({ timeout: 10_000 });
}

/**
 * Waits for a pending group invite (GroupInviteList / GroupInviteItem) to
 * appear on the invitee's sidebar. No manual refresh is needed: the sender's
 * bucket-nudge (bucket-nudge protocol -> offline-bucket fetch ->
 * OFFLINE_MESSAGES_FETCH_COMPLETE -> GroupInviteList refetch) pushes the
 * invite into the list within seconds while both peers are online, with the
 * periodic offline check (OFFLINE_MESSAGE_CHECK_INTERVAL) as the fallback.
 */
async function waitForGroupInvite(page: Page, groupName: string): Promise<void> {
    await expect(page.getByText(groupName, { exact: true })).toBeVisible({ timeout: 60_000 });
}

/** Accepts the (single) pending group invite with the given group name. */
async function acceptGroupInvite(page: Page, groupName: string): Promise<void> {
    await expect(page.getByText(groupName, { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Accept', exact: true }).click();
}

export async function attach(testInfo: TestInfo, page: Page, name: string) {
    const screenshotPath = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' });
}

/** Dumps a peer's captured main-process stdout/stderr as a test attachment (debugging aid on failure). */
export async function attachLogs(testInfo: TestInfo, peer: LaunchedApp | undefined, name: string) {
    if (!peer) return;
    await testInfo.attach(name, { body: peer.logs.join(''), contentType: 'text/plain' });
}
