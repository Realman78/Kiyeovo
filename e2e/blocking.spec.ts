import { test, expect, type Page } from '@playwright/test';
import {
    setupThreePeerWorld,
    type ThreePeerWorld,
    chatMessage,
    sidebarChatEntry,
    openChat,
    attach,
    attachLogs,
} from './world';
import { sendContactRequest, sendChatMessage, timedStage } from './onboard';

// Round 4 of e2e/test-roadmap.md: blocking + group member removal, built on
// the three-peer world (e2e/world.ts) — Alice, Bob, Charlie, with Alice<->Bob
// and Alice<->Charlie as direct contacts (Bob and Charlie deliberately never
// become contacts of each other) plus a group containing all three.
//
// --- Recon findings that shaped this spec (doc-confirmed vs code-confirmed
// labeled explicitly; see the final report for the full trail) ---
//
// Kiyeovo_desktop_technical_documentation.md's coverage of blocking is thin —
// it lists "blocked peers" under the access-policy security model (section
// 13) and documents call-level blocking semantics (connection-gater-adjacent
// section ~410/446-447: blocking a direct-call peer ends the call and closes
// libp2p connections; group-call control/pair signals from/to a blocked peer
// are dropped before any renderer notification). It says nothing about what
// blocking does to plain 1:1/group TEXT messaging or to contact requests, so
// that part of this file-level comment is entirely CODE-CONFIRMED by reading
// src/core directly:
//
// - src/core/network/connection-gater.ts denies ALL libp2p connections
//   to/from a blocked peer at the transport layer: denyDialPeer (outbound),
//   denyOutboundConnection, and denyInboundEncryptedConnection all return
//   true for a peer in the blocked_peers table. blockUser's IPC handler
//   (src/electron/ipc-handlers.ts) also calls
//   MessageHandler.teardownBlockedPeer(), which best-effort-closes any
//   *existing* connection to that peer immediately, clears the direct
//   session/pending key exchange, and ends any active direct call — so a
//   block takes effect immediately, not just for future connection attempts.
// - Defense in depth on top of the transport-level deny: every inbound
//   direct-protocol stream handler in message-handler.ts (chat, bucket-nudge,
//   call-signal) independently re-checks database.isBlocked(remoteId) and
//   silently returns/drops if true.
// - Crucially, this is NOT one-sided: database.ts's
//   getOfflineReadBucketInfo/getOfflineReadBucketInfoForChats — the queries
//   that decide which peers' offline DHT buckets get polled for missed
//   messages — filter out blocked peers at the SQL level
//   ("cp.peer_id NOT IN (SELECT peer_id FROM blocked_peers ...)"). So a
//   blocked sender's message doesn't just fail to arrive live: even the
//   *offline fallback* the recipient would otherwise use to catch up never
//   looks at that peer's bucket while the block is in effect. The message is
//   not deleted anywhere (durably stored in the sender's write bucket, same
//   as any genuine offline send) — it is just never fetched.
// - From the BLOCKED SENDER's own point of view there is no distinct
//   "you have been blocked" signal anywhere in the send path: a failed dial
//   to a peer who blocked you and a dial to a peer who is genuinely offline
//   hit the exact same code path (sendDirectApplicationMessage's dial
//   catch -> shouldFallbackOfflineSend -> storeDirectApplicationMessageOffline),
//   producing the same `messageSentStatus: 'offline'` outcome and the same
//   "offline" label under the bubble (MessageRow.tsx) that
//   offline-delivery.spec.ts asserts for a genuinely-offline peer. This
//   appears to be by design (a peer who blocked you shouldn't be able to
//   confirm it), not an oversight.
// - Contact requests: key-exchange.ts's authorizeContactRequest() checks
//   isBlocked() BEFORE anything else (before the existing-chat check and
//   before consulting the global contact_mode setting) and returns null —
//   "silent rejection - no error message" per its own comment — for a NEW
//   key-exchange attempt from an already-blocked peer. This is distinct from
//   a live "Reject & Block" of a CURRENTLY PENDING request (InvitationManager
//   -> rejectContactRequest IPC), which DOES send an explicit
//   key_exchange_rejected wire message back for that one attempt, before
//   adding the peer to blocked_peers. It's only a peer's SUBSEQUENT attempt,
//   made while already blocked, that is silently dropped with no reply at
//   all — the connection-gater deny means the requester's own dial typically
//   never even completes the encrypted handshake, so authorizeContactRequest
//   is defense-in-depth for the rare case of a connection surviving under the
//   gater's radar.
// - Group member removal ("kick") IS a real UI feature (ChatHeaderMenu.tsx's
//   "Remove member" item, gated on isCurrentUserGroupCreator &&
//   kickableMembersCount > 0; KickMemberDialog.tsx's "Remove Member" flow) —
//   this reshapes nothing in scenario C, the roadmap's assumption holds.
//   group-creator.ts's kickMember(): rotates the group key (so the removed
//   member's old key can no longer decrypt future group traffic even if a
//   stray gossip message reached them), broadcasts a GROUP_STATE_UPDATE with
//   the post-kick roster to every REMAINING member (group-responder.ts's
//   handleGroupStateUpdate persists that shrunk roster into that member's own
//   chat_participants via database.updateGroupParticipants — so
//   group-messaging.ts's inbound-message roster check
//   ("sender_not_participant") will independently reject anything purporting
//   to be from the removed member even without the key rotation), and sends a
//   dedicated GROUP_KICK message directly to the removed member.
//   group-responder.ts's handleGroupKick applies local 'removed' group_status
//   (chat is KEPT, not deleted — database.ts's applyLocalGroupRemovedState),
//   and both sides get a system-message chat entry via
//   appendMembershipSystemMessage: "You were removed from the group" for the
//   removed member, "<username> was removed from the group" for everyone
//   else. ChatInput.tsx's groupStatusMessages.ts maps group_status 'removed'
//   to composer placeholder copy "You were removed from this group." and
//   disables the composer client-side (groupBlockedReason is truthy whenever
//   groupStatus !== 'active').
// - Note: system messages (message_type 'system') do NOT carry
//   MessageRow.tsx's `data-message-bubble` attribute (that attribute is only
//   on the non-system branch) — so the membership system-message assertions
//   below intentionally use a plain getByText, not this file's
//   [data-message-bubble]-scoped chatMessage() helper.
// - World-fixture adaptation: the roadmap's scenario A wording assumes Bob
//   and Charlie can exchange a direct "M_control" message as the
//   ordering-bound proxy for the negative assertion. world.ts's fixture
//   deliberately keeps Bob and Charlie as non-contacts (see its file-level
//   comment), so there is no direct channel between them to use for that.
//   This spec substitutes the shared GROUP chat as the ordering-bound
//   channel for scenario A instead (Charlie sends a group message; once Bob
//   sees it rendered, enough real-DHT/relay processing time has passed that
//   an already-in-flight blocked message would also have arrived by then).
//   Scenario C reuses the same three-peer world and needs no such
//   substitution (Alice and Bob are already direct contacts, used as the
//   ordering-bound channel for scenario C's negative assertion) — scenario
//   B likewise uses the already-established Alice<->Bob direct channel.
// - Group realtime-vs-offline fan-out split (code-confirmed, and the root
//   cause of this file's one originally-marginal wait): a group text message
//   rides gossipsub on a topic derived from the group's CURRENT key epoch
//   (group-messaging.ts's deriveTopic(groupId, keyBytes)). publish() throws
//   if the sender's pubsub sees zero remote subscribers on that topic
//   ("PublishError.NoPeersSubscribedToTopic"), and publishWithRetry retries
//   exactly once, GROUP_PUBLISH_RETRY_DELAY_MS=750ms later — after which the
//   send DELIBERATELY settles to offline-only delivery (DHT group bucket,
//   sender row marked 'offline' with the same label direct offline sends
//   get). Recipients then only pick it up via the periodic offline check
//   (OFFLINE_MESSAGE_CHECK_INTERVAL = 5 MINUTES) or the group menu's manual
//   "Check missed messages" action (doc line ~341: "the manual
//   missed-message action remains a fallback") — there is NO sender-side
//   nudge on this path (nudgeGroupRefetch only fires for a manual re-send
//   with rekeyRetryHint, i.e. MessagesContainer's retry of a
//   'group_rekeying'-failed row). Every join AND kick rotates the group key
//   (group-creator.ts), so the FIRST send after any membership change
//   happens seconds after its topic came into existence, before the other
//   members' subscription announcements have necessarily reached the
//   sender's pubsub — diagnosed live: a failing run's main-process log
//   (DEBUG_MODE=true) showed exactly publish attempt=1
//   NoPeersSubscribedToTopic -> retry 750ms -> attempt=2 fail -> "Falling
//   back to offline delivery" ~3-6s after the fixture's activation gate
//   (which waits on composer-enabled, a DB-status signal that says nothing
//   about gossip mesh formation — Bob's composer has been enabled since key
//   v1, while the pre-kick send rides key v2 created by Charlie's join
//   rotation). A bare 30s toBeVisible on the recipient can therefore NEVER
//   succeed on that (designed!) fallback path — it wasn't a marginal
//   timeout, it was the wrong wait for that branch, and no timeout was
//   inflated to fix it. sendGroupMessageAwaitingFanout() below handles both
//   designed branches honestly: it reads the app's own verdict off the
//   sender's row (the 'offline' label — rendered atomically with the bubble,
//   since a transport-owned group row is only persisted/evented AFTER the
//   publish outcome is known, per group-messaging.ts's
//   sendApplicationMessage ordering) and either does the plain realtime wait
//   or drives the recipient's designed "Check missed messages" recovery.
//
// Given three real onboardings + two contact exchanges + one group
// create/invite/accept/activate round trip per world (group-chat.spec.ts
// calls this "the slowest suite in e2e/"), this file splits its three
// scenarios across three tests, each building and tearing down its own
// world, to keep every test safely under the 6-minute cap and to keep one
// scenario's failure from losing evidence for the others.

