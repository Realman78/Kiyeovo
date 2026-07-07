import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { launchApp, type LaunchedApp } from './electron';
import { startBootstrapNode, type BootstrapNode } from './bootstrap-node';
import { onboard, sendContactRequest, acceptContactRequest, sendChatMessage, timedStage } from './onboard';
import { BOOTSTRAP_MULTIADDR, RELAY_MULTIADDR, STUN_URL, USE_LOCAL_BOOTSTRAP, uniqueRunSuffix } from './config';

// Real three-peer group-chat flow, built directly on top of two-peer.spec.ts's
// helpers and conventions (see e2e/group-test-plan.md for the authoritative
// scope). Alice creates a group with Bob and Charlie already established as
// her direct contacts; deliberately Bob and Charlie are NOT contacts of each
// other, to verify group message fan-out doesn't silently depend on a
// pairwise contact link between every pair of members (it goes through the
// group's own invite/welcome/gossip machinery instead — see
// src/core/group/control/{group-creator,group-responder}.ts).
//
// Three real onboardings plus two real contact exchanges plus a group
// creation/activation round trip is a lot of real DHT/relay round trips, so
// this is the slowest suite in e2e/ — generous timeout, event-based waits
// throughout, per-stage [timing] logs so a slow run can be diagnosed from
// console output alone (same rationale as two-peer.spec.ts).
test.setTimeout(6 * 60_000);

const PASSWORD = 'Correct-Horse-Battery-Staple9!';

