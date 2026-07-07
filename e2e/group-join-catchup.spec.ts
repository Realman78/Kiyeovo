import { test, expect, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './electron';
import { startBootstrapNode, type BootstrapNode } from './bootstrap-node';
import { onboard, sendContactRequest, acceptContactRequest, sendChatMessage, timedStage } from './onboard';
import { chatMessage, sidebarChatEntry, openChat, attach, attachLogs } from './world';
import { BOOTSTRAP_MULTIADDR, RELAY_MULTIADDR, STUN_URL, USE_LOCAL_BOOTSTRAP, uniqueRunSuffix } from './config';

// Regression coverage for 5be97e5 ("Trigger group offline catch-up on join
// completion (GROUP_WELCOME)") — the one scenario its own review flagged as
// having NO existing e2e coverage: a freshly-joined member's join-completion
// path (GROUP_WELCOME, not GROUP_STATE_UPDATE) now schedules the same
// per-chat coalesced group-offline catch-up that the rotation/reconnect/
// resume triggers already fire, closing the up-to-5-minute window a joiner
// used to sit in when a same-epoch message was published while they were
// still converging (group-formation is exactly that window).
//
// --- Epoch mechanics recap (full derivation lives in group-chat.spec.ts's
// file-level comment and its 'group_epoch_convergence' stage) ---
// Every membership change rotates the group key to a new epoch
// (key_version += 1); gossip topics are derived per-epoch
// (group-messaging.ts's deriveTopic), so a member who hasn't yet applied the
// new epoch's key is simply not subscribed to the topic a same-epoch publish
// rides on — the send then silently settles to offline-only DHT delivery,
// which checkGroupOfflineMessages reads back (only epochs <= the reader's
// local key_version — pre-join history stays unreadable by construction,
// untouched by 5be97e5). Before that commit, a freshly-welcomed joiner had no
// trigger of their own and relied on the 5-minute periodic sweep to notice a
// waiting bucket entry; now GROUP_WELCOME's handler (message-handler.ts)
// schedules the exact same catch-up
// (`scheduleGroupStateUpdateCatchup(..., 'group_welcome_applied')`) the
// instant the welcome is genuinely applied (shouldTriggerJoinCompletionCatchup
// skips duplicate welcomes — see group-offline-triggers.ts).
//
// --- Why not setupThreePeerWorld() ---
// That helper drives the group all the way to 'active' with every member's
// key_version converged before returning — exactly the race window this test
// needs to observe would already be closed by the time it handed control
// back. This file builds the scenario by hand instead: Bob joins and
// converges FIRST (a normal, uncontested join, giving a stable 2-member
// group — same helpers/patterns as group-chat.spec.ts), and only then does
// Charlie accept, with Alice's send timed to land as early as scriptably
// possible after Charlie's join lands on her side.
//
// --- The signal Alice sends on ---
// Alice's own composer is blocked (ChatInput.tsx's groupBlockedReason) for
// any group chat whose local group_status isn't 'active' — including her OWN
// chat while she's mid-rotation processing Charlie's acceptance
// (group-creator.ts's sendGroupWelcome transitions her chat to 'rekeying'
// before rotating the key, and back to 'active' only *after* the welcome has
// already been dispatched to Charlie and the state update dispatched to
// Bob). That means the earliest moment Alice's UI would even let her send is
// after her own key_version has bumped to 2 and her group_status has flipped
// back to 'active' — which, by construction, is also after the welcome to
// Charlie was already attempted. Polling her own key_version via getChats()
// (the same technique group-chat.spec.ts's 'group_epoch_convergence' stage
// uses) is therefore both the earliest scriptable signal available to this
// test and a faithful stand-in for "the moment a real user could hit send".
// Because Charlie's own composer-enable requires him to have *received and
// applied* that same welcome (a further network round trip after Alice's
// local rotation completes), whether he wins the race (realtime) or not
// (offline catch-up) is a genuine, run-to-run coin flip — see the
// classification logic below.
//
// --- Budget arithmetic (JOIN_CATCHUP_BUDGET_MS) ---
// From Charlie's GROUP_WELCOME being genuinely applied (his composer
// enabling) to the message appearing in his chat:
//   - scheduleGroupStateUpdateCatchup() has no delay or debounce on this
//     path — it's invoked synchronously in the same message-handler branch
//     that just applied the welcome (right alongside subscribeToGroupTopic),
//     and immediately kicks off runQueuedGroupStateCatchup() (a bare `void`
//     call, no setTimeout).
//   - checkGroupOfflineMessages() then does one coalesced DHT read for this
//     chat, bounded by DHT_OP_TIMEOUT_FAST_MS = 10_000ms per DHT op
//     (group-offline-manager.ts). The real, observed latency of a DHT/relay
//     round trip against this suite's deployed infra is ~1-4s elsewhere
//     (see network-edges.spec.ts's relay/bootstrap timings), so 10s is
//     already a pessimistic per-op ceiling, not a typical duration.
//   - 30s gives roughly 3x that single-op ceiling as headroom without
//     approaching minutes — nowhere near the 5-minute periodic fallback this
//     commit closes the gap on.
const JOIN_CATCHUP_BUDGET_MS = 30_000;

test.setTimeout(6 * 60_000);

const PASSWORD = 'Correct-Horse-Battery-Staple9!';

test('joiner catches up on a same-epoch message published during their convergence window @slow', async () => {
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
    const groupName = `grpjc_${runSuffix}`;

    try {
        // p2pPorts 9161-9163, local-bootstrap port 19506 — see e2e/config.ts's
        // "PORT RANGES" table (this file's own row).
        const bootstrapMultiaddr = USE_LOCAL_BOOTSTRAP
            ? (bootstrap = await startBootstrapNode(19506)).multiaddr
            : BOOTSTRAP_MULTIADDR;

        [peerAlice, peerBob] = await Promise.all([
            launchApp({ p2pPort: 9161 }),
            launchApp({ p2pPort: 9162 }),
        ]);
        // DEBUG_MODE=true only on Charlie: the classification check near the
        // end reads his main-process logs for the join-completion trigger's own
        // '[GROUP-OFFLINE][STATE-CATCHUP][START] ... trigger=group_welcome_applied'
        // line (and the realtime pubsub path's '[GROUP-MSG][IN][APPLY]' line),
        // both gated behind DEBUG_MODE (src/shared/logger.ts's `log()`) — without
        // it those lines are silently dropped even when the code path runs (same
        // rationale as network-edges.spec.ts's autoretry mechanism check).
        peerCharlie = await launchApp({ p2pPort: 9163, env: { DEBUG_MODE: 'true' } });
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
            'join_catchup', 'onboard_all_three', () => Promise.all([
                onboard(pageAlice, { ...onboardOptions, username: usernameAlice }),
                onboard(pageBob, { ...onboardOptions, username: usernameBob }),
                onboard(pageCharlie, { ...onboardOptions, username: usernameCharlie }),
            ]),
        );
        expect(peerIdAlice).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20,}$/);
        expect(peerIdBob).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20,}$/);
        expect(peerIdCharlie).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20,}$/);
        expect(new Set([peerIdAlice, peerIdBob, peerIdCharlie]).size).toBe(3);

        // --- Contact prerequisites: Alice <-> Bob, Alice <-> Charlie. ---
        // (NewGroupDialog only offers Alice's existing contacts as invitees —
        // see group-chat.spec.ts's file-level comment.)
        await timedStage('join_catchup', 'contact_alice_bob', async () => {
            const firstMessage = 'Hi Bob, this is Alice — adding you as a contact.';
            await sendContactRequest(pageAlice, peerIdBob, firstMessage);
            await expect(pageBob.getByText(usernameAlice, { exact: true })).toBeVisible({ timeout: 20_000 });
            await acceptContactRequest(pageBob, usernameAlice);
            await Promise.all([
                expect(chatMessage(pageAlice, firstMessage)).toBeVisible({ timeout: 30_000 }),
                expect(chatMessage(pageBob, firstMessage)).toBeVisible({ timeout: 30_000 }),
            ]);
        });

        await timedStage('join_catchup', 'contact_alice_charlie', async () => {
            const firstMessage = 'Hi Charlie, this is Alice — adding you as a contact.';
            await sendContactRequest(pageAlice, peerIdCharlie, firstMessage);
            await expect(pageCharlie.getByText(usernameAlice, { exact: true })).toBeVisible({ timeout: 20_000 });
            await acceptContactRequest(pageCharlie, usernameAlice);
            await Promise.all([
                expect(chatMessage(pageAlice, firstMessage)).toBeVisible({ timeout: 30_000 }),
                expect(chatMessage(pageCharlie, firstMessage)).toBeVisible({ timeout: 30_000 }),
            ]);
        });

        // --- Alice creates the group, inviting both Bob and Charlie up front —
        // only the ACCEPT order is staggered below (Bob first, Charlie timed). ---
        await timedStage('join_catchup', 'create_group', async () => {
            await openNewGroupDialog(pageAlice);
            await pageAlice.getByPlaceholder('Enter group name...').fill(groupName);
            await pageAlice.getByRole('button', { name: usernameBob, exact: true }).click();
            await pageAlice.getByRole('button', { name: usernameCharlie, exact: true }).click();
            await expect(pageAlice.getByText('Selected (2)')).toBeVisible();
            await pageAlice.getByRole('button', { name: 'Send Invites' }).click();
            await expect(pageAlice.getByRole('heading', { name: 'New Group' })).toBeHidden({ timeout: 20_000 });
        });
        await expect(sidebarChatEntry(pageAlice, groupName)).toBeVisible({ timeout: 15_000 });

        await timedStage('join_catchup', 'invites_delivered', () => Promise.all([
            waitForGroupInvite(pageBob, groupName),
            waitForGroupInvite(pageCharlie, groupName),
        ]));
        await attach(testInfo, pageCharlie, 'charlie-invite-pending-before-join');

        // --- Bob accepts and converges FIRST, giving a stable 2-member group
        // before Charlie's timed join. ---
        await timedStage('join_catchup', 'bob_accepts_and_converges', async () => {
            await acceptGroupInvite(pageBob, groupName);
            await expect(sidebarChatEntry(pageBob, groupName)).toBeVisible({ timeout: 15_000 });
            await openChat(pageAlice, groupName);
            await openChat(pageBob, groupName);
            await expect(pageAlice.getByPlaceholder('Type a message...')).toBeEnabled({ timeout: 60_000 });
            await expect(pageBob.getByPlaceholder('Type a message...')).toBeEnabled({ timeout: 60_000 });
            await expect.poll(
                async () => {
                    const [aliceSnap, bobSnap] = await Promise.all([
                        getGroupSnapshot(pageAlice, groupName),
                        getGroupSnapshot(pageBob, groupName),
                    ]);
                    return `${aliceSnap?.groupStatus}:${aliceSnap?.keyVersion}/${bobSnap?.groupStatus}:${bobSnap?.keyVersion}`;
                },
                {
                    message: "Alice and Bob never converged on key_version=1 after Bob's join",
                    timeout: 60_000,
                    intervals: [500, 1_000],
                },
            ).toBe('active:1/active:1');
        });
        await attach(testInfo, pageAlice, 'alice-bob-group-stable-before-charlie');
        await attach(testInfo, pageBob, 'bob-group-stable-before-charlie');

        // --- The timed scenario: Charlie accepts; Alice sends the instant she
        // observes her own key_version bump to 2 (Charlie's join landing on her
        // side) — see this file's header comment for why that's both the
        // earliest scriptable signal and the moment her own composer unblocks. ---
        const raceMessage = `Alice: mid-join epoch message ${runSuffix}`;
        const acceptClickedAt = Date.now();
        const [, aliceSendTiming] = await timedStage(
            'join_catchup', 'charlie_accept_and_alice_race_send', () => Promise.all([
                acceptGroupInvite(pageCharlie, groupName),
                (async () => {
                    await expect.poll(
                        async () => {
                            const snap = await getGroupSnapshot(pageAlice, groupName);
                            return snap ? `${snap.groupStatus}:${snap.keyVersion}` : 'missing';
                        },
                        {
                            message: "Alice never observed her own key_version bump to 2 (Charlie's join landing)",
                            timeout: 45_000,
                            intervals: [200, 400],
                        },
                    ).toBe('active:2');
                    const bumpDetectedAt = Date.now();
                    await sendChatMessage(pageAlice, raceMessage);
                    return { bumpDetectedAt, sentAt: Date.now() };
                })(),
            ]),
        );
        console.log(
            `[timing][join_catchup] alice observed her own key_version bump ` +
            `${aliceSendTiming.bumpDetectedAt - acceptClickedAt}ms after charlie's accept click; ` +
            `sent ${aliceSendTiming.sentAt - aliceSendTiming.bumpDetectedAt}ms after that`,
        );
        await attach(testInfo, pageAlice, 'alice-sent-during-charlie-convergence-window');

        // --- Charlie's side: open the chat (accepting doesn't auto-navigate —
        // same split as group-chat.spec.ts's 'accept_invites' ->
        // 'group_active_all_three') and record when his composer unblocks —
        // that's the GROUP_WELCOME-genuinely-applied moment 5be97e5's trigger
        // fires on. ---
        await expect(sidebarChatEntry(pageCharlie, groupName)).toBeVisible({ timeout: 15_000 });
        await openChat(pageCharlie, groupName);
        await expect(pageCharlie.getByPlaceholder('Type a message...')).toBeEnabled({ timeout: 60_000 });
        const composerEnabledAt = Date.now();
        console.log(
            `[timing][join_catchup] charlie's composer enabled ${composerEnabledAt - acceptClickedAt}ms after his accept click`,
        );
        await attach(testInfo, pageCharlie, 'charlie-composer-enabled-still-converging');

        // --- The contract: the message shows up within budget of Charlie's
        // join completing, not the old up-to-5-minute periodic wait. ---
        await expect(chatMessage(pageCharlie, raceMessage)).toBeVisible({ timeout: JOIN_CATCHUP_BUDGET_MS });
        const deliveredAt = Date.now();
        const deliveryLatencyMs = deliveredAt - composerEnabledAt;
        console.log(
            `[timing][join_catchup] message visible ${deliveryLatencyMs}ms after charlie's composer enabled ` +
            `(budget ${JOIN_CATCHUP_BUDGET_MS}ms)`,
        );
        expect(deliveryLatencyMs).toBeLessThan(JOIN_CATCHUP_BUDGET_MS);
        await attach(testInfo, pageCharlie, 'charlie-received-message-from-join-window');

        // --- Classification: which path actually delivered it? Direct evidence
        // from Charlie's own main-process logs (DEBUG_MODE=true) — same
        // technique as network-edges.spec.ts's autoretry mechanism check. Give
        // the trigger's own log line a short grace window in case stdout
        // capture lags slightly behind the DOM update above. ---
        await expect.poll(
            () => JOIN_TRIGGER_START_RE.test(peerCharlie!.logs.join('')),
            {
                message: "join-completion catch-up trigger ('group_welcome_applied') never logged its schedule " +
                    "in Charlie's main-process logs — 5be97e5's trigger did not fire",
                timeout: 10_000,
                intervals: [300, 500],
            },
        ).toBe(true);

        const charlieLogs = peerCharlie.logs.join('');
        const classification = classifyDeliveryPath(charlieLogs);
        console.log(
            `[join_catchup][CLASSIFY] triggerFired=${classification.triggerFired} ` +
            `offlinePathDelivered=${classification.offlinePathDelivered} ` +
            `realtimeApplyLogged=${classification.realtimeApplyLogged}`,
        );
        // The trigger firing is the load-bearing assertion — it's the direct
        // evidence that 5be97e5's join-completion code path executed, true on
        // EVERY run regardless of which mechanism happened to win the race.
        expect(classification.triggerFired).toBe(true);
        if (classification.offlinePathDelivered) {
            console.log(
                '[join_catchup][CLASSIFY] CONFIRMED: the join-completion offline catch-up (5be97e5) delivered the message.',
            );
        } else if (classification.realtimeApplyLogged) {
            console.log(
                "[join_catchup][CLASSIFY] Realtime gossip won the race instead (charlie's topic subscription was " +
                'already live by the time Alice published) — the user-facing contract still held (message arrived ' +
                'well within budget) and the trigger above still fired, but this run is not direct evidence of the ' +
                'offline-catchup branch actually delivering content.',
            );
        } else {
            console.log(
                '[join_catchup][CLASSIFY] Neither classification signal was found even though the message arrived ' +
                'within budget and the trigger fired — inconclusive attribution for this run.',
            );
        }
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][join_catchup] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
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