test.setTimeout(6 * 60_000);

// p2pPorts 9151-9153 and local-bootstrap port 19505 — see e2e/config.ts's
// "PORT RANGES" table (this file's row was added there). All three tests in
// this file reuse the same values safely: fullyParallel:false means tests
// within one file never run concurrently with each other, only with tests in
// OTHER files (which own disjoint ranges) — same pattern as
// file-transfer.spec.ts's two sequential setupThreePeerWorld() calls.
const BASE_PORT = 9151;
const LOCAL_BOOTSTRAP_PORT = 19505;

test('direct blocking stops messages both ways and lifts on unblock @slow', async () => {
    const testInfo = test.info();
    const testStart = Date.now();
    let world: ThreePeerWorld | undefined;
    let failed = false;

    try {
        world = await setupThreePeerWorld({ basePort: BASE_PORT, localBootstrapPort: LOCAL_BOOTSTRAP_PORT, label: 'block-direct' });
        const { pageAlice, pageBob, pageCharlie, usernameAlice, usernameBob, groupName, runSuffix } = world;

        await openChat(pageAlice, usernameBob);
        await openChat(pageBob, usernameAlice);

        // --- Positive control: baseline direct messaging works right before the block ---
        const preBlockMessage = `pre-block-${runSuffix}`;
        await timedStage('block-direct', 'positive_control_pre_block', async () => {
            await sendChatMessage(pageAlice, preBlockMessage);
            await expect(chatMessage(pageBob, preBlockMessage)).toBeVisible({ timeout: 30_000 });
        });
        await attach(testInfo, pageBob, 'bob-pre-block-control-received');

        // --- Bob blocks Alice via the chat header's "Block user" affordance ---
        await timedStage('block-direct', 'bob_blocks_alice', async () => {
            await toggleBlockUser(pageBob);
            // ChatInput.tsx disables Bob's own composer to a blocked peer and
            // swaps the placeholder — the clearest same-page confirmation the
            // block took effect, independent of anything happening on Alice's side.
            await expect(pageBob.getByPlaceholder('Cannot send messages to blocked users')).toBeVisible({ timeout: 10_000 });
            await expect(pageBob.getByPlaceholder('Cannot send messages to blocked users')).toBeDisabled();
        });
        await attach(testInfo, pageBob, 'bob-blocked-alice-composer-disabled');

        // --- Alice (unaware) sends into the now-blocked chat ---
        const blockedMessage = `blocked-msg-${runSuffix}`;
        await timedStage('block-direct', 'alice_sends_while_blocked', async () => {
            await sendChatMessage(pageAlice, blockedMessage);
            // Doc/code-confirmed: from the sender's side, being blocked is
            // indistinguishable from the recipient being offline — the same
            // "offline" send-state label offline-delivery.spec.ts asserts for
            // a genuinely offline peer, not a distinct "blocked" indicator.
            // Generous timeout: protocol-dialer.ts's direct-then-relay dial
            // fallback sequence (up to ~10s direct + ~10s relay, raced against
            // sendMessage's own 10s MESSAGE_TIMEOUT) plus the real DHT PUT for
            // the offline store can occasionally run past 30s against the
            // real public infra (observed once during authoring).
            await expect(offlineSendLabel(pageAlice, blockedMessage)).toBeVisible({ timeout: 60_000 });
        });
        await attach(testInfo, pageAlice, 'alice-blocked-message-shows-offline');

        // --- Ordering-bound negative assertion: Charlie (unblocked) sends
        // into the shared GROUP chat (the only channel he shares with Bob —
        // see the file-level comment on the world-fixture adaptation); once
        // Bob sees it, an already-in-flight blocked message would also have
        // long since surfaced if it were ever going to. ---
        const controlMessage = `charlie-control-${runSuffix}`;
        await timedStage('block-direct', 'ordering_bound_control_via_group', async () => {
            await openChat(pageCharlie, groupName);
            await openChat(pageBob, groupName);
            // Fan-out helper rather than a bare wait: if this control send
            // hits the designed zero-subscriber offline fallback, Bob still
            // receives it (via the designed recovery) and the ordering bound
            // holds — delivery through EITHER designed path proves enough
            // wall-clock passed with functioning infra for the blocked
            // message to have surfaced if it were ever going to.
            await sendGroupMessageAwaitingFanout('block-direct', pageCharlie, [pageBob], controlMessage);
        });

        await timedStage('block-direct', 'assert_blocked_message_never_arrived', async () => {
            await openChat(pageBob, usernameAlice);
            await expect(chatMessage(pageBob, blockedMessage)).toHaveCount(0);
        });
        await attach(testInfo, pageBob, 'bob-never-received-blocked-message');

        // --- Bob unblocks Alice; assert the composer reverts and a FRESH
        // message now flows normally, completing the lifecycle and proving
        // blocking (not something else) was the cause. ---
        await timedStage('block-direct', 'bob_unblocks_alice', async () => {
            await toggleBlockUser(pageBob);
            await expect(pageBob.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 10_000 });
            await expect(pageBob.getByPlaceholder('Type a message...')).toBeEnabled();
        });

        const afterUnblockMessage = `after-unblock-${runSuffix}`;
        await timedStage('block-direct', 'messaging_resumes_after_unblock', async () => {
            await sendChatMessage(pageAlice, afterUnblockMessage);
            await expect(chatMessage(pageBob, afterUnblockMessage)).toBeVisible({ timeout: 30_000 });
        });
        await attach(testInfo, pageBob, 'bob-received-message-after-unblock');
        await attach(testInfo, pageAlice, 'alice-final-after-unblock');
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][block-direct] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed && world) {
            await attachLogs(testInfo, world.peerAlice, 'alice-main-process-logs');
            await attachLogs(testInfo, world.peerBob, 'bob-main-process-logs');
            await attachLogs(testInfo, world.peerCharlie, 'charlie-main-process-logs');
        }
        await world?.teardown();
    }
});