test('three peers form a group and messages fan out to every member @slow', async () => {
    const testInfo = test.info();
    const testStart = Date.now();
    let bootstrap: BootstrapNode | undefined;
    let peerAlice: LaunchedApp | undefined;
    let peerBob: LaunchedApp | undefined;
    let peerCharlie: LaunchedApp | undefined;
    let failed = false;

    // Fresh random suffix every run — usernames AND the group name register/
    // persist on the real, shared DHT (see e2e/config.ts), so fixed names
    // would collide with a previous run's state.
    const runSuffix = uniqueRunSuffix();
    const usernameAlice = `alice_${runSuffix}`;
    const usernameBob = `bob_${runSuffix}`;
    const usernameCharlie = `charlie_${runSuffix}`;
    const groupName = `grp_${runSuffix}`;

    try {
        // Port 19502 (not the bare default 19501, which two-peer.spec.ts
        // owns) and p2pPorts 9141-9143 (not 9101-9103, which two-peer.spec.ts
        // also owns) — see e2e/config.ts's "PORT RANGES" table. Distinct
        // per-file ranges let this file run concurrently with two-peer.spec.ts
        // in a separate worker without colliding.
        const bootstrapMultiaddr = USE_LOCAL_BOOTSTRAP
            ? (bootstrap = await startBootstrapNode(19502)).multiaddr
            : BOOTSTRAP_MULTIADDR;

        [peerAlice, peerBob, peerCharlie] = await Promise.all([
            launchApp({ p2pPort: 9141 }),
            launchApp({ p2pPort: 9142 }),
            launchApp({ p2pPort: 9143 }),
        ]);
        const { page: pageAlice } = peerAlice;
        const { page: pageBob } = peerBob;
        const { page: pageCharlie } = peerCharlie;

        const onboardOptions = {
            password: PASSWORD,
            bootstrapMultiaddr,
            relayMultiaddr: RELAY_MULTIADDR,
            stunUrl: STUN_URL,
        };
        const [{ peerId: peerIdAlice }, { peerId: peerIdBob }, { peerId: peerIdCharlie }] = await timedStage(
            'group', 'onboard_all_three', () => Promise.all([
                onboard(pageAlice, { ...onboardOptions, username: usernameAlice }),
                onboard(pageBob, { ...onboardOptions, username: usernameBob }),
                onboard(pageCharlie, { ...onboardOptions, username: usernameCharlie }),
            ]),
        );
        expect(peerIdAlice).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20,}$/);
        expect(peerIdBob).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20,}$/);
        expect(peerIdCharlie).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20,}$/);
        expect(new Set([peerIdAlice, peerIdBob, peerIdCharlie]).size).toBe(3);

        await attach(testInfo, pageAlice, 'alice-onboarded');
        await attach(testInfo, pageBob, 'bob-onboarded');
        await attach(testInfo, pageCharlie, 'charlie-onboarded');

        // --- Contact prerequisites: Alice <-> Bob, Alice <-> Charlie only. ---
        // Bob and Charlie deliberately never exchange a contact request with
        // each other (see the file-level comment above).
        await timedStage('group', 'contact_alice_bob', async () => {
            const firstMessage = 'Hi Bob, this is Alice — adding you as a contact.';
            await sendContactRequest(pageAlice, peerIdBob, firstMessage);
            await expect(pageBob.getByText(usernameAlice, { exact: true })).toBeVisible({ timeout: 20_000 });
            await acceptContactRequest(pageBob, usernameAlice);
            await Promise.all([
                expect(chatMessage(pageAlice, firstMessage)).toBeVisible({ timeout: 30_000 }),
                expect(chatMessage(pageBob, firstMessage)).toBeVisible({ timeout: 30_000 }),
            ]);
        });

        await timedStage('group', 'contact_alice_charlie', async () => {
            const firstMessage = 'Hi Charlie, this is Alice — adding you as a contact.';
            await sendContactRequest(pageAlice, peerIdCharlie, firstMessage);
            await expect(pageCharlie.getByText(usernameAlice, { exact: true })).toBeVisible({ timeout: 20_000 });
            await acceptContactRequest(pageCharlie, usernameAlice);
            await Promise.all([
                expect(chatMessage(pageAlice, firstMessage)).toBeVisible({ timeout: 30_000 }),
                expect(chatMessage(pageCharlie, firstMessage)).toBeVisible({ timeout: 30_000 }),
            ]);
        });

        await attach(testInfo, pageAlice, 'alice-contacts-established');
        await attach(testInfo, pageBob, 'bob-contact-established');
        await attach(testInfo, pageCharlie, 'charlie-contact-established');

        // --- Alice creates the group and invites both Bob and Charlie. ---
        // NewGroupDialog (src/ui/components/sidebar/header/NewGroupDialog.tsx)
        // only offers Alice's existing contacts as selectable invitees — this
        // is the app enforcing "members must be contacts of the creator
        // first", confirmed by reading that component and
        // group-responder.ts's handleGroupInvite (drops an invite from an
        // unknown/non-contact sender).
        await timedStage('group', 'create_group', async () => {
            await openNewGroupDialog(pageAlice);
            await pageAlice.getByPlaceholder('Enter group name...').fill(groupName);
            await pageAlice.getByRole('button', { name: usernameBob, exact: true }).click();
            await pageAlice.getByRole('button', { name: usernameCharlie, exact: true }).click();
            await expect(pageAlice.getByText('Selected (2)')).toBeVisible();
            await pageAlice.getByRole('button', { name: 'Send Invites' }).click();
            await expect(pageAlice.getByRole('heading', { name: 'New Group' })).toBeHidden({ timeout: 20_000 });
        });

        // Group appears immediately in the creator's own sidebar (her chat
        // is created 'active' right away — see group-creator.ts — even
        // though the *group's* status stays 'invited_pending' until someone
        // joins).
        await expect(sidebarChatEntry(pageAlice, groupName)).toBeVisible({ timeout: 15_000 });
        await attach(testInfo, pageAlice, 'alice-group-created');

        // Invites land as pending "Group Invites" entries on Bob's and
        // Charlie's sidebars (GroupInviteList — separate from the chat list
        // until accepted). There is no push notification into that list on
        // arrival (only a fetch on mount / on an offline-fetch-complete
        // event — see GroupInviteList.tsx), so this poll also nudges a
        // remount via the sidebar rail (Groups -> Chats) if the plain wait
        // doesn't see it appear quickly, forcing a fresh getGroupInvites().
        await timedStage('group', 'invites_delivered', () => Promise.all([
            waitForGroupInvite(pageBob, groupName),
            waitForGroupInvite(pageCharlie, groupName),
        ]));
        await attach(testInfo, pageBob, 'bob-group-invite-received');
        await attach(testInfo, pageCharlie, 'charlie-group-invite-received');

        // --- Bob and Charlie accept ---
        await timedStage('group', 'accept_invites', async () => {
            await acceptGroupInvite(pageBob, groupName);
            await acceptGroupInvite(pageCharlie, groupName);
        });

        await expect(sidebarChatEntry(pageBob, groupName)).toBeVisible({ timeout: 15_000 });
        await expect(sidebarChatEntry(pageCharlie, groupName)).toBeVisible({ timeout: 15_000 });

        // --- Wait for full activation on all three sides. ---
        // The message box is disabled client-side while a member's local
        // group_status isn't 'active' yet (ChatInput.tsx's groupBlockedReason
        // — the group "becomes active after at least one user joins", per
        // NewGroupDialog's own explanatory copy), so polling it directly is
        // the most honest signal that the group is actually usable — no
        // internal state reached through the DOM alone.
        await timedStage('group', 'group_active_all_three', async () => {
            await openChat(pageAlice, groupName);
            await openChat(pageBob, groupName);
            await openChat(pageCharlie, groupName);
            await Promise.all([
                expect(pageAlice.getByPlaceholder('Type a message...')).toBeEnabled({ timeout: 60_000 }),
                expect(pageBob.getByPlaceholder('Type a message...')).toBeEnabled({ timeout: 60_000 }),
                expect(pageCharlie.getByPlaceholder('Type a message...')).toBeEnabled({ timeout: 60_000 }),
            ]);
        });
        await attach(testInfo, pageAlice, 'alice-group-active');
        await attach(testInfo, pageBob, 'bob-group-active');
        await attach(testInfo, pageCharlie, 'charlie-group-active');

        // The composer gate above is necessary but NOT sufficient for
        // realtime fan-out: every join rotates the group key
        // (group-creator.ts), gossip topics are derived per key epoch
        // (group-messaging.ts's deriveTopic), and a member whose local
        // key_version still lags the newest rotation (his composer has been
        // enabled since his OWN join epoch) is not yet subscribed to the
        // topic fan-out 1 will ride — publish() then sees too few remote
        // subscribers and the send silently settles to offline-only DHT
        // delivery (recipients poll that every 5 minutes), which a 30s
        // realtime wait can never observe. That exact designed fallback was
        // caught live (DEBUG_MODE main-process logs: "PublishError.
        // NoPeersSubscribedToTopic" -> one 750ms retry -> "Falling back to
        // offline delivery") while stabilizing blocking.spec.ts's identical
        // first-send — and this file's fan-out 1 failed the same way once
        // the suite went parallel (2-worker run, 2026-07-06). Converging all
        // three members' key_version (via the UI's own getChats IPC — raw
        // DB rows) closes that window while keeping every fan-out assertion
        // below a pure realtime-gossip check, which is this file's charter.
        // See blocking.spec.ts's file-level "Group realtime-vs-offline
        // fan-out split" note for the full mechanism.
        await timedStage('group', 'group_epoch_convergence', async () => {
            await expect.poll(
                async () => {
                    const versions = await Promise.all([pageAlice, pageBob, pageCharlie].map(
                        (page) => page.evaluate(async (name) => {
                            const result = await window.kiyeovoAPI.getChats();
                            if (!result.success) return -1;
                            const chat = (result.chats as Array<Record<string, unknown>>).find(
                                (c) => c.type === 'group' && c.name === name,
                            );
                            return chat ? Number(chat.key_version ?? 0) : -1;
                        }, groupName),
                    ));
                    return versions.every((v) => v >= 1 && v === versions[0])
                        ? 'converged'
                        : `key_versions=[${versions.join(',')}]`;
                },
                {
                    message: 'group key epochs never converged across all three members',
                    timeout: 60_000,
                    intervals: [500, 1_000],
                },
            ).toBe('converged');
        });

        // --- Fan-out 1: creator (Alice) sends -> Bob and Charlie receive ---
        const messageFromAlice = 'Alice: welcome to the group, everyone!';
        await timedStage('group', 'fanout_alice_to_all', async () => {
            await sendChatMessage(pageAlice, messageFromAlice);
            await Promise.all([
                expect(chatMessage(pageBob, messageFromAlice)).toBeVisible({ timeout: 30_000 }),
                expect(chatMessage(pageCharlie, messageFromAlice)).toBeVisible({ timeout: 30_000 }),
            ]);
        });
        await attach(testInfo, pageBob, 'bob-received-alice-broadcast');
        await attach(testInfo, pageCharlie, 'charlie-received-alice-broadcast');

        // --- Fan-out 2: non-creator (Bob) sends -> Alice and Charlie receive ---
        const messageFromBob = 'Bob: glad to be here, thanks for the invite!';
        await timedStage('group', 'fanout_bob_to_all', async () => {
            await sendChatMessage(pageBob, messageFromBob);
            await Promise.all([
                expect(chatMessage(pageAlice, messageFromBob)).toBeVisible({ timeout: 30_000 }),
                expect(chatMessage(pageCharlie, messageFromBob)).toBeVisible({ timeout: 30_000 }),
            ]);
        });
        await attach(testInfo, pageAlice, 'alice-received-bob-broadcast');
        await attach(testInfo, pageCharlie, 'charlie-received-bob-broadcast');

        // --- Fan-out 3: message arrives while Charlie is on a different chat ---
        // Charlie switches away from the group to his direct chat with
        // Alice; while he's there, Alice sends another group message. Bob
        // (still viewing the group) receives it directly; Charlie — not
        // viewing the group — gets an unread-count badge on it instead
        // (chatSlice.ts only increments unreadCount for a chat that isn't
        // the active one). Charlie then switches back (which should reveal
        // the message he missed) and sends his own reply, proving delivery
        // survives him having been elsewhere and that his outbound fan-out
        // still reaches both other members.
        const messageWhileCharlieAway = 'Alice: are you still there, Charlie?';
        await timedStage('group', 'charlie_away_gets_unread', async () => {
            await openChat(pageCharlie, usernameAlice);
            await sendChatMessage(pageAlice, messageWhileCharlieAway);
            await expect(chatMessage(pageBob, messageWhileCharlieAway)).toBeVisible({ timeout: 30_000 });
            await expect(unreadBadge(pageCharlie, groupName)).toBeVisible({ timeout: 30_000 });
        });
        await attach(testInfo, pageCharlie, 'charlie-unread-badge-on-different-chat');
        await attach(testInfo, pageBob, 'bob-received-while-charlie-away');

        const messageFromCharlie = 'Charlie: back now — hi all, sorry for the delay!';
        await timedStage('group', 'charlie_returns_and_sends', async () => {
            await openChat(pageCharlie, groupName);
            await expect(chatMessage(pageCharlie, messageWhileCharlieAway)).toBeVisible({ timeout: 15_000 });
            await sendChatMessage(pageCharlie, messageFromCharlie);
            await Promise.all([
                expect(chatMessage(pageAlice, messageFromCharlie)).toBeVisible({ timeout: 30_000 }),
                expect(chatMessage(pageBob, messageFromCharlie)).toBeVisible({ timeout: 30_000 }),
            ]);
        });
        await attach(testInfo, pageAlice, 'alice-final');
        await attach(testInfo, pageBob, 'bob-final');
        await attach(testInfo, pageCharlie, 'charlie-final');
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][group] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) {
            await attachLogs(testInfo, peerAlice, 'alice-main-process-logs');
            await attachLogs(testInfo, peerBob, 'bob-main-process-logs');
            await attachLogs(testInfo, peerCharlie, 'charlie-main-process-logs');
        }
        await peerAlice?.close().catch((error) => console.error('Failed to close Alice:', error));
        await peerBob?.close().catch((error) => console.error('Failed to close Bob:', error));
        await peerCharlie?.close().catch((error) => console.error('Failed to close Charlie:', error));
        await bootstrap?.stop().catch((error) => console.error('Failed to stop bootstrap node:', error));
    }
});