// --- Local helpers: small standalone copies of world.ts's private group
// helpers. world.ts's own file-level comment explains why group-chat.spec.ts
// duplicates rather than imports these — a behavior-neutral refactor of a
// slow, expensive-to-debug real-infra suite is a bigger risk than a few
// duplicated lines; this file follows the same convention. ---

async function openNewGroupDialog(page: Page): Promise<void> {
    await page.locator('button:has(svg.lucide-plus)').first().click();
    await page.getByRole('button', { name: 'New Group', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New Group' })).toBeVisible({ timeout: 10_000 });
}

async function waitForGroupInvite(page: Page, groupName: string): Promise<void> {
    await expect(page.getByText(groupName, { exact: true })).toBeVisible({ timeout: 60_000 });
}

async function acceptGroupInvite(page: Page, groupName: string): Promise<void> {
    await expect(page.getByText(groupName, { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Accept', exact: true }).click();
}

/**
 * Raw key_version/group_status snapshot for the named group chat, read via
 * kiyeovoAPI.getChats() — same technique as group-chat.spec.ts's
 * 'group_epoch_convergence' stage, reused here to detect Alice's own rotation
 * completing (see this file's header comment for why that's the earliest
 * scriptable "Charlie's join landed" signal available).
 */
async function getGroupSnapshot(
    page: Page,
    groupName: string,
): Promise<{ keyVersion: number; groupStatus: string | null } | null> {
    return page.evaluate(async (name) => {
        const result = await window.kiyeovoAPI.getChats();
        if (!result.success) return null;
        const chat = (result.chats as Array<Record<string, unknown>>).find(
            (c) => c.type === 'group' && c.name === name,
        );
        if (!chat) return null;
        return {
            keyVersion: Number(chat.key_version ?? 0),
            groupStatus: (chat.group_status as string | null) ?? null,
        };
    }, groupName);
}

// message-handler.ts's runQueuedGroupStateCatchup logs this exact line when a
// catch-up starts; `trigger=` carries scheduleGroupStateUpdateCatchup's
// `reason` argument, which the GROUP_WELCOME case passes as the literal
// string 'group_welcome_applied' (see this file's header comment).
const JOIN_TRIGGER_START_RE = /\[GROUP-OFFLINE\]\[STATE-CATCHUP\]\[START\][^\n]*trigger=group_welcome_applied/;
const JOIN_TRIGGER_START_CHATID_RE = /\[GROUP-OFFLINE\]\[STATE-CATCHUP\]\[START\] chatId=(\d+)[^\n]*trigger=group_welcome_applied/g;
const JOIN_TRIGGER_DONE_RE = /\[GROUP-OFFLINE\]\[STATE-CATCHUP\]\[DONE\] chatId=(\d+)[^\n]*unread=(\d+)/g;
// group-messaging.ts's handleIncomingPubsubEvent only reaches this line for a
// real inbound group chat message that got decrypted, deduped, and inserted
// via the realtime pubsub path (heartbeats and dropped messages never reach
// it) — a reliable realtime-vs-catchup discriminator for this tightly-scoped
// scenario (the only such message in this test's window is our own race send).
const REALTIME_APPLY_RE = /\[GROUP-MSG\]\[IN\]\[APPLY\]/;

function classifyDeliveryPath(logs: string): {
    triggerFired: boolean;
    offlinePathDelivered: boolean;
    realtimeApplyLogged: boolean;
} {
    const triggerFired = JOIN_TRIGGER_START_RE.test(logs);
    const realtimeApplyLogged = REALTIME_APPLY_RE.test(logs);

    const triggeredChatIds = new Set<string>();
    let match: RegExpExecArray | null;
    JOIN_TRIGGER_START_CHATID_RE.lastIndex = 0;
    while ((match = JOIN_TRIGGER_START_CHATID_RE.exec(logs))) {
        triggeredChatIds.add(match[1]);
    }
    let offlinePathDelivered = false;
    JOIN_TRIGGER_DONE_RE.lastIndex = 0;
    while ((match = JOIN_TRIGGER_DONE_RE.exec(logs))) {
        if (triggeredChatIds.has(match[1]) && Number(match[2]) > 0) {
            offlinePathDelivered = true;
        }
    }
    return { triggerFired, offlinePathDelivered, realtimeApplyLogged };
}