test("a blocked peer's contact re-request is silently dropped @slow", async () => {
    const testInfo = test.info();
    const testStart = Date.now();
    let world: ThreePeerWorld | undefined;
    let failed = false;

    try {
        world = await setupThreePeerWorld({ basePort: BASE_PORT, localBootstrapPort: LOCAL_BOOTSTRAP_PORT, label: 'block-request' });
        const { pageBob, pageCharlie, pageAlice, usernameAlice, usernameBob, usernameCharlie, peerIdBob, runSuffix } = world;

        // Bob and Charlie are deliberately non-contacts in this fixture (see
        // world.ts) — a real fit for "brand new contact request" without
        // needing a fourth peer.
        const firstRequestMessage = `charlie-first-request-${runSuffix}`;
        await timedStage('block-request', 'charlie_first_contact_request', async () => {
            await sendContactRequest(pageCharlie, peerIdBob, firstRequestMessage);
            await expect(pageBob.getByText(usernameCharlie, { exact: true })).toBeVisible({ timeout: 20_000 });
        });
        await attach(testInfo, pageBob, 'bob-sees-charlies-first-request');

        // --- Bob rejects AND blocks it via the pending request's "Reject & Block" ---
        await timedStage('block-request', 'bob_rejects_and_blocks', async () => {
            await pageBob.getByText(usernameCharlie, { exact: true }).first().click();
            await pageBob.getByRole('button', { name: 'Reject & Block', exact: true }).click();
            // The durable signal (not the ephemeral toast, which use-toast.tsx
            // auto-dismisses on a timer and can race under parallel-worker
            // CPU contention): the pending request disappears from Bob's list.
            await expect(pageBob.getByText(usernameCharlie, { exact: true })).toHaveCount(0);
        });
        await attach(testInfo, pageBob, 'bob-rejected-and-blocked-charlie');

        // --- Charlie (unaware) retries with a brand new request ---
        const secondRequestMessage = `charlie-second-request-${runSuffix}`;
        await timedStage('block-request', 'charlie_retries_while_blocked', async () => {
            await openNewConversationDialog(pageCharlie);
            await pageCharlie.getByPlaceholder('Enter peer ID or username...').fill(peerIdBob);
            await pageCharlie.getByPlaceholder('Compose an inital greeting...').fill(secondRequestMessage);
            await pageCharlie.getByRole('button', { name: 'Send' }).click();
            // Silently dropped means Charlie's own attempt does NOT complete
            // like a normal request either (a normal accepted/pending flow
            // closes this dialog) — bounded wait, not a naked sleep.
            await expect(pageCharlie.getByRole('heading', { name: 'New Conversation' })).toBeVisible({ timeout: 20_000 });
        });
        await attach(testInfo, pageCharlie, 'charlie-second-request-did-not-succeed');
        // Dialog.tsx renders both a footer "Close" button (inside the dialog's
        // <form>) AND a decorative top-right "X" close icon with the same
        // sr-only "Close" accessible name — scope to the form to avoid the
        // strict-mode ambiguity between the two.
        await pageCharlie.locator('form').getByRole('button', { name: 'Close', exact: true }).click();

        // --- Ordering-bound negative assertion: Alice (an established direct
        // contact of Bob's) sends a fresh message; once it renders, Charlie's
        // second attempt would also have surfaced on Bob's side by now if it
        // were ever going to. ---
        const controlMessage = `alice-control-${runSuffix}`;
        await timedStage('block-request', 'ordering_bound_control_via_alice', async () => {
            await openChat(pageAlice, usernameBob);
            await openChat(pageBob, usernameAlice);
            await sendChatMessage(pageAlice, controlMessage);
            await expect(chatMessage(pageBob, controlMessage)).toBeVisible({ timeout: 30_000 });
        });

        await timedStage('block-request', 'assert_second_request_never_surfaced', async () => {
            await expect(pageBob.getByText(usernameCharlie, { exact: true })).toHaveCount(0);
        });
        await attach(testInfo, pageBob, 'bob-second-request-never-surfaced');
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][block-request] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed && world) {
            await attachLogs(testInfo, world.peerAlice, 'alice-main-process-logs');
            await attachLogs(testInfo, world.peerBob, 'bob-main-process-logs');
            await attachLogs(testInfo, world.peerCharlie, 'charlie-main-process-logs');
        }
        await world?.teardown();
    }
});

