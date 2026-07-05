# Plan: group-chat e2e test (not started — awaiting go-ahead)

## Goal
A `e2e/group-chat.spec.ts` proving three real app instances can form a group and that every member's messages reach every other member.

## Prerequisites
- The infra migration (real bootstrap/relay/STUN as e2e defaults) is merged into the `e2e/` helpers — the group test builds on those updated helpers.
- No app-source changes expected; if the group UI lacks scriptable hooks or has bugs, flag rather than patch.

## Shape
One Sonnet subagent writes and stabilizes the test. The test itself launches
three app instances (Alice, Bob, Charlie) via `launchApp()` with distinct
`p2pPort`s (9101/9102/9103) and isolated temp profiles — same pattern as the
two-peer test, one more instance.

## Steps the test scripts
1. Onboard all three peers (Fast mode, unique per-run usernames, real infra).
2. Recon first: read the group UI source (`src/ui`, group components; git log
   mentions group calls, so groups exist) to map the actual creation flow and
   whether members must be contacts first.
3. Establish required contact relationships (expected: Alice ↔ Bob, Alice ↔ Charlie).
4. Alice creates a group, adds Bob and Charlie.
5. Assert membership propagates: group appears in all three sidebars.
6. Message fan-out assertions, scoped to `[data-message-bubble]`:
   - Alice sends → visible in Bob's and Charlie's group view.
   - Bob (non-creator) sends → visible in Alice's and Charlie's.
   - Charlie sends while his window is on a DIFFERENT chat → the other two
     still receive; Charlie's sidebar shows unread state for the group.
7. Screenshots of all three windows at: group created, each fan-out milestone.
8. Clean close; report what the run leaves on the real DHT.

## Assertion caveats
- Bob↔Charlie are NOT direct contacts — verifies group messaging doesn't
  silently depend on pairwise contact links (likely relay/gossip paths).
- Expect slower runs: three onboardings over the public DHT; keep event-based
  waits, raise per-test timeout as needed (5 min+ is acceptable).

## Explicit non-goals (this iteration)
- Group calls, member removal/blocking, invites-by-username, offline delivery.
- Visual regression (flicker/layout) — functional assertions + milestone
  screenshots only.
