# Removed group member can inject content into the trailing epoch during the boundary-snapshot race

- **Area:** Core / Group messaging (offline delivery, membership enforcement)
- **Severity:** Low–Medium
- **Source:** Security scan — group messaging (malicious-peer / malicious-ex-member threat model)
- **Status:** Open

## Threat model

The client is open source, so a current or **former** group member may run a
modified client. Removal from a group is meant to be a clean cryptographic
cut-off: an ex-member should not be able to read future messages *or* inject new
content into the group after they are kicked.

## Summary

When a member `X` is removed (key rotation epoch `N` → `N+1`), remaining members
keep scanning epoch `N`'s offline buckets during the rotation grace window. The
per-message boundary gate that is supposed to cap `X` at their pre-removal sequence
number is **skipped entirely when the creator-signed boundary snapshot for the epoch
has not yet propagated** from the DHT. During that race window `X` can publish new,
arbitrary, self-signed messages into their own epoch-`N` offline bucket, and
remaining members will accept, decrypt, and persist them as legitimate group
messages from `X` (with a pre-removal timestamp).

## Scope: non-creator readers (the creator is largely protected)

This race primarily affects **non-creator remaining members**. The creator has a
local fail-closed-ish fallback for its own rotations: `snapshotPrevEpochBoundaries`
(`group-creator.ts:1679-1731`) writes explicit `0` boundaries for *all* previous
participants (`:1690-1695`), merges observed seqs, and persists them locally before
publishing the rotated metadata; and `getEpochBoundaryMeta`
(`group-offline-manager.ts:1356-1376`) prefers local `getGroupEpochBoundaries`
(`:1363`) over DHT metadata. So the creator has complete local boundaries immediately
after rotating.

A **non-creator** does not run `snapshotPrevEpochBoundaries` and does not persist
decrypted sender boundaries when it applies the rotation (`handleGroupStateUpdate`
stores the new key / participants / key version but not the successor boundary
snapshot). It therefore depends on fetching and decrypting the successor
`GroupInfoVersioned` metadata from the DHT — and until that arrives, it has no
boundaries for the closed epoch. The exploit window is exactly that gap.

## Root causes (three that combine)

1. **Boundary gate is bypassed when no boundary is available.**
   `group-offline-manager.ts:584`:
   ```ts
   if (senderBoundary !== undefined && msg.seq > senderBoundary) { skip }
   ```
   The gate is skipped when **neither** a local `group_epoch_boundaries` row **nor** a
   decrypted successor `GroupInfoVersioned` snapshot is available (`getEpochBoundaryMeta`
   returns null → `versionMeta` null → `senderBoundary` undefined → the `!== undefined`
   guard short-circuits). The key rotation is delivered fast (RSA `GroupStateUpdate`),
   but for a non-creator the boundary snapshot is fetched from the DHT asynchronously
   afterward, so there is a window with a live new key but no boundary.

2. **The removed sender is still enumerated as scannable.**
   `getEpochSenderPeerIds` (`group-offline-manager.ts:1318-1344`) returns
   `localKnownSenders` (peers the reader already saw in epoch `N` — which includes a
   normally-active `X`) before falling back to current participants. So `X`'s bucket
   is still scanned even though `X` is no longer a participant.

3. **The group-offline DHT validator is context-free.**
   `group-dht-validator.ts` `groupOfflineMessageValidator` binds a write to the
   signing key in the bucket-key path but never checks *current membership*. So a
   removed `X` can still write to their own epoch-`N` bucket
   (`/<groupOffline>/<groupId>/<keyVersion>/<X_pubKey>`).

## Exploit walkthrough

1. `X` is kicked; the group rotates to epoch `N+1`. `X` retains epoch `N`'s group key
   (they legitimately held it) and their own signing key.
2. `X` publishes a new message into their epoch-`N` offline bucket: content encrypted
   under epoch `N`'s group key, signed by `X`, `seq` set beyond their true boundary,
   `timestamp` within `used_until + GROUP_ROTATION_GRACE_WINDOW_MS` (60s;
   `X`-controlled and easily estimated from when they were removed).
3. A **non-creator** remaining member who has applied the `GroupStateUpdate` (new key,
   epoch `N+1`) but whose offline scanner has **not yet fetched/decrypted the successor
   `GroupInfoVersioned` metadata** scans epoch `N` (`evaluateEpochSkipDecision` keeps
   scanning during `within_grace_window` / `missing_used_until`): enumerates `X`,
   **skips** the boundary check (root cause 1, no local or DHT boundary yet), passes the
   timestamp gate (`:577-582`), verifies `X`'s signature against the still-present
   `users.signing_public_key` (`:589`), sees `seq > highestSeenSeq` so it is not deduped
   (`:596`), decrypts with the epoch-`N` key, and persists it as a legitimate group
   message from `X`. (The creator, having local boundaries from
   `snapshotPrevEpochBoundaries`, rejects the same message.)

## Impact

A just-removed member can post arbitrary chosen content into the group after removal,
attributed to themselves with a pre-removal timestamp, visible to remaining members.
Bounded — old epoch only, narrow timing window, self-attributed, cannot reach the new
epoch or read new messages — but it violates the "removal is a clean cut-off"
guarantee.

## Location

- `src/core/group/runtime/group-offline-manager.ts:584` (boundary gate skipped when
  `senderBoundary === undefined`), `:577-582` (timestamp gate), `:1269-1316`
  (`evaluateEpochSkipDecision` — keeps scanning during grace/missing-meta),
  `:1318-1344` (`getEpochSenderPeerIds` still enumerates the ex-member).
- `src/core/group/dht/group-dht-validator.ts` (`groupOfflineMessageValidator` —
  context-free, no current-membership check).

## Suggested fix

When the creator-signed boundary snapshot for a past epoch is unavailable, do **not**
fall through to an unbounded accept. Options:
1. Defer scanning a past epoch's buckets until its boundary snapshot is fetched and
   decrypted (fail-closed rather than fail-open on `senderBoundary === undefined`).
2. Or cap acceptance at the locally-known highest `seq` for `(group, epoch, sender)`
   at the moment of rotation, so new higher-seq messages from that sender in a *closed*
   epoch are rejected until the authoritative boundary confirms them.
3. Consider having the reader stop enumerating a sender who is no longer a participant
   for messages *newly appearing* after removal, distinguishing "backfill of
   already-referenced seqs" from "brand-new seqs."

## Test coverage

Not currently covered. Add group-offline tests for both roles:
- **Creator / local-boundary fallback:** with no DHT metadata available, a removed
  sender's `seq` above the locally-snapshotted boundary is rejected.
- **Non-creator / missing-boundary path:** with neither local `group_epoch_boundaries`
  nor decrypted successor metadata available, a message from a removed sender with `seq`
  beyond the local closed-epoch high-water mark is rejected or deferred (fail-closed).
- With the snapshot present, the existing boundary gate still rejects it.
- A legitimate late backfill (seq ≤ boundary) is still delivered.