test('the group creator can remove a member; removal cuts off group messaging both ways @slow', async () => {
    const testInfo = test.info();
    const testStart = Date.now();
    let world: ThreePeerWorld | undefined;
    let failed = false;

    try {
        world = await setupThreePeerWorld({ basePort: BASE_PORT, localBootstrapPort: LOCAL_BOOTSTRAP_PORT, label: 'block-group' });
        const { pageAlice, pageBob, pageCharlie, usernameCharlie, groupName, runSuffix } = world;

        await openChat(pageAlice, groupName);
        await openChat(pageBob, groupName);
        await openChat(pageCharlie, groupName);

        // --- Positive control: baseline group messaging works right before
        // the removal. This is the FIRST send on the key-v2 topic (created
        // seconds earlier by Charlie's join rotation), i.e. exactly the
        // marginal-mesh window described in the file-level fan-out note —
        // the helper handles the designed offline fallback if it hits. ---
        const preKickMessage = `pre-kick-${runSuffix}`;
        await timedStage('block-group', 'positive_control_pre_kick', async () => {
            await sendGroupMessageAwaitingFanout('block-group', pageAlice, [pageBob, pageCharlie], preKickMessage);
        });
        await attach(testInfo, pageCharlie, 'charlie-pre-kick-control-received');

        // --- Alice (creator) removes Charlie via the group header's "Remove member" ---
        await timedStage('block-group', 'alice_removes_charlie', async () => {
            await kickGroupMember(pageAlice, usernameCharlie);
            await expect(systemMessage(pageAlice, `${usernameCharlie} was removed from the group`)).toBeVisible({ timeout: 10_000 });
        });
        await attach(testInfo, pageAlice, 'alice-removed-charlie');

        // --- Both remaining side (Bob) and the removed member (Charlie) get
        // told, via different copy, per group-responder.ts's
        // appendMembershipSystemMessage ---
        await timedStage('block-group', 'bob_and_charlie_notified', async () => {
            await expect(systemMessage(pageBob, `${usernameCharlie} was removed from the group`)).toBeVisible({ timeout: 30_000 });
            await expect(systemMessage(pageCharlie, 'You were removed from the group')).toBeVisible({ timeout: 30_000 });
        });
        await attach(testInfo, pageBob, 'bob-sees-charlie-removed-system-message');
        await attach(testInfo, pageCharlie, 'charlie-sees-own-removal-system-message');

        // --- Charlie's own UI: composer disabled with the designed copy, and
        // the chat is KEPT (not deleted) in a 'removed' state, not disappeared ---
        await timedStage('block-group', 'charlie_composer_disabled', async () => {
            await expect(pageCharlie.getByPlaceholder('You were removed from this group.')).toBeVisible({ timeout: 10_000 });
            await expect(pageCharlie.getByPlaceholder('You were removed from this group.')).toBeDisabled();
            await expect(sidebarChatEntry(pageCharlie, groupName)).toBeVisible();
        });
        await attach(testInfo, pageCharlie, 'charlie-composer-disabled-after-removal');

        // --- New group messages stop reaching the removed member; Bob (still
        // a member) is the positive control proving this isn't just slow
        // delivery. This send is the first on the key-v3 topic (created by
        // the kick rotation moments earlier), so the helper again covers the
        // designed offline fallback. Note the negative assertion on Charlie
        // stays valid through EITHER delivery path: his exclusion is
        // structural, not timing-based — he's off the v3 roster (inbound
        // 'sender_not_participant' enforcement aside, his own app
        // deactivated the group locally and never fetches its bucket) and
        // holds no v3 key to decrypt with. Charlie's own composer being
        // disabled already demonstrates his sends can no longer reach the
        // group. ---
        const afterKickMessage = `after-kick-${runSuffix}`;
        await timedStage('block-group', 'new_messages_skip_removed_member', async () => {
            await sendGroupMessageAwaitingFanout('block-group', pageAlice, [pageBob], afterKickMessage);
            await expect(chatMessage(pageCharlie, afterKickMessage)).toHaveCount(0);
        });
        await attach(testInfo, pageBob, 'bob-received-post-removal-message');
        await attach(testInfo, pageCharlie, 'charlie-did-not-receive-post-removal-message');
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][block-group] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed && world) {
            await attachLogs(testInfo, world.peerAlice, 'alice-main-process-logs');
            await attachLogs(testInfo, world.peerBob, 'bob-main-process-logs');
            await attachLogs(testInfo, world.peerCharlie, 'charlie-main-process-logs');
        }
        await world?.teardown();
    }
});

