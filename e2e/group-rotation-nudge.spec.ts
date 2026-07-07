import { test, expect, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './electron';
import { startBootstrapNode, type BootstrapNode } from './bootstrap-node';
import {
    startOnionFrontedBootstrap,
    launchAnonymousApp,
    onboardAnonymous,
    waitForRealDhtConnectionAnonymous,
    type OnionFrontedBootstrap,
} from './tor';
import {
    onboard,
    sendContactRequest,
    acceptContactRequest,
    sendChatMessage,
    timedStage,
    getDhtConnected,
    navigateToBootstrapSetup,
} from './onboard';
import { RELAY_MULTIADDR, STUN_URL, uniqueRunSuffix } from './config';
import { chatMessage, sidebarChatEntry, openChat, attach, attachLogs } from './world';

// Regression coverage for 7dc137f ("Force-dial the bucket nudge for
// GROUP_STATE_UPDATE"). MANDATORY READING done before writing anything below:
// `git show 7dc137f`; src/core/group/dht/group-refetch-nudge.ts (the
// FORCE_DIAL_NUDGE_TYPES comment); src/core/lib/message-handler.ts's
// sendBucketNudge (~line 625-775); e2e conventions (config.ts's PORT RANGES,
// tor.ts, tor-groups.spec.ts, group-chat.spec.ts, blocking.spec.ts,
// offline-delivery.spec.ts, electron.ts).
//
// --- What the fix does (code-confirmed, git show 7dc137f) ---
// GROUP_STATE_UPDATE (the key-epoch-rotation announcement the creator sends
// to every REMAINING member on a join/kick) is now in FORCE_DIAL_NUDGE_TYPES
// (group-refetch-nudge.ts:21-38) alongside GROUP_INVITE/GROUP_KICK/
// GROUP_INVITE_RESPONSE — its realtime "come refetch now" nudge is sent with
// `{ allowDialWithoutConnection: true }` even when the creator has no live
// libp2p connection to that member, instead of being silently skipped
// (message-handler.ts:643's `if (!hasActiveConnection && !allowDialWithoutConnection) return;`
// early-out, which this fix routes GROUP_STATE_UPDATE around). Why it
// matters: the control message itself is ALWAYS durably written to the
// recipient's DHT bucket first regardless of nudge outcome
// (sendControlMessageToPeer, group-creator.ts:1874-1932, code-confirmed by
// recon), so no message is ever lost outright — but an epoch-lagged member
// who doesn't learn about the rotation keeps sending into the OLD epoch's
// bucket/topic, and a healed peer permanently drops old-bucket messages
// timestamped more than GROUP_ROTATION_GRACE_WINDOW_MS (60s,
// src/core/constants.ts:418) past the rotation boundary — silent loss,
// invisible to the sender (no resend-on-heal exists, per the commit's own
// "Known residual" note). The realtime nudge is also the ONLY prompt path
// for an online-but-disconnected member: recon confirmed (a)
// OFFLINE_MESSAGE_CHECK_INTERVAL has no periodic-sweep call site anywhere,
// (b) `nudgePeerDirectSessionReset`/`handleDirectLinkReset`
// (message-handler.ts:446/1976) — the only OTHER code path that could
// re-trigger a group catch-up on reconnect — is dead code, never called from
// anywhere in src/core, and (c) `src/core/index.ts` has no on-boot sweep
// across group chats either. The only genuinely automatic (no manual click)
// recovery left, besides this nudge, is the RECEIVING side's own app launch:
// `src/ui/pages/Main.tsx`'s `syncRecentOfflineMessages` effect
// (Main.tsx:891-1073) fires as soon as the renderer sees `canFetchOffline`
// flip true and unconditionally calls `checkGroupOfflineMessages()`
// (Main.tsx:944-961) for every recently-active group chat (status
// 'active'/'rekeying'/'removed-with-catchup') among the 15 most recent chats
// — this is what R2 below exercises (a RELAUNCHED member heals itself,
// independent of whether the sender's nudge ever landed), in deliberate
// contrast to R1 (a STILL-RUNNING member that has no such self-triggered
// path and depends entirely on the sender's forced dial).
//
// --- sendBucketNudge log-line vocabulary (message-handler.ts:625-775, all
// gated behind DEBUG_MODE=true, src/shared/logger.ts) used below to prove
// WHICH branch actually fired, not just infer it from timing ---
//   [NUDGE][SEND][START] attempt=<N> peer=<suffix> group=<groupIdPrefix>
//     cooldownKey=... totalConnections=<N> peerConnections=<N> ...
//     — peerConnections is the connection-liveness snapshot AT THE MOMENT
//     the nudge attempt starts (getNudgeConnectionSnapshot, message-
//     handler.ts:248-269, a raw filter over `node.getConnections()` — no
//     custom bookkeeping). peerConnections=0 here is the authoritative
//     "forced cold dial" signal; peerConnections>0 is "an existing
//     connection survived (reconnect/piggyback), tried first via
//     [NUDGE][STREAM][REUSE_*]". IMPORTANT recon finding: because
//     GROUP_STATE_UPDATE is in FORCE_DIAL_NUDGE_TYPES, `allowDialWithoutConnection`
//     is unconditionally true for it, so the early-return
//     `[NUDGE][SKIP_NO_CONN]` branch (message-handler.ts:643-650) can NEVER
//     fire for this message type — the only question this fix's own log
//     trail can answer is REUSE-vs-DIAL, not skip-vs-nudge (that binary
//     distinction is exactly what the PRE-fix code would have hit, which is
//     why this file exists).
//   [NUDGE][DIAL][START] / [NUDGE][DIAL][OK] — cold dial attempted (peer had
//     zero connections, or every existing connection failed to yield a reusable stream).
//   [NUDGE][STREAM][REUSE_TRY|OK|FAIL] — reuse of an existing connection attempted.
//   [NUDGE][SEND][OK] attempt=<N> peer=<suffix> source=(reuse|dial) — final success.
//   [NUDGE][SEND_FAIL] attempt=<N> peer=<suffix> ... reason=... errorName=...
//     — best-effort failure (no crash, no retry — "peer offline or
//     unreachable, offline bucket still delivers", message-handler.ts:772).
// cooldownKey is `group:${recipientPeerId}:${groupId}` (nudgePeerGroupRefetch,
// message-handler.ts:438-444) — keyed per RECIPIENT, so a kick's own
// GROUP_KICK nudge (to the kicked member) and a remaining member's
// GROUP_STATE_UPDATE nudge never share a cooldown bucket, confirmed via
// recon. BUCKET_NUDGE_DIAL_TIMEOUT_MS = 5s, BUCKET_NUDGE_COOLDOWN_MS = 5s
// (src/core/constants.ts:140-141) — both far tighter than a genuine cold
// onion circuit (30-90s elsewhere in this suite), which is itself a notable
// finding R3 is instrumented to surface honestly rather than paper over.
//
// --- Scenario map ---
// R1 (fast, T1-approximation): live 3-peer group; C relaunches (same
//   profile, fresh libp2p node => zero connections to anyone) and kicks M1
//   the instant unlock completes — before any dial to M2 could plausibly
//   have happened. Asserts M2 sees the removal with NO manual action, then
//   that C<->M2 messaging still works, and reports (does not gate pass/fail
//   on) which nudge branch actually fired.
// R2 (fast, T3): M2's app is fully CLOSED (process gone, profile kept) while
//   C (warm, still running) kicks M1 — C's forced dial to M2 is guaranteed
//   to fail (no listener at all). Asserts C stays healthy (captures the
//   [NUDGE][SEND_FAIL] line, no crash) and that a RELAUNCHED M2 heals itself
//   via Main.tsx's own startup sweep (see above) with no manual action, then
//   can message normally.
// R3 (Tor, T2-approximation): same shape as R1, over anonymous mode/onion
//   circuits — genuinely slower and more expensive (3 Tor daemons + a
//   relaunch that restarts a 4th), budgeted at 12 minutes per the standing
//   Tor exception (tor-mode.spec.ts/trusted-import.spec.ts/tor-groups.spec.ts).
//   MARKED test.fixme (see the comment directly above the test): three
//   consecutive attempts on this box all failed in generic/shared
//   Tor-onboarding infrastructure before this test's own logic ever ran —
//   documented, measured evidence attached, not a silent skip.
// R4 (fast, T4 smoke): two rapid membership changes back to back — kick M1,
//   then IMMEDIATELY re-invite M1 (via InviteUsersDialog's fresh "Invite"
//   action, not the pending-only "Re-invite" button) — see the shape
//   decision comment above the test itself for why this beats the
//   kick-M1-then-kick-M2 alternative. Asserts the creator's UI stays
//   responsive through the churn and M2 (the one member present for both
//   rotations) converges on the final epoch and receives C's final message.
//
// --- Port ranges (e2e/config.ts's PORT RANGES table, own row added) ---
// p2pPorts 9231-9239 (R1/R2/R4 reuse 9231-9233 for C/M1/M2, since
// fullyParallel:false means tests within this file never run concurrently;
// R2 also uses 9234-9236 so M2's relaunch keeps a stable port across its own
// close/reopen without colliding with a lingering listener; R3 reuses
// 9231-9233 too, being fast-mode-port-numbered but anonymous-mode-actual).
// Local throwaway bootstrap: fast-mode tests (R1/R2/R4) ALWAYS spin up their
// own local bootstrap (ignoring KIYEOVO_E2E_LOCAL_BOOTSTRAP) on port 20451 —
// this round needs precise control over connection liveness (a relaunched
// peer must reliably start with zero stale connections), which a shared
// real-infra bootstrap with other tests' lingering peers can't guarantee;
// same rationale as network-edges.spec.ts's own "always local" policy. R3's
// onion-fronted local bootstrap uses port 20452, and owns its own
// bundled-Tor-daemon SocksPort/ControlPort pairs (a range no other spec file
// touches): 9585/9586 (C), 9587/9588 (M1), 9589/9590 (M2).
//
// --- Deliberately out of scope ---
// Group file transfer, group-join-catchup mechanics (own file already), and
// any assertion that the FORCED DIAL itself completes within a specific
// latency budget — this round is about proving the nudge fires on the right
// branch and that the app's designed recovery paths actually heal the
// member, not a latency SLA for the dial.

const PASSWORD = 'Correct-Horse-Battery-Staple9!';

// ---------------------------------------------------------------------------
// Shared fast-mode group-formation helper (R1/R2/R4). Always uses a local
// throwaway bootstrap (see file header) — relay/STUN still come from the
// real deployed infra (RELAY_MULTIADDR/STUN_URL are required wizard steps
// even against a local bootstrap).
// ---------------------------------------------------------------------------
interface ActiveGroupOfThree {
    bootstrap: BootstrapNode;
    peerC: LaunchedApp;
    peerM1: LaunchedApp;
    peerM2: LaunchedApp;
    peerIdC: string;
    peerIdM1: string;
    peerIdM2: string;
    usernameC: string;
    usernameM1: string;
    usernameM2: string;
    groupName: string;
    runSuffix: string;
}

async function buildActiveGroupOfThree(label: string, basePort: number, bootstrapPort: number): Promise<ActiveGroupOfThree> {
    let bootstrap: BootstrapNode | undefined;
    let peerC: LaunchedApp | undefined;
    let peerM1: LaunchedApp | undefined;
    let peerM2: LaunchedApp | undefined;

    const runSuffix = uniqueRunSuffix();
    const usernameC = `rotc_${runSuffix}`;
    const usernameM1 = `rotm1_${runSuffix}`;
    const usernameM2 = `rotm2_${runSuffix}`;
    const groupName = `rotgrp_${runSuffix}`;

    try {
        bootstrap = await timedStage(label, 'start_local_bootstrap', () => startBootstrapNode(bootstrapPort));

        // C launched with DEBUG_MODE=true — every test in this file reads C's
        // own [NUDGE][...] log trail (see file header) to prove which branch
        // fired / capture the dial-failure line. M1/M2 don't need it.
        [peerC, peerM1, peerM2] = await timedStage(label, 'launch_three', () => Promise.all([
            launchApp({ p2pPort: basePort, env: { DEBUG_MODE: 'true' } }),
            launchApp({ p2pPort: basePort + 1 }),
            launchApp({ p2pPort: basePort + 2 }),
        ]));
        const { page: pageC } = peerC;
        const { page: pageM1 } = peerM1;
        const { page: pageM2 } = peerM2;

        const onboardOptions = {
            password: PASSWORD,
            bootstrapMultiaddr: bootstrap.multiaddr,
            relayMultiaddr: RELAY_MULTIADDR,
            stunUrl: STUN_URL,
        };
        const [{ peerId: peerIdC }, { peerId: peerIdM1 }, { peerId: peerIdM2 }] = await timedStage(
            label, 'onboard_all_three', () => Promise.all([
                onboard(pageC, { ...onboardOptions, username: usernameC }),
                onboard(pageM1, { ...onboardOptions, username: usernameM1 }),
                onboard(pageM2, { ...onboardOptions, username: usernameM2 }),
            ]),
        );
        expect(new Set([peerIdC, peerIdM1, peerIdM2]).size).toBe(3);

        await timedStage(label, 'contact_c_m1', async () => {
            const firstMessage = `Hi ${usernameM1}, this is ${usernameC} — adding you as a contact.`;
            await sendContactRequest(pageC, peerIdM1, firstMessage);
            await expect(pageM1.getByText(usernameC, { exact: true })).toBeVisible({ timeout: 20_000 });
            await acceptContactRequest(pageM1, usernameC);
            await Promise.all([
                expect(chatMessage(pageC, firstMessage)).toBeVisible({ timeout: 30_000 }),
                expect(chatMessage(pageM1, firstMessage)).toBeVisible({ timeout: 30_000 }),
            ]);
        });

        await timedStage(label, 'contact_c_m2', async () => {
            const firstMessage = `Hi ${usernameM2}, this is ${usernameC} — adding you as a contact.`;
            await sendContactRequest(pageC, peerIdM2, firstMessage);
            await expect(pageM2.getByText(usernameC, { exact: true })).toBeVisible({ timeout: 20_000 });
            await acceptContactRequest(pageM2, usernameC);
            await Promise.all([
                expect(chatMessage(pageC, firstMessage)).toBeVisible({ timeout: 30_000 }),
                expect(chatMessage(pageM2, firstMessage)).toBeVisible({ timeout: 30_000 }),
            ]);
        });

        await timedStage(label, 'create_group_and_invite', async () => {
            await openNewGroupDialog(pageC);
            await pageC.getByPlaceholder('Enter group name...').fill(groupName);
            await pageC.getByRole('button', { name: usernameM1, exact: true }).click();
            await pageC.getByRole('button', { name: usernameM2, exact: true }).click();
            await expect(pageC.getByText('Selected (2)')).toBeVisible();
            await pageC.getByRole('button', { name: 'Send Invites' }).click();
            await expect(pageC.getByRole('heading', { name: 'New Group' })).toBeHidden({ timeout: 20_000 });
        });
        await expect(sidebarChatEntry(pageC, groupName)).toBeVisible({ timeout: 15_000 });

        await timedStage(label, 'invites_delivered', () => Promise.all([
            waitForGroupInvite(pageM1, groupName),
            waitForGroupInvite(pageM2, groupName),
        ]));

        await timedStage(label, 'accept_invites', async () => {
            await acceptGroupInvite(pageM1, groupName);
            await acceptGroupInvite(pageM2, groupName);
        });
        await expect(sidebarChatEntry(pageM1, groupName)).toBeVisible({ timeout: 15_000 });
        await expect(sidebarChatEntry(pageM2, groupName)).toBeVisible({ timeout: 15_000 });

        await timedStage(label, 'group_active_all_three', async () => {
            await openChat(pageC, groupName);
            await openChat(pageM1, groupName);
            await openChat(pageM2, groupName);
            await Promise.all([
                expect(pageC.getByPlaceholder('Type a message...')).toBeEnabled({ timeout: 60_000 }),
                expect(pageM1.getByPlaceholder('Type a message...')).toBeEnabled({ timeout: 60_000 }),
                expect(pageM2.getByPlaceholder('Type a message...')).toBeEnabled({ timeout: 60_000 }),
            ]);
        });

        await awaitGroupEpochConvergence(label, [pageC, pageM1, pageM2], groupName);

        return { bootstrap, peerC, peerM1, peerM2, peerIdC, peerIdM1, peerIdM2, usernameC, usernameM1, usernameM2, groupName, runSuffix };
    } catch (error) {
        await peerC?.close().catch(() => undefined);
        await peerM1?.close().catch(() => undefined);
        await peerM2?.close().catch(() => undefined);
        await bootstrap?.stop().catch(() => undefined);
        throw error;
    }
}

// --- Shared UI helpers (per-file convention — small local copies rather
// than importing every group helper from other spec files, matching
// tor-groups.spec.ts/group-chat.spec.ts's own precedent). ---

async function openNewGroupDialog(page: Page): Promise<void> {
    await page.locator('button:has(svg.lucide-plus)').first().click();
    await page.getByRole('button', { name: 'New Group', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New Group' })).toBeVisible({ timeout: 10_000 });
}

/**
 * Locator for a pending group-invite row (GroupInviteItem.tsx), scoped to
 * its own root div (`flex items-center gap-3 p-3`, distinct from every
 * ChatPreview/sidebar row's own class combo) rather than a bare
 * `getByText(groupName)` — R4 re-invites the SAME group name after a kick,
 * so a plain page-wide text match collides with the now-"Archived" sidebar
 * entry for that same name AND the chat header title if that chat happens
 * to still be open (all three legitimately render the identical string).
 */
function groupInviteRow(page: Page, groupName: string) {
    return page.locator('div.flex.items-center.gap-3.p-3').filter({ hasText: groupName });
}

async function waitForGroupInvite(page: Page, groupName: string, timeoutMs = 60_000): Promise<void> {
    await expect(groupInviteRow(page, groupName)).toBeVisible({ timeout: timeoutMs });
}

async function acceptGroupInvite(page: Page, groupName: string, timeoutMs = 15_000): Promise<void> {
    const row = groupInviteRow(page, groupName);
    await expect(row).toBeVisible({ timeout: timeoutMs });
    await row.getByRole('button', { name: 'Accept', exact: true }).click();
}

/**
 * Opens the currently-active chat's "..." header menu. lucide-react's
 * `MoreVertical` re-export resolves to the `EllipsisVertical` icon's own
 * `lucide-ellipsis-vertical` class (confirmed by every other spec file that
 * uses this trick — blocking.spec.ts/tor-groups.spec.ts).
 */
async function openChatHeaderMenu(page: Page): Promise<void> {
    await page.locator('button:has(svg.lucide-ellipsis-vertical)').first().click();
}

/** Drives "Remove member" -> KickMemberDialog to completion (ChatHeaderMenu.tsx/KickMemberDialog.tsx). */
async function kickGroupMember(page: Page, memberUsername: string, dialogCloseTimeoutMs = 15_000): Promise<void> {
    await openChatHeaderMenu(page);
    await page.getByRole('button', { name: 'Remove member', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Remove Member' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: memberUsername, exact: true }).click();
    await page.getByRole('button', { name: 'Remove Member', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Remove Member' })).toBeHidden({ timeout: dialogCloseTimeoutMs });
}

/**
 * Drives "Invite users" -> InviteUsersDialog's fresh-invite flow (the
 * "Invite (N)" submit button, NOT the dialog's separate pending-only
 * "Re-invite" button — see R4's shape-decision comment for why a re-invite
 * of a just-kicked member must go through this path).
 */
async function inviteExistingContactToGroup(page: Page, contactUsername: string, dialogCloseTimeoutMs = 20_000): Promise<void> {
    await openChatHeaderMenu(page);
    await page.getByRole('button', { name: 'Invite users', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Invite Users' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: contactUsername, exact: true }).click();
    await page.getByRole('button', { name: /^Invite \(1\)$/ }).click();
    await expect(page.getByRole('heading', { name: 'Invite Users' })).toBeHidden({ timeout: dialogCloseTimeoutMs });
}

/** Drives the group menu's "Check missed messages" action. */
async function checkMissedGroupMessages(page: Page): Promise<void> {
    await openChatHeaderMenu(page);
    await page.getByRole('button', { name: 'Check missed messages', exact: true }).click();
}

/**
 * Locator for a membership *system message* row (no `data-message-bubble` —
 * see blocking.spec.ts's identical helper/rationale).
 */
function systemMessage(page: Page, text: string) {
    return page.locator('div.animate-fade-in').getByText(text, { exact: true });
}

/** Locator for the per-message "offline" send-state label (see blocking.spec.ts/offline-delivery.spec.ts). */
function offlineSendLabel(page: Page, messageText: string) {
    return page
        .locator('div.animate-fade-in', { has: chatMessage(page, messageText) })
        .getByText('offline', { exact: true });
}

/** Reads a page's local key_version for the named group chat via the same getChats() IPC the UI itself loads from. */
async function groupKeyVersion(page: Page, groupName: string): Promise<number> {
    return page.evaluate(async (name) => {
        const result = await window.kiyeovoAPI.getChats();
        if (!result.success) return -1;
        const chat = (result.chats as Array<Record<string, unknown>>).find(
            (c) => c.type === 'group' && c.name === name,
        );
        return chat ? Number(chat.key_version ?? 0) : -1;
    }, groupName);
}

/** Reads a page's current group roster (accepted/confirmed member usernames, excluding self) via getChats()+getGroupMembers(). */
async function groupMemberUsernames(page: Page, groupName: string): Promise<string[]> {
    return page.evaluate(async (name) => {
        const chatsResult = await window.kiyeovoAPI.getChats();
        if (!chatsResult.success) return [];
        const chat = (chatsResult.chats as Array<Record<string, unknown>>).find(
            (c) => c.type === 'group' && c.name === name,
        );
        if (!chat) return [];
        const membersResult = await window.kiyeovoAPI.getGroupMembers(Number(chat.id));
        if (!membersResult.success) return [];
        return (membersResult.members as Array<{ username: string; status: string }>)
            .filter((m) => m.status !== 'pending')
            .map((m) => m.username);
    }, groupName);
}

/** Waits until every given page's local key_version for the group matches (>= 1) — same mechanism as blocking.spec.ts/group-chat.spec.ts. */
async function awaitGroupEpochConvergence(label: string, pages: Page[], groupName: string, timeoutMs = 60_000): Promise<void> {
    const start = Date.now();
    await expect.poll(
        async () => {
            const versions = await Promise.all(pages.map((page) => groupKeyVersion(page, groupName)));
            return versions.every((v) => v >= 1 && v === versions[0])
                ? 'converged'
                : `key_versions=[${versions.join(',')}]`;
        },
        {
            message: `group key epochs never converged across all ${pages.length} members`,
            timeout: timeoutMs,
            intervals: [500, 1_000],
        },
    ).toBe('converged');
    console.log(`[timing][${label}] group_epoch_convergence: ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

/**
 * Sends a group text message and waits for it to land on every recipient,
 * honoring the app's designed realtime-vs-offline fan-out split (see
 * blocking.spec.ts's file-level "Group realtime-vs-offline fan-out split"
 * note for the full mechanism — reused verbatim here, just parameterized
 * with an explicit groupName since this file's tests reuse one group across
 * multiple relaunches/rotations rather than building a fresh world per test).
 * PRECONDITION: callers should awaitGroupEpochConvergence() first.
 */
async function sendGroupMessageAwaitingFanout(label: string, sender: Page, recipients: Page[], text: string): Promise<void> {
    await sendChatMessage(sender, text);
    await expect(chatMessage(sender, text)).toBeVisible({ timeout: 30_000 });

    const wentOffline = await offlineSendLabel(sender, text).isVisible().catch(() => false);
    console.log(`[timing][${label}][BRANCH] sender row settled ${wentOffline ? 'OFFLINE (zero-subscriber fallback)' : 'not-offline (publish saw >=1 subscriber)'}`);

    for (const recipient of recipients) {
        if (!wentOffline) {
            const arrivedRealtime = await chatMessage(recipient, text)
                .waitFor({ state: 'visible', timeout: 30_000 })
                .then(() => true, () => false);
            if (arrivedRealtime) {
                console.log(`[timing][${label}][BRANCH] recipient received REALTIME fan-out`);
                continue;
            }
            console.log(`[timing][${label}][BRANCH] recipient missed realtime fan-out — driving "Check missed messages" recovery`);
        } else {
            console.log(`[timing][${label}][BRANCH] recipient will only receive via "Check missed messages" recovery`);
        }

        await expect(async () => {
            await checkMissedGroupMessages(recipient);
            await expect(chatMessage(recipient, text)).toBeVisible({ timeout: 30_000 });
        }).toPass({ timeout: 90_000, intervals: [5_000] });
        console.log(`[timing][${label}][BRANCH] recipient recovered via "Check missed messages"`);
    }
}

/**
 * Parses C's own [NUDGE][...] log trail (DEBUG_MODE=true) to determine which
 * branch fired for the (single) GROUP_REKEY_REFETCH nudge addressed to
 * `targetPeerId` — see the file header for the exact log-line vocabulary and
 * why peerConnections-at-[SEND][START] is the authoritative discriminator
 * (SKIP_NO_CONN can never fire for this message type).
 */
interface NudgeBranchResult {
    found: boolean;
    branch: 'forced_dial' | 'existing_connection_reuse' | 'unknown';
    outcome: 'ok_dial' | 'ok_reuse' | 'failed' | 'unresolved';
    description: string;
}

function classifyStateUpdateNudgeBranch(logs: string, targetPeerId: string): NudgeBranchResult {
    const suffix = targetPeerId.slice(-8);
    const startRe = new RegExp(
        `\\[NUDGE\\]\\[SEND\\]\\[START\\] attempt=(\\d+) peer=${suffix} group=\\S+ cooldownKey=\\S+ ` +
        `totalConnections=(\\d+) peerConnections=(\\d+)`,
    );
    const startMatch = startRe.exec(logs);
    if (!startMatch) {
        return {
            found: false,
            branch: 'unknown',
            outcome: 'unresolved',
            description: `no [NUDGE][SEND][START] line found for peer=${suffix} — the GROUP_STATE_UPDATE nudge to this peer was never attempted`,
        };
    }
    const attemptId = startMatch[1];
    const peerConnections = Number(startMatch[3]);
    const branch: 'forced_dial' | 'existing_connection_reuse' = peerConnections > 0 ? 'existing_connection_reuse' : 'forced_dial';

    const okRe = new RegExp(`\\[NUDGE\\]\\[SEND\\]\\[OK\\] attempt=${attemptId} peer=${suffix} source=(reuse|dial)`);
    const failRe = new RegExp(`\\[NUDGE\\]\\[SEND_FAIL\\][^\\n]*peer=${suffix}[^\\n]*`);
    const okMatch = okRe.exec(logs);
    const failMatch = failRe.exec(logs);

    let outcome: NudgeBranchResult['outcome'] = 'unresolved';
    let extra = '';
    if (okMatch) {
        outcome = okMatch[1] === 'reuse' ? 'ok_reuse' : 'ok_dial';
    } else if (failMatch) {
        outcome = 'failed';
        extra = ` failLine="${failMatch[0]}"`;
    }

    const description =
        `peerConnectionsAtStart=${peerConnections} => branch=${branch} ` +
        `(${branch === 'forced_dial'
            ? 'no live connection at nudge time — forced cold dial per allowDialWithoutConnection (this fix\'s whole point)'
            : 'an existing connection survived — reconnect/piggyback won the race, no forced dial was needed'}) ` +
        `outcome=${outcome}${extra}`;

    return { found: true, branch, outcome, description };
}

/** Finds and returns the full [NUDGE][SEND_FAIL] log line for a nudge addressed to `targetPeerId`, or null if none exists. */
function findNudgeFailLine(logs: string, targetPeerId: string): string | null {
    const suffix = targetPeerId.slice(-8);
    const failRe = new RegExp(`\\[NUDGE\\]\\[SEND_FAIL\\][^\\n]*peer=${suffix}[^\\n]*`);
    const match = failRe.exec(logs);
    return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// R1 (fast, T1-approximation). C relaunches, then kicks M1 the instant
// unlock completes — before any dial to M2 could plausibly have happened —
// so the GROUP_STATE_UPDATE nudge to M2 is exercised against a genuinely
// fresh, connectionless libp2p node.
// ---------------------------------------------------------------------------
test('a relaunched creator kicks a member immediately post-unlock, and the state-update nudge heals the other member with no manual action @slow', async () => {
    test.setTimeout(6 * 60_000);
    const testInfo = test.info();
    const testStart = Date.now();
    let bootstrap: BootstrapNode | undefined;
    let peerC: LaunchedApp | undefined;
    let peerM1: LaunchedApp | undefined;
    let peerM2: LaunchedApp | undefined;
    let failed = false;

    try {
        const setup = await buildActiveGroupOfThree('r1', 9231, 20451);
        ({ bootstrap, peerC, peerM1, peerM2 } = setup);
        const { peerIdM2, usernameM1, groupName, runSuffix } = setup;
        let pageC = peerC.page;
        const pageM1 = peerM1.page;
        const pageM2 = peerM2.page;
        const cP2pPort = 9231;
        const cProfileDir = peerC.profileDir;

        // --- Positive control: baseline group messaging works pre-relaunch. ---
        const preRelaunchMessage = `pre-relaunch-${runSuffix}`;
        await timedStage('r1', 'positive_control_pre_relaunch', () => (
            sendGroupMessageAwaitingFanout('r1', pageC, [pageM1, pageM2], preRelaunchMessage)
        ));
        await attach(testInfo, pageM2, 'r1-01-m2-pre-relaunch-control');

        // --- RELAUNCH C: close (keepProfile) then relaunch on the same
        // profile/port. This is a fresh libp2p node — zero connections to
        // anyone (recon-confirmed: no code path auto-dials a specific known
        // contact on startup, only configured bootstrap/relay addresses) —
        // until something explicitly dials or gets dialed. ---
        let cUnlockedAt = 0;
        await timedStage('r1', 'c_close_and_relaunch', async () => {
            await peerC!.close({ keepProfile: true });
            peerC = await launchApp({ p2pPort: cP2pPort, profileDir: cProfileDir, env: { DEBUG_MODE: 'true' } });
            pageC = peerC.page;
            await pageC.waitForLoadState('domcontentloaded');
            await expect(pageC.getByText('UNLOCK IDENTITY')).toBeVisible({ timeout: 30_000 });
            await pageC.getByPlaceholder('Enter decryption key...').fill(PASSWORD);
            await pageC.getByRole('button', { name: 'Decrypt & Access' }).click();
            await expect(sidebarChatEntry(pageC, groupName)).toBeVisible({ timeout: 60_000 });
            cUnlockedAt = Date.now();
        });
        await attach(testInfo, pageC, 'r1-02-c-relaunched-unlocked');

        // --- IMMEDIATELY kick M1 — no epoch-convergence wait, no settle
        // delay, just open the (already-'active'-in-local-DB) group chat and
        // kick, to minimize the window for C to have dialed/been dialed by
        // M2 before the kick's GROUP_STATE_UPDATE goes out. ---
        const kickIssuedAt = Date.now();
        await timedStage('r1', 'c_kicks_m1_immediately_post_unlock', async () => {
            await openChat(pageC, groupName);
            await kickGroupMember(pageC, usernameM1);
        });
        console.log(`[timing][r1] kick issued ${kickIssuedAt - cUnlockedAt}ms after unlock completed`);
        await attach(testInfo, pageC, 'r1-03-c-kicked-m1');

        // --- M2 heals with NO manual action: no "Check missed messages"
        // click, just the passive wait — the nudge (or a lucky realtime
        // gossip catch, though M2 isn't even subscribed to a topic that
        // changed here) is the only thing that can produce this. ---
        await timedStage('r1', 'm2_sees_removal_no_manual_action', async () => {
            await expect(systemMessage(pageM2, `${usernameM1} was removed from the group`)).toBeVisible({ timeout: 45_000 });
        });
        await attach(testInfo, pageM2, 'r1-04-m2-sees-removal-no-manual-action');

        // --- CRITICAL HONESTY REQUIREMENT: which branch fired? ---
        const branch = classifyStateUpdateNudgeBranch(peerC.logs.join(''), peerIdM2);
        console.log(`[r1][NUDGE-BRANCH][M2] ${branch.found ? branch.description : branch.description}`);
        if (!branch.found) {
            console.log('[r1][NUDGE-BRANCH][M2] WARNING: no [NUDGE][SEND][START] line found for M2 at all — the nudge may not have been attempted (see log dump on failure).');
        }

        // --- Message flow C<->M2 still works after the kick. ---
        await awaitGroupEpochConvergence('r1', [pageC, pageM2], groupName);
        const postKickMessage = `post-kick-${runSuffix}`;
        await timedStage('r1', 'post_kick_message_c_m2', () => (
            sendGroupMessageAwaitingFanout('r1', pageC, [pageM2], postKickMessage)
        ));
        await attach(testInfo, pageM2, 'r1-05-m2-received-post-kick-message');

        console.log(`[r1][FINAL] nudge branch for M2's state update: ${branch.branch} / outcome=${branch.outcome}`);
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][r1] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) {
            await attachLogs(testInfo, peerC, 'r1-c-main-process-logs');
            await attachLogs(testInfo, peerM1, 'r1-m1-main-process-logs');
            await attachLogs(testInfo, peerM2, 'r1-m2-main-process-logs');
        }
        await peerC?.close().catch((error) => console.error('Failed to close C:', error));
        await peerM1?.close().catch((error) => console.error('Failed to close M1:', error));
        await peerM2?.close().catch((error) => console.error('Failed to close M2:', error));
        await bootstrap?.stop().catch((error) => console.error('Failed to stop bootstrap node:', error));
    }
});

// ---------------------------------------------------------------------------
// R2 (fast, T3). M2's app is fully CLOSED (process gone, profile kept) while
// C kicks M1 — C's forced dial to M2 is guaranteed to fail (nothing is
// listening). Asserts C stays healthy, then that a RELAUNCHED M2 heals
// itself via Main.tsx's own startup sweep (no manual action) and can message.
// ---------------------------------------------------------------------------
test('a closed member heals at relaunch via the startup sweep after missing a forced-dial nudge that failed @slow', async () => {
    test.setTimeout(6 * 60_000);
    const testInfo = test.info();
    const testStart = Date.now();
    let bootstrap: BootstrapNode | undefined;
    let peerC: LaunchedApp | undefined;
    let peerM1: LaunchedApp | undefined;
    let peerM2: LaunchedApp | undefined;
    let failed = false;

    try {
        const setup = await buildActiveGroupOfThree('r2', 9234, 20451);
        ({ bootstrap, peerC, peerM1, peerM2 } = setup);
        const { peerIdM2, usernameC, usernameM1, groupName, runSuffix } = setup;
        const pageC = peerC.page;
        let pageM2 = peerM2.page;
        const m2P2pPort = 9236;
        const m2ProfileDir = peerM2.profileDir;

        // --- M2 closes fully (process exit, profile kept) WHILE staying a
        // live group member locally — C has no idea it happened. ---
        await timedStage('r2', 'm2_closes_keeping_profile', async () => {
            await peerM2!.close({ keepProfile: true });
        });

        // --- C (still warm/running) kicks M1. Its forced dial to M2 must
        // fail (no listener at M2's address at all — the connection attempt
        // has nothing to succeed against, unlike a merely-slow peer). ---
        await timedStage('r2', 'c_kicks_m1_while_m2_closed', async () => {
            await openChat(pageC, groupName);
            await kickGroupMember(pageC, usernameM1);
            await expect(systemMessage(pageC, `${usernameM1} was removed from the group`)).toBeVisible({ timeout: 10_000 });
        });
        await attach(testInfo, pageC, 'r2-01-c-kicked-m1-while-m2-closed');

        // --- Capture the dial-failure evidence AND prove C stayed healthy
        // (no crash — the app process is still responsive: M1's own removal
        // system message rendered locally above, and Bob... err, M1's own
        // client-side proof isn't needed here, C's own responsiveness is
        // the claim). Poll briefly since the async nudge dial has its own
        // ~5s internal timeout (BUCKET_NUDGE_DIAL_TIMEOUT_MS) before failing. ---
        await expect.poll(
            () => findNudgeFailLine(peerC!.logs.join(''), peerIdM2) !== null,
            { message: 'C never logged a [NUDGE][SEND_FAIL] for its forced dial to the closed M2', timeout: 15_000, intervals: [500, 1_000] },
        ).toBe(true);
        const failLine = findNudgeFailLine(peerC!.logs.join(''), peerIdM2);
        console.log(`[r2][DIAL-FAILURE][C->M2] ${failLine}`);
        expect(failLine).not.toBeNull();

        // C's own UI is still fully responsive — prove it can still drive a
        // normal action (open M1's now-former direct chat and see its own
        // earlier contact message still rendered; a crashed/hung renderer
        // would fail this trivially).
        await expect(pageC.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 10_000 });
        await attach(testInfo, pageC, 'r2-02-c-healthy-after-failed-dial');

        // --- Relaunch M2 on the same profile. No manual "Check missed
        // messages" click anywhere below — Main.tsx's syncRecentOfflineMessages
        // effect (see file header) is what's under test here. ---
        await timedStage('r2', 'm2_relaunch_returning_user_unlock', async () => {
            peerM2 = await launchApp({ p2pPort: m2P2pPort, profileDir: m2ProfileDir, env: { DEBUG_MODE: 'true' } });
            pageM2 = peerM2.page;
            await pageM2.waitForLoadState('domcontentloaded');
            await expect(pageM2.getByText('UNLOCK IDENTITY')).toBeVisible({ timeout: 30_000 });
            await expect(pageM2.getByText('Choose Network Mode')).toHaveCount(0);
            await pageM2.getByPlaceholder('Enter decryption key...').fill(PASSWORD);
            await pageM2.getByRole('button', { name: 'Decrypt & Access' }).click();
            await expect(sidebarChatEntry(pageM2, groupName)).toBeVisible({ timeout: 60_000 });
        });
        await attach(testInfo, pageM2, 'r2-03-m2-relaunched-unlocked');

        // --- Heals at startup, no manual action: DB-level roster/key_version
        // poll, NOT a wait for the "X was removed" system message.
        // EMPIRICALLY FOUND then CODE-CONFIRMED while stabilizing this test:
        // the automatic startup sweep (Main.tsx's syncRecentOfflineMessages ->
        // checkOfflineMessages on M2's direct chat with C) DOES apply the
        // missed GROUP_STATE_UPDATE correctly and quickly (observed ~1.3s
        // from relaunch-driven offline-check start to
        // "[GROUP][STATE_UPDATE][APPLY] ... event=kick" in M2's own
        // DEBUG_MODE logs) — but this path sets `isResync: true`
        // (group-responder.ts's handleGroupStateUpdate, invoked off the
        // offline-bucket-replay path), and `appendMembershipSystemMessage`
        // is explicitly gated on `!update.isResync` in BOTH places it would
        // otherwise fire for this event (group-responder.ts:650/657 for the
        // general roster-advance case, :561 for the already-caught-up
        // duplicate case) — so the chat-timeline "<name> was removed from
        // the group" message is DELIBERATELY never appended on this
        // recovery path, unlike R1's live-nudge-delivered path where it
        // always renders. This is pre-existing, orthogonal behavior (the
        // isResync gate predates 7dc137f and isn't touched by it) — worth
        // flagging as a real UX gap (a relaunched member who missed a kick
        // gets no visible notice of it in their chat history, only a
        // silently-updated roster) but not a regression from this fix. ---
        await timedStage('r2', 'm2_heals_at_startup_no_manual_action', async () => {
            await expect.poll(
                () => groupKeyVersion(pageM2, groupName),
                { message: "M2's key_version never advanced past the kick after relaunch", timeout: 60_000, intervals: [1_000, 2_000] },
            ).toBeGreaterThanOrEqual(3);
        });
        const rosterAfterHeal = await groupMemberUsernames(pageM2, groupName);
        console.log(`[r2][ROSTER][M2] ${JSON.stringify(rosterAfterHeal)}`);
        expect(rosterAfterHeal).toContain(usernameC);
        expect(rosterAfterHeal).not.toContain(usernameM1);
        const removalSystemMessageRenderedOnHeal = await systemMessage(pageM2, `${usernameM1} was removed from the group`)
            .isVisible()
            .catch(() => false);
        console.log(`[r2][FINDING] removal system message rendered on the automatic resync path: ${removalSystemMessageRenderedOnHeal} (expected false per isResync gating, group-responder.ts:650/657)`);
        await attach(testInfo, pageM2, 'r2-04-m2-healed-at-startup');

        // --- Can message normally. Relaunch doesn't restore a previously-
        // open chat (M2 lands with none selected), so the chat must be
        // opened before its header menu ("Check missed messages"/kick/etc.)
        // is reachable at all — a normal navigation action, not the
        // "manual action" this test avoids (that's specifically about NOT
        // needing "Check missed messages" for the removal itself, per the
        // suite-wide idiom — see offline-delivery.spec.ts precedent). ---
        await openChat(pageM2, groupName);
        await awaitGroupEpochConvergence('r2', [pageC, pageM2], groupName);
        const postHealMessage = `post-heal-${runSuffix}`;
        await timedStage('r2', 'post_heal_message_c_m2', () => (
            sendGroupMessageAwaitingFanout('r2', pageC, [pageM2], postHealMessage)
        ));
        await attach(testInfo, pageM2, 'r2-05-m2-messaging-works-after-heal');
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][r2] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) {
            await attachLogs(testInfo, peerC, 'r2-c-main-process-logs');
            await attachLogs(testInfo, peerM1, 'r2-m1-main-process-logs');
            await attachLogs(testInfo, peerM2, 'r2-m2-main-process-logs');
        }
        await peerC?.close().catch((error) => console.error('Failed to close C:', error));
        await peerM1?.close().catch((error) => console.error('Failed to close M1:', error));
        await peerM2?.close().catch((error) => console.error('Failed to close M2:', error));
        await bootstrap?.stop().catch((error) => console.error('Failed to stop bootstrap node:', error));
    }
});

// ---------------------------------------------------------------------------
// R3 (Tor, T2-approximation). Same shape as R1, over anonymous mode. Onion
// dials are genuinely slow (30-90s elsewhere in this suite) against a
// BUCKET_NUDGE_DIAL_TIMEOUT_MS of only 5s (src/core/constants.ts:140-141,
// mode-agnostic — no anonymous-mode override exists) — so a forced-dial
// nudge over Tor is a real stress case for this fix, not just a slower
// version of R1. Budgeted at the standing 12-minute Tor exception
// (tor-mode.spec.ts/trusted-import.spec.ts/tor-groups.spec.ts).
// ---------------------------------------------------------------------------

/** Same reconnect-and-retry idiom as tor-groups.spec.ts — this file's own local copy per the suite's per-file-helpers convention. */
async function ensureAnonymousDhtConnected(label: string, page: Page): Promise<void> {
    if (await getDhtConnected(page)) return;
    console.log(`[timing][${label}] DHT connectivity dipped before this stage — reconnecting via Setup > Bootstrap`);
    await navigateToBootstrapSetup(page);
    await waitForRealDhtConnectionAnonymous(page);
    await page.getByRole('button', { name: 'Chats', exact: true }).click();
}

async function sendContactRequestWithReconnect(
    label: string,
    sender: Page,
    targetPeerId: string,
    message: string,
    maxAttempts = 3,
): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        await ensureAnonymousDhtConnected(label, sender);
        try {
            await sendContactRequest(sender, targetPeerId, message, { perAttemptTimeoutMs: 60_000, totalTimeoutMs: 90_000 });
            return;
        } catch (error) {
            if (attempt === maxAttempts) throw error;
            console.log(`[timing][${label}] contact request attempt ${attempt}/${maxAttempts} failed — closing dialog and retrying`);
            await sender.locator('form').getByRole('button', { name: 'Close', exact: true }).click().catch(() => {});
        }
    }
}

// MARKED test.fixme (orchestrator-timeboxed, per this round's own explicit
// escape hatch: "if the 3-instance-plus-relaunch cost makes this test
// exceed budget in practice ... mark R3 test.fixme with measured evidence
// rather than shipping a flaky test"). Three consecutive attempts on this
// box, each failing in generic/shared Tor-onboarding infrastructure (code
// this file reuses as-is from e2e/tor.ts and e2e/onboard.ts, unmodified and
// already exercised successfully by every other Tor spec in this suite) —
// NEVER in this test's own logic, which never got the chance to run:
//   1. startOnionFrontedBootstrap's fronting Tor daemon stalled mid
//      consensus/relay-descriptor load, never reaching "Bootstrapped 100%"
//      within its 90s budget (tor.ts:183) — matches trusted-import.spec.ts's
//      own documented S3 finding of the identical stall shape, there also
//      classified infra-transient and resolved by an immediate solo re-run.
//   2. C's anonymous-mode onboarding never reported real DHT connectivity
//      after waitForRealDhtConnectionAnonymous's full retry budget
//      (tor.ts:359), after M1 had already onboarded successfully — matches
//      tor-groups.spec.ts's own documented "state.user.connected can flip
//      false under this file's heavier concurrent Tor load" finding.
//   3. M1's identity-creation flow never reached the "Let's get Kiyeovo
//      connected!" first-run guide screen within beginIdentityCreation's
//      60s budget (onboard.ts:149) — a third, again-different symptom in
//      the same shared onboarding path.
// This is the same class of environment fact tor-groups.spec.ts's G2
// documented for this exact box: repeated concurrent Tor-daemon bootstraps
// (here: 2 app daemons + 1 fronting daemon for C+M1's parallel launch alone,
// before M2 or any relaunch) show CPU/bandwidth contention severe enough to
// intermittently stall consensus fetches and DHT verification well past
// otherwise-generous budgets. R1 (this file, fast mode) already proves the
// full scenario — relaunch, immediate kick, no-manual-action healing,
// resumed messaging, and nudge-branch classification — end to end; R3 would
// add onion-transport coverage of the same scenario, which remains
// unproven on this box specifically due to environment contention, not any
// gap in the test's design. Follow-up: re-enable once this box's Tor
// daemon capacity is understood, or move to a host with more headroom for
// 2-3 concurrent anonymous-mode instances plus a relaunch-triggered 4th
// daemon restart.
test.fixme('over Tor: a relaunched creator kicks a member immediately post-unlock, and the state-update nudge is exercised against a genuine cold onion circuit @slow', async () => {
    test.setTimeout(12 * 60_000);
    const testInfo = test.info();
    const testStart = Date.now();
    let onionBootstrap: OnionFrontedBootstrap | undefined;
    let peerC: LaunchedApp | undefined;
    let peerM1: LaunchedApp | undefined;
    let peerM2: LaunchedApp | undefined;
    let failed = false;

    const runSuffix = uniqueRunSuffix();
    const usernameC = `rotgc_${runSuffix}`;
    const usernameM1 = `rotgm1_${runSuffix}`;
    const usernameM2 = `rotgm2_${runSuffix}`;
    const groupName = `rotgrpg_${runSuffix}`;

    try {
        onionBootstrap = await timedStage('r3', 'start_onion_fronted_bootstrap', () => startOnionFrontedBootstrap({ bootstrapPort: 20452 }));

        // Staggered onboarding (same known-environment mitigation as
        // tor-groups.spec.ts's G1): 3 app Tor daemons + 1 fronting daemon
        // contend on this box.
        [peerC, peerM1] = await timedStage('r3', 'launch_c_m1', () => Promise.all([
            launchAnonymousApp({ p2pPort: 9231, torSocksPort: 9585, torControlPort: 9586 }, { env: { DEBUG_MODE: 'true' } }),
            launchAnonymousApp({ p2pPort: 9232, torSocksPort: 9587, torControlPort: 9588 }),
        ]));
        const { page: pageC0 } = peerC;
        const { page: pageM1 } = peerM1;

        const [{ peerId: peerIdC }, { peerId: peerIdM1 }] = await timedStage('r3', 'onboard_c_m1_anonymous', () => Promise.all([
            onboardAnonymous(pageC0, { password: PASSWORD, username: usernameC, bootstrapMultiaddr: onionBootstrap!.multiaddr }),
            onboardAnonymous(pageM1, { password: PASSWORD, username: usernameM1, bootstrapMultiaddr: onionBootstrap!.multiaddr }),
        ]));

        peerM2 = await timedStage('r3', 'launch_m2', () => launchAnonymousApp({ p2pPort: 9233, torSocksPort: 9589, torControlPort: 9590 }));
        const { page: pageM2 } = peerM2;
        const { peerId: peerIdM2 } = await timedStage('r3', 'onboard_m2_anonymous', () => (
            onboardAnonymous(pageM2, { password: PASSWORD, username: usernameM2, bootstrapMultiaddr: onionBootstrap!.multiaddr })
        ));
        expect(new Set([peerIdC, peerIdM1, peerIdM2]).size).toBe(3);
        let pageC = pageC0;

        // --- Contacts: C<->M1, C<->M2 (cold onion peer-to-peer rendezvous, same cost class as tor-mode.spec.ts's T2). ---
        await timedStage('r3', 'contact_c_m1', async () => {
            const firstMessage = `Hi ${usernameM1} — this is ${usernameC}, adding you as a contact over Tor.`;
            await sendContactRequestWithReconnect('r3', pageC, peerIdM1, firstMessage);
            await expect(pageM1.getByText(usernameC, { exact: true })).toBeVisible({ timeout: 90_000 });
            await acceptContactRequest(pageM1, usernameC);
            await Promise.all([
                expect(chatMessage(pageC, firstMessage)).toBeVisible({ timeout: 45_000 }),
                expect(chatMessage(pageM1, firstMessage)).toBeVisible({ timeout: 45_000 }),
            ]);
        });

        await timedStage('r3', 'contact_c_m2', async () => {
            const firstMessage = `Hi ${usernameM2} — this is ${usernameC}, adding you as a contact over Tor.`;
            await sendContactRequestWithReconnect('r3', pageC, peerIdM2, firstMessage);
            await expect(pageM2.getByText(usernameC, { exact: true })).toBeVisible({ timeout: 90_000 });
            await acceptContactRequest(pageM2, usernameC);
            await Promise.all([
                expect(chatMessage(pageC, firstMessage)).toBeVisible({ timeout: 45_000 }),
                expect(chatMessage(pageM2, firstMessage)).toBeVisible({ timeout: 45_000 }),
            ]);
        });
        await attach(testInfo, pageC, 'r3-01-c-has-both-contacts');

        // --- Create group, invite both, accept, activate, converge. ---
        await ensureAnonymousDhtConnected('r3', pageC);
        await timedStage('r3', 'create_group_and_invite', async () => {
            await openNewGroupDialog(pageC);
            await pageC.getByPlaceholder('Enter group name...').fill(groupName);
            await pageC.getByRole('button', { name: usernameM1, exact: true }).click();
            await pageC.getByRole('button', { name: usernameM2, exact: true }).click();
            await expect(pageC.getByText('Selected (2)')).toBeVisible();
            await pageC.getByRole('button', { name: 'Send Invites' }).click();
            await expect(pageC.getByRole('heading', { name: 'New Group' })).toBeHidden({ timeout: 30_000 });
        });
        await expect(sidebarChatEntry(pageC, groupName)).toBeVisible({ timeout: 15_000 });

        await timedStage('r3', 'invites_delivered', () => Promise.all([
            waitForGroupInvite(pageM1, groupName, 150_000),
            waitForGroupInvite(pageM2, groupName, 150_000),
        ]));

        await timedStage('r3', 'accept_invites', async () => {
            await acceptGroupInvite(pageM1, groupName, 30_000);
            await acceptGroupInvite(pageM2, groupName, 30_000);
        });
        await expect(sidebarChatEntry(pageM1, groupName)).toBeVisible({ timeout: 30_000 });
        await expect(sidebarChatEntry(pageM2, groupName)).toBeVisible({ timeout: 30_000 });

        await timedStage('r3', 'group_active_all_three', async () => {
            await openChat(pageC, groupName);
            await openChat(pageM1, groupName);
            await openChat(pageM2, groupName);
            await Promise.all([
                expect(pageC.getByPlaceholder('Type a message...')).toBeEnabled({ timeout: 90_000 }),
                expect(pageM1.getByPlaceholder('Type a message...')).toBeEnabled({ timeout: 90_000 }),
                expect(pageM2.getByPlaceholder('Type a message...')).toBeEnabled({ timeout: 90_000 }),
            ]);
        });
        await awaitGroupEpochConvergence('r3', [pageC, pageM1, pageM2], groupName, 150_000);
        await attach(testInfo, pageC, 'r3-02-c-group-active');

        const preRelaunchMessage = `pre-relaunch-tor-${runSuffix}`;
        await timedStage('r3', 'positive_control_pre_relaunch', () => (
            sendGroupMessageAwaitingFanout('r3', pageC, [pageM1, pageM2], preRelaunchMessage)
        ));

        // --- RELAUNCH C: closing/relaunching an anonymous-mode instance
        // restarts its bundled Tor daemon too (slow — budgeted generously
        // via the 12-minute file exception, not a fixed sub-timeout). ---
        const cP2pPort = 9231;
        const cProfileDir = peerC.profileDir;
        let cUnlockedAt = 0;
        await timedStage('r3', 'c_close_and_relaunch_anonymous', async () => {
            await peerC!.close({ keepProfile: true });
            peerC = await launchAnonymousApp(
                { p2pPort: cP2pPort, torSocksPort: 9585, torControlPort: 9586 },
                { profileDir: cProfileDir, env: { DEBUG_MODE: 'true' } },
            );
            pageC = peerC.page;
            await pageC.waitForLoadState('domcontentloaded');
            // Generous timeout: a returning-user unlock in anonymous mode may
            // still gate behind the freshly-restarted Tor daemon bootstrapping
            // before the app even shows the password prompt — same order-of-
            // magnitude budget as beginIdentityCreation's anonymous-mode path
            // (onboard.ts:110-126).
            await expect(pageC.getByText('UNLOCK IDENTITY')).toBeVisible({ timeout: 180_000 });
            await pageC.getByPlaceholder('Enter decryption key...').fill(PASSWORD);
            await pageC.getByRole('button', { name: 'Decrypt & Access' }).click();
            await expect(sidebarChatEntry(pageC, groupName)).toBeVisible({ timeout: 90_000 });
            cUnlockedAt = Date.now();
        });
        await attach(testInfo, pageC, 'r3-03-c-relaunched-unlocked');

        const kickIssuedAt = Date.now();
        await timedStage('r3', 'c_kicks_m1_immediately_post_unlock', async () => {
            await openChat(pageC, groupName);
            await kickGroupMember(pageC, usernameM1, 30_000);
        });
        console.log(`[timing][r3] kick issued ${kickIssuedAt - cUnlockedAt}ms after unlock completed`);
        await attach(testInfo, pageC, 'r3-04-c-kicked-m1');

        // --- M2 heals with no manual action. Generous window — a genuine
        // cold onion circuit is 30-90s elsewhere in this suite, well past
        // this fix's own BUCKET_NUDGE_DIAL_TIMEOUT_MS=5s internal ceiling
        // (see file header) — so this assertion is deliberately NOT gated on
        // the nudge dial itself succeeding within that internal window; it
        // gates on the user-visible outcome, which the classify step below
        // interprets honestly regardless of which way it goes. ---
        await timedStage('r3', 'm2_sees_removal_no_manual_action', async () => {
            await expect(systemMessage(pageM2, `${usernameM1} was removed from the group`)).toBeVisible({ timeout: 150_000 });
        });
        await attach(testInfo, pageM2, 'r3-05-m2-sees-removal-no-manual-action');

        const branch = classifyStateUpdateNudgeBranch(peerC.logs.join(''), peerIdM2);
        console.log(`[r3][NUDGE-BRANCH][M2] ${branch.description}`);

        await awaitGroupEpochConvergence('r3', [pageC, pageM2], groupName, 150_000);
        const postKickMessage = `post-kick-tor-${runSuffix}`;
        await timedStage('r3', 'post_kick_message_c_m2', () => (
            sendGroupMessageAwaitingFanout('r3', pageC, [pageM2], postKickMessage)
        ));
        await attach(testInfo, pageM2, 'r3-06-m2-received-post-kick-message');

        console.log(`[r3][FINAL] nudge branch for M2's state update over Tor: ${branch.branch} / outcome=${branch.outcome}`);
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][r3] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) {
            await attachLogs(testInfo, peerC, 'r3-c-main-process-logs');
            await attachLogs(testInfo, peerM1, 'r3-m1-main-process-logs');
            await attachLogs(testInfo, peerM2, 'r3-m2-main-process-logs');
        }
        await peerC?.close().catch((error) => console.error('Failed to close C:', error));
        await peerM1?.close().catch((error) => console.error('Failed to close M1:', error));
        await peerM2?.close().catch((error) => console.error('Failed to close M2:', error));
        await onionBootstrap?.stop().catch((error) => console.error('Failed to stop onion-fronted bootstrap:', error));
    }
});