/**
 * Locator for a message *bubble* in the currently open chat — see
 * two-peer.spec.ts for why this must be scoped to [data-message-bubble]
 * rather than a plain getByText: the sidebar's chat-list preview
 * (ChatPreview.tsx) renders the same truncated text in a plain <p>, and
 * MessageRow.tsx (shared by direct AND group chats — confirmed by reading
 * the component, it has no direct/group branching) marks every real bubble
 * with a bare `data-message-bubble` attribute.
 */
function chatMessage(page: Page, text: string) {
    return page.locator('[data-message-bubble]').getByText(text);
}

/**
 * Locator for a chat's entry in the sidebar list, disambiguated from the
 * chat header's own title (ChatHeader.tsx renders the active chat's name in
 * an <h3>, not inside a <button>) — ChatPreview.tsx's row is a <button>, so
 * scoping to button role/text avoids double-matching the same name once a
 * chat is open and both the sidebar row and the header show it at once.
 */
function sidebarChatEntry(page: Page, name: string) {
    return page.locator('button').filter({ hasText: name });
}

/** Locator for the unread-count badge (ChatPreview.tsx) on a given chat's sidebar row, if present. */
function unreadBadge(page: Page, chatName: string) {
    return sidebarChatEntry(page, chatName).locator('div.rounded-full.bg-primary');
}

/** Opens a chat (direct or group) from the sidebar list by its display name. */
async function openChat(page: Page, name: string) {
    await sidebarChatEntry(page, name).click();
}

/**
 * Opens the "New Group" dialog via the sidebar header's "+" menu. Reuses the
 * lucide-plus button targeting trick from onboard.ts's
 * openNewConversationDialog (SidebarHeader.tsx's "+" button has no
 * accessible name of its own).
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