// --- helpers ---

/**
 * Locator for the small per-message send-state label MessageRow.tsx renders
 * under a bubble once a background offline send settles
 * (`message.messageSentStatus === 'offline'` -> literal text "offline" — see
 * offline-delivery.spec.ts, which established this pattern). Scoped to the
 * row that also contains the given message's own bubble text, so it can't
 * accidentally match a stray "offline" elsewhere in the chat.
 */
function offlineSendLabel(page: Page, messageText: string) {
    return page
        .locator('div.animate-fade-in', { has: chatMessage(page, messageText) })
        .getByText('offline', { exact: true });
}

/**
 * Sends a text message into the group chat currently open on `sender` and
 * waits for it to render on every `recipients` page (each of which must also
 * have the group chat open), honoring the app's DESIGNED realtime-vs-offline
 * fan-out split — see the file-level "Group realtime-vs-offline fan-out
 * split" note for the full mechanism and the live-debugging trail.
 *
 * Branch decision: the sender's own bubble only appears once the send has
 * fully settled (transport-owned group rows are persisted/evented AFTER the
 * publish/offline outcome is known), and the 'offline' label renders in the
 * same React commit as the bubble — so "bubble visible, then read the label
 * once" is a race-free read of the app's own verdict:
 * - no label  -> published online via gossipsub -> plain 30s realtime wait;
 * - 'offline' -> the designed zero-subscribers fallback (message durably in
 *   the group's DHT bucket, no recipient nudge on this path) -> drive each
 *   recipient's designed recovery, the group menu's "Check missed messages"
 *   action, then expect the message. This is the same recovery a real user
 *   is told to use (doc line ~341) — NOT a test-only backdoor.
 *
 * The 30s sender-settle bound covers a slow DHT PUT on the offline-backup
 * write (the row renders only after it); the 30s per-recipient bounds match
 * every other real-infra delivery wait in this suite.
 */