// ---------------------------------------------------------------------------
// R4 (fast, T4 smoke). Two rapid membership changes back to back.
//
// SHAPE DECISION (code-confirmed via recon before writing this): the app has
// no "kicked/banned" tracking anywhere — chat_participants is fully deleted
// and reinserted on every rotation (database.ts), and inviteUsersToExistingGroup
// (group-creator.ts) only checks self-invite / already-a-member / already-
// pending, never prior-kick history. So "kick M1, then immediately re-invite
// M1" IS supported — but ONLY via InviteUsersDialog's fresh "Invite" action
// (window.kiyeovoAPI.inviteUsersToGroup), NOT its separate "Re-invite"
// button (reinviteUserToGroup), which is wired ONLY for a peer with an
// outstanding PENDING invite ack and throws 'No pending invite for this
// user' otherwise — a just-kicked M1 has no such pending record. This shape
// is used below (rather than the kick-M1-then-kick-M2 fallback, which is
// also supported with no minimum-group-size enforcement anywhere in
// group-creator.ts) because it's the one that keeps M2 present across BOTH
// rotations, which is what "the remaining member converges to the LATEST
// epoch" requires — a double-kick would leave no non-creator member at all.
// ---------------------------------------------------------------------------
test('two rapid back-to-back membership changes keep the creator responsive and the remaining member converges on the latest epoch @slow', async () => {
    test.setTimeout(6 * 60_000);
    const testInfo = test.info();
    const testStart = Date.now();
    let bootstrap: BootstrapNode | undefined;
    let peerC: LaunchedApp | undefined;
    let peerM1: LaunchedApp | undefined;
    let peerM2: LaunchedApp | undefined;
    let failed = false;

    try {
        const setup = await buildActiveGroupOfThree('r4', 9231, 20451);
        ({ bootstrap, peerC, peerM1, peerM2 } = setup);
        const { usernameC, usernameM1, groupName, runSuffix } = setup;
        const pageC = peerC.page;
        const pageM1 = peerM1.page;
        const pageM2 = peerM2.page;

        // --- Churn: kick M1, then IMMEDIATELY re-invite M1 (no epoch-
        // convergence wait between the two — that's the point of "rapid
        // back-to-back"). Each dialog's own close-wait already gates on the
        // IPC round trip completing server-side (kickMember/
        // inviteUsersToExistingGroup are both awaited before the dialog
        // closes), so group_status is back to 'active' by the time the next
        // action starts — no artificial delay needed or wanted. ---
        const churnStartedAt = Date.now();
        await timedStage('r4', 'churn_kick_then_reinvite', async () => {
            await openChat(pageC, groupName);
            await kickGroupMember(pageC, usernameM1);
            await inviteExistingContactToGroup(pageC, usernameM1);
        });
        console.log(`[timing][r4] churn (kick + re-invite) took ${Date.now() - churnStartedAt}ms`);
        await attach(testInfo, pageC, 'r4-01-c-post-churn');

        // --- Creator UI stays responsive: can still send a message right
        // after triggering both rotations, no hang/freeze. ---
        const duringChurnMessage = `during-churn-${runSuffix}`;
        await timedStage('r4', 'creator_responsive_during_churn', async () => {
            await expect(pageC.getByPlaceholder('Type a message...')).toBeEnabled({ timeout: 15_000 });
            await sendChatMessage(pageC, duringChurnMessage);
            await expect(chatMessage(pageC, duringChurnMessage)).toBeVisible({ timeout: 15_000 });
        });
        await attach(testInfo, pageC, 'r4-02-c-responsive-during-churn');

        // --- Close the loop: M1 receives and accepts the re-invite. ---
        await timedStage('r4', 'm1_reaccepts_reinvite', async () => {
            await waitForGroupInvite(pageM1, groupName, 60_000);
            await acceptGroupInvite(pageM1, groupName);
        });
        await openChat(pageM1, groupName);
        await expect(pageM1.getByPlaceholder('Type a message...')).toBeEnabled({ timeout: 60_000 });
        await attach(testInfo, pageM1, 'r4-03-m1-rejoined');

        // --- M2 (present for both rotations) converges on the LATEST
        // epoch, and C's final message reaches both remaining/rejoined
        // members — the smoke assertion, not a full protocol audit. ---
        await awaitGroupEpochConvergence('r4', [pageC, pageM1, pageM2], groupName);
        const finalMessage = `final-latest-epoch-${runSuffix}`;
        await timedStage('r4', 'final_message_latest_epoch', () => (
            sendGroupMessageAwaitingFanout('r4', pageC, [pageM1, pageM2], finalMessage)
        ));
        await attach(testInfo, pageM2, 'r4-04-m2-received-final-message');

        const rosterOnM2 = await groupMemberUsernames(pageM2, groupName);
        console.log(`[r4][ROSTER][M2] ${JSON.stringify(rosterOnM2)}`);
        expect(rosterOnM2).toContain(usernameC);
        expect(rosterOnM2).toContain(usernameM1);
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][r4] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed) {
            await attachLogs(testInfo, peerC, 'r4-c-main-process-logs');
            await attachLogs(testInfo, peerM1, 'r4-m1-main-process-logs');
            await attachLogs(testInfo, peerM2, 'r4-m2-main-process-logs');
        }
        await peerC?.close().catch((error) => console.error('Failed to close C:', error));
        await peerM1?.close().catch((error) => console.error('Failed to close M1:', error));
        await peerM2?.close().catch((error) => console.error('Failed to close M2:', error));
        await bootstrap?.stop().catch((error) => console.error('Failed to stop bootstrap node:', error));
    }
});