async function sendGroupMessageAwaitingFanout(label: string, sender: Page, recipients: Page[], text: string): Promise<void> {
    await sendChatMessage(sender, text);
    await expect(chatMessage(sender, text)).toBeVisible({ timeout: 30_000 });

    const wentOffline = await offlineSendLabel(sender, text).isVisible().catch(() => false);
    if (!wentOffline) {
        await Promise.all(recipients.map(
            (recipient) => expect(chatMessage(recipient, text)).toBeVisible({ timeout: 30_000 }),
        ));
        return;
    }

    console.log(`[timing][${label}] group send fell back to offline delivery (designed zero-subscriber fallback); driving recipients' "Check missed messages" recovery`);
    for (const recipient of recipients) {
        await checkMissedGroupMessages(recipient);
        await expect(chatMessage(recipient, text)).toBeVisible({ timeout: 30_000 });
    }
}

/**
 * Drives the group menu's "Check missed messages" action
 * (ChatHeaderMenu.tsx 'check-missed' -> ChatHeader.tsx's
 * handleCheckMissedGroupMessages -> checkGroupOfflineMessagesForChat IPC) on
 * the group chat currently open on `page`.
 */
async function checkMissedGroupMessages(page: Page): Promise<void> {
    await openChatHeaderMenu(page);
    await page.getByRole('button', { name: 'Check missed messages', exact: true }).click();
}

/**
 * Locator for a membership *system message* row (MessageRow.tsx's
 * isSystemMessage branch — "You/<username> was removed from the group",
 * "<username> joined the group", etc.). These rows do NOT carry
 * `data-message-bubble` (that attribute is only on the non-system branch —
 * see the file-level comment), so this can't reuse chatMessage(); it's scoped
 * to `div.animate-fade-in` (MessageRow.tsx's per-row wrapper, present on both
 * system and non-system rows) instead of a bare getByText, which would
 * strict-mode-collide with the sidebar's ChatPreview last-message snippet
 * (renders the identical text) and, right after the triggering action, a
 * toast rendering the same or similar copy.
 */
function systemMessage(page: Page, text: string) {
    return page.locator('div.animate-fade-in').getByText(text, { exact: true });
}

/**
 * Opens the currently-active chat's "..." header menu. ChatHeaderMenu.tsx's
 * trigger button has no accessible name of its own (icon-only) — same
 * lucide-icon-class targeting trick world.ts/onboard.ts use elsewhere, keyed
 * on lucide-react's stable `lucide-<kebab-case-name>` class. lucide-react
 * re-exports `MoreVertical` as an alias of its canonical `EllipsisVertical`
 * icon (see node_modules/lucide-react/dist/esm/icons/ellipsis-vertical.js),
 * so the class actually rendered is `lucide-ellipsis-vertical`, not
 * `lucide-more-vertical` — confirmed by reading createLucideIcon's class-name
 * generation (kebab-cased from the icon's registered name, "ellipsis-
 * vertical", not the imported alias). This is the only such trigger in the app.
 */
async function openChatHeaderMenu(page: Page): Promise<void> {
    await page.locator('button:has(svg.lucide-ellipsis-vertical)').first().click();
}

/**
 * Toggles Block/Unblock on the currently-open direct chat via the header
 * menu (ChatHeaderMenu.tsx's single 'toggle-block' item, labeled "Block user"
 * or "Unblock user" depending on current state). The menu closes itself after
 * the click (ChatHeader.tsx's handleToggleBlock calls setDropdownOpen(false)),
 * so callers assert the *effect* (composer placeholder/disabled state)
 * rather than re-opening the menu to check the label.
 */
async function toggleBlockUser(page: Page): Promise<void> {
    await openChatHeaderMenu(page);
    const blockButton = page.getByRole('button', { name: 'Block user', exact: true });
    const unblockButton = page.getByRole('button', { name: 'Unblock user', exact: true });
    if (await blockButton.isVisible().catch(() => false)) {
        await blockButton.click();
    } else {
        await unblockButton.click();
    }
}

/**
 * Opens the "New Conversation" dialog (reimplemented locally rather than
 * imported — onboard.ts's equivalent is private to that module, and
 * group-chat.spec.ts/world.ts already establish the convention of each spec
 * file owning its own small dialog-opening helpers).
 */
async function openNewConversationDialog(page: Page): Promise<void> {
    await page.locator('button:has(svg.lucide-plus)').first().click();
    await page.getByRole('button', { name: 'New Conversation', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New Conversation' })).toBeVisible({ timeout: 10_000 });
}

/**
 * Drives the group header's "Remove member" -> KickMemberDialog flow
 * (ChatHeaderMenu.tsx / KickMemberDialog.tsx) end to end for the given
 * member's username on the currently-open group chat.
 */
async function kickGroupMember(page: Page, memberUsername: string): Promise<void> {
    await openChatHeaderMenu(page);
    await page.getByRole('button', { name: 'Remove member', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Remove Member' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: memberUsername, exact: true }).click();
    await page.getByRole('button', { name: 'Remove Member', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Remove Member' })).toBeHidden({ timeout: 15_000 });
}
