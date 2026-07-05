# Ticket Implementation Notes — running log for review

One section per ticket: what was done, how it was verified, and any **choices you
need to review**. Written by the orchestration agent; implementation by Codex
(GPT-5.5). Nothing pushed. Suite is run after every ticket with the local
LD_LIBRARY_PATH workaround (Electron system libs missing on this machine).

---

## 0001 — Self-import guard (commit `7de31ff`) ✅

**What:** `importTrustedUser` now rejects a profile whose `peerId` equals the local
peer id, before any DB lookup/write (`"Cannot import your own profile"`). Tests prove
the ordering (DB methods stubbed to throw if touched) for both with/without a
pre-existing local user row.

**Choices:** none — implemented exactly as the ticket specified. Suite 165/165.

## 0002 — Atomic trusted-contact creation (commit `49b3d02`) ✅

**What:** New `ChatDatabase.createTrustedDirectContact(user, chat)` runs the contact
user insert + direct chat + participants in ONE better-sqlite3 `db.transaction`
(auto-rollback). `createChat` itself switched from manual `BEGIN/COMMIT` to
`db.transaction`, fixing the open-transaction-on-failure hazard the ticket noted.
`importTrustedUser` uses the new helper. Failure-injection test: chat insert fails →
no user row remains → immediate retry succeeds.

**Choices to review:**
- The `createChat` transaction fix applies to **all** callers (sanctioned by the
  ticket's Notes section, but it is a behavior change beyond the import path).
- Suite 167/167.

## 0003 — Dialog-bound IPC paths (commit `7bb4c5b`) ✅

**What:** New `src/electron/dialog-path-grants.ts`: main records every path returned
by its native open/save dialogs in a bounded session grant set (LRU, cap 32).
`GET_FILE_METADATA`, `BACKUP_DATABASE`, `RESTORE_DATABASE`, `RESTORE_DATABASE_FROM_FILE`
now reject any path not granted this session, before touching fs/DB. Metadata also
rejects symlinks/non-regular files. Renderer API unchanged.

**Choices to review:**
- Grants are **session-lifetime, not one-shot** (renderer legitimately reuses a path:
  metadata → send). If you want consume-on-use semantics, small follow-up.
- Grant cap of 32 is arbitrary but generous for real dialog use.
- Suite 173/173, eslint clean.

## 0004 — Stale renderer chat state + name trim (commit `8f6d8df`) ✅

**What:** all four ticket items: (1) `addMessage` recomputes the sidebar preview from
the latest settled message instead of trusting the incoming payload — duplicates and
late/older arrivals can no longer move previews backward; (2) `removeChat` deletes the
chat's reply target and always filters its messages out of `state.messages`
(consistent with `clearMessages`); (3) `removeMessagesByIds` resets
`lastMessageTimestamp` to `0` when a chat empties; (4) trusted-import contact names are
trimmed before the 2-64 length check. 5 new tests. Suite 178/178.

**Choices to review:**
- `state.messages` ownership: chose **filter-by-chatId** (the ticket's alternative was
  documenting it as active-window-only). Side effect: removing the active chat now
  clears only that chat's sendingMessages instead of all — strictly more correct.
- Empty-chat sort key: chose `0` (empty chats sink to the bottom of the chat list).
  The alternative was chat `created_at` (would keep freshly-emptied chats near the top).
- `customName || profile.username` became `(customName ?? profile.username).trim()`:
  an explicit whitespace-only custom name is now rejected instead of silently falling
  back. The real UI passes `customName || undefined`, so no user-visible change.
- Pre-existing unrelated lint error in profile-manager.ts:257 (`catch (error)` unused)
  left untouched.

## 0005 — Bounded inbound stream reads (HIGH) (commit `bc28879`) ✅

**What:** `StreamHandler.readMessageFromStream` now takes required
`{maxBytes, timeoutMs}` and **aborts the underlying stream** (with close fallbacks)
when either bound trips — no buffering past the cap, no promise-race-only timeouts.
All five read sites wired: chat (64 KiB), call-signal (256 KiB — room for SDP),
key-exchange ×2 (128 KiB), bucket nudge (16 KiB, lenient-parse semantics preserved).
The key-exchange follow-up read keeps its existing configured timeout, others use a
30s default. Dead `readFileFromStream` (uncapped, wrote to CWD `gottenfile.txt`)
deleted. New transport tests: cap abort, timeout abort, normal round-trip.
Suite 181/181; our diff reduces the pre-existing lint problem count by one.

**Choices to review:**
- The cap values themselves (constants.ts) — sized generously from envelope shapes,
  but you know real SDP/key-exchange payload sizes best.
- 30s default read timeout (`INBOUND_STREAM_READ_TIMEOUT_MS`).

## 0006 — DHT record ↔ libp2p peerID binding (commit `2b2c55a`) ✅

**What:** username records gain a required `peerBinding` — an Ed25519 signature over the
existing canonical payload, made with the libp2p identity key and verified against the
pubkey embedded in `peerID` (`peerIdFromString(...).publicKey.raw`). Enforced in the
base validator, selector, and validateUpdate (all via the shared `parseRegistration`),
and at every publish site (all record construction funnels through
`#createRegistrationObject`, now async to call `libp2pPrivateKey.sign`). Fail-closed
locally: `lookupByPeerId` requires `reg.peerID === requested`, and first-contact
offline-key resolution throws on a peerID mismatch. Validator tests extended for
unbound/mis-bound rejection + bound round-trip. Suite 186/186, no new lint errors.

**Choices to review:**
- **No back-compat** (per AGENTS.md fresh-launch rule): `peerBinding` is *required* on
  every record — any record without it is rejected. This is a breaking wire-format
  change, intended.
- Binding signs the SAME canonical payload as the app signature (peerBinding excluded
  from it), so both signatures cover identical fields. Reasonable and simple.
- Did NOT touch stale-username-takeover policy (0015) or TOFU key-change alerts (0007) —
  those are their own tickets, as the ticket instructs.

## 0007 — Stop silent overwrite of pinned identity keys (commit `92c93e5`) ✅

**What:** the security-critical core fix. `verifySignatureWithFallback` now (a) only
writes DHT-refreshed keys when the refreshed signature actually verifies — the old
code wrote unconditionally, even on a failed-signature message; (b) never replaces an
*existing* pinned signing key just because a different DHT key verifies — instead it
records a key-change event and returns the message as unverified, leaving the pinned
key intact. Same no-silent-replacement rule applied to the key_exchange_init path.
First-contact pinning unchanged. New `key_change_events` audit table
(+`recordKeyChangeEvent`/`getKeyChangeEvents`, mirrors `failed_key_exchanges`).
Suite 193/193, no new lint.

**Choices to review — IMPORTANT, this is a scoping decision I made:**
- I **deferred the full UI feature** (parts 3-4 of the ticket: a "this contact's key
  changed — confirm before messaging" alert + message gating + rotation-vs-replacement
  auto-accept flow). That is a large cross-layer product feature (renderer UI, IPC,
  UX policy). I implemented the self-contained security core instead: the dangerous
  unconditional overwrite is fixed, silent adoption is stopped, and every change is
  now **persisted** in `key_change_events` ready for a UI to surface.
- **Consequence to be aware of:** a contact who legitimately rotates their key by
  simply publishing a new DHT record (NOT via an authenticated rotation signed by the
  old key) will now have their messages treated as *unverified* until the change is
  resolved — because there is not yet a UI to acknowledge it. If Kiyeovo has (or plans)
  an authenticated rotation flow signed by the current pinned key, that path should
  auto-accept; wire that + the acknowledge-UI as the follow-up. **Decide:** do you want
  me to build the UI alert/gating as a later ticket, or is the audit-trail-only core
  sufficient for now?

## 0008 — Offline-message field signing (HARDENING part) (commit `5d2af21`) ✅ PARTIAL

**What:** the per-message signed payload now additionally binds `message_type`,
`expires_at`, and (hybrid only) hashes of `encrypted_aes_key`/`aes_iv`. Both
`verifyOfflineMessageSignature` and the DHT store validator reject tampering, type
swaps, expiry edits, missing hybrid AES fields, and AES fields smuggled onto an
`encrypted` message. This closes the real adversarial bug in the ticket's "Related
notes": a malicious bucket replica could previously tamper the unsigned AES fields of
one hybrid message so the signature still passed but decryption failed, saving a
`[Failed to decrypt]` placeholder and advancing the read cursor past the honest copy →
permanent targeted suppression. Suite 196/196, no new lint. Bucket-key scheme untouched.

**Choices to review — I DEFERRED the ticket's MAIN item (needs your decision):**
- The ticket's primary subject — the offline bucket DHT key leaks the **sender's stable
  ed25519 signing pubkey** (and thus identity + offline out-degree) in cleartext — is a
  genuine **protocol/product design decision**, not a mechanical fix. The suffix is
  public precisely because the public DHT validator uses it as the write-authorization
  key. Hiding it means giving up some public write-validation, and the ticket notes the
  right answer may differ per mode (fast vs anonymous). I did NOT guess at this.
- **The three options** (from the ticket): (1) per-pair pseudonymous tag +
  recipient-side verification, replacing global public-key write-auth with a per-pair
  MAC; (2) deterministic-but-opaque suffix `HKDF(sharedSecret, senderPubKey)` — both
  parties still derive it but it's no longer globally linkable; (3) mode-specific:
  keep global validation in fast mode, hide in anonymous mode.
- **My recommendation:** Option 2 is the least invasive (smallest change, keeps
  per-direction partitioning) but still weakens public validation since the validator
  can't recover the signing key from the slot; Option 1 is the most privacy-complete
  but the biggest change to the write-authorization model. If anonymous-mode privacy is
  the priority, Option 3 (2-in-anonymous, status-quo-in-fast) is the pragmatic split.
  **Tell me which option** and I'll implement it as a follow-up.

## 0009 — Group removed-member trailing-epoch injection (commit `b59b0e8`) ✅

**What:** the group-offline scanner now fails closed. For a CLOSED epoch
(`used_until !== null`) with no authoritative sender boundary yet, acceptance is capped
at the local pre-scan high-water mark (`getMemberSeq`, captured once before the loop so
an injected message can't raise its own ceiling). Rejects a just-removed member's new
higher-seq injections during the boundary-snapshot race while still allowing backfill
(`seq <= high-water`). Authoritative-boundary and live-epoch (`used_until === null`)
paths unchanged. New `group-offline-manager.test.ts`, 4 cases. Suite 200/200. (I also
fixed 2 `as any` lint errors Codex left in the new test file.)

**Choices to review:**
- Chose the ticket's **option 2** (cap at local high-water mark) over option 1 (defer
  scanning until snapshot arrives). Option 2 delivers legit backfill sooner; reversible.
- Fixed only the reader-side gate (root cause 1); root causes 2/3 (ex-member still
  enumerated, context-free DHT validator) left as defense-in-depth per the ticket.

## 0010 — Group cleartext metadata leak (gossip + group-offline DHT) ⏸️ DEFERRED (needs your decision)

**Not implemented — escalated.** Explicit "needs design" protocol redesign; unlike 0008
it has **no decision-free hardening sub-part** — every item changes a wire format, the
routing/topic-selector scheme, or the DHT write-authorization model.

**Why deferred:** needs the same per-mode product decision as 0008 ("Group B priority-1:
decide the privacy target per mode, fast vs anonymous"), and it's the group analogue of
0008's deferred core — decide/build them together. A speculative version would change
security-critical group write-authorization and the gossip frame format, risking
breakage and likely rework once you choose a direction.

**What it needs:** (1) realtime gossip frame (`group-messaging.ts:335-353`) sends
`groupId`, `senderPeerId`, `keyVersion`, `seq`, `messageId`, `timestamp`, `messageType`
in cleartext to on-mesh peers → move identity/ordering fields into an inner envelope
encrypted under the group key, publish only an epoch-scoped opaque routing selector
(seed from the topic hash `sha256(groupId+sha256(groupKey))`) + ciphertext + nonce;
(2) group-offline DHT key (`group-offline-manager.ts:143-146`) leaks
`groupId`/`keyVersion`/`senderPubKey` to storage nodes — same treatment + tradeoff as
0008; (3) stop emitting the stable `groupId` in cleartext (it links traffic across epoch
rotations, defeating topic rotation).

**My recommendation:** decide 0008 + 0010 together as one "anonymous-mode metadata" work
item. Pick the per-mode target (my lean: opaque per-epoch selectors everywhere, with
0008 option 3's fast-vs-anonymous split) and I'll implement both. **Biggest open
decision in the batch.**

## 0011 — Group model design limitations (Informational) 📋 ANALYSIS ONLY (no code)

This ticket is explicitly "Open (for decision, not necessarily a fix)" — it records
structural tradeoffs of the single-creator DHT-backed group model, not bugs. No code
was changed. My read + recommendation per item, for you to accept or schedule:

1. **Single-creator SPOF / no creator-leave** — inherent to the design. Accept for now
   unless you want co-admin / authority-rotation (a large feature). *Recommend: accept,
   revisit only if groups become long-lived/critical.*
2. **Creator equivocation (different rosters to different members)** — real "who's in
   the group" gap. Fixable by having members reconcile the gossip roster against the
   signed DHT `GroupInfoVersionedMetadata.members` (and/or each other). *Recommend:
   schedule as a real ticket — this bears on a marketed guarantee.*
3. **Invites not bound to invitee** — `GroupInvite` is a bearer token. This is the most
   self-contained concrete fix (add invitee peerId/pubkey into the signed invite, verify
   at redemption). *Recommend: schedule as a small hardening ticket — I can implement it
   in isolation if you want.*
4. **Eclipse/rollback for fresh syncers** — established members are safe (monotonic
   versions, no downgrade); only first-sync peers can be served a stale signed `latest`.
   Needs freshness beyond "any signed record" (signed recency bound / multi-node
   reconcile). *Recommend: schedule; medium effort.*
5. **Group-only contact keys = creator's assertion** — already partly mitigated (TOFU
   direct binding is not overwritten by roster keys). This is the group projection of
   0006. *Recommend: accept as a documented limitation; 0006 covers the direct path.*

**Decision needed:** which of items 2/3/4 you want turned into implementation tickets.
Item 3 is the one I can do cleanly and immediately on your say-so.

## 0012 — WebRTC IP-handling backstop (commit `757af11`) ✅

**What:** defense-in-depth for call anonymity. New `applyWebRTCIPHandlingPolicy(session,
mode)` in session-security.ts: in anonymous mode the Electron session sets
`webRTCIPHandlingPolicy = 'disable_non_proxied_udp'` (fail closed — WebRTC can't gather
host/srflx candidates, so a stray `RTCPeerConnection` in anonymous mode is a no-op
instead of a real-IP leak). Fast mode left at default so normal calls work. Startup mode
threaded through `applySessionSecurityPolicies`. New `session-security.test.ts` asserts
anonymous applies the policy and fast does not. Suite 202/202.

**Choices to review:**
- Implemented only fix #1 (the session-level backstop). **Deferred fix #2** (tear down
  active calls on runtime mode change) — the ticket states this is NOT currently
  reachable (mode change requires an app restart, which already tears down calls). If
  you ever add a live in-process mode switch, that teardown becomes necessary.
- Did not touch the two "Related lower-priority" notes (fast-mode IP-to-contact UX
  disclosure; inbound ICE candidate filtering) — flagged here in case you want them as
  their own small tickets.

## 0013 — Encrypted DB backup + validate-before-replace restore (commit `a48be4b`) ✅

**What:** the full ticket. Backups are now a password-encrypted authenticated artifact
(scrypt + AES-256-GCM reusing ProfileManager's crypto style, `KIYEOVO-DB-BACKUP` magic +
version header, salt/nonce, `0600` perms) instead of a raw plaintext SQLite copy.
`restoreEncrypted`/`restoreEncryptedAtPath` decrypt+authenticate+validate into a temp
file (open readonly, `integrity_check`, required-tables check) BEFORE touching any live
file, then atomically swap `chat.db` + `-wal` + `-shm` (main db included in the `.bak`
set, so rollback restores the original) with rollback on any failure. Logged-in and
pre-login IPC both route through the one sidecar-aware helper — the old pre-copy `unlink`
data-loss window and stale-WAL bug are gone. Ticket 0003 dialog-grant checks retained on
all three handlers. New `BackupPasswordDialog.tsx` collects the password in both flows.
DB tests assert: no plaintext in the artifact, 0600 perms, wrong-password/tamper rejected
with the original DB intact, malformed file rejected before sidecars are touched, and a
successful round-trip. Suite 204/204, no new lint (PasswordPrompt.tsx even improved 6→1
pre-existing errors).

**Choices to review:**
- **Separate user-chosen backup password** (not the login password). Rationale: a backup
  is meant to be portable to another device, where the login credential/identity isn't
  available — so a standalone secret is the right model. If you'd rather reuse the login
  password (fewer prompts, but couples backup to login and complicates pre-login
  restore), say so and I'll switch it.
- **No legacy support:** old plaintext `.db` backups are intentionally NOT restorable
  (fresh-launch rule). Anyone mid-migration with an old backup would need a fresh one.
- Backup file uses a distinct extension in tests (`.kiyeovo-db-backup`); the renderer
  save dialog still defaults to `.db` — you may want to align the suggested extension in
  `SettingsPage.tsx` for clarity (cosmetic).
- Renderer password dialogs are the part I could least fully verify (no full app run in
  this env); the security-critical core + IPC are covered by tests. Worth a quick manual
  click-through of backup→restore when you're back.

## 0015 — Stale username takeover policy ⏸️ DEFERRED (needs your decision)

**Not implemented — escalated.** The ticket is explicitly "needs a product/protocol
decision, not only a code fix." Crucially, **0006 does NOT fix this**: the attacker uses
their OWN real peerId (which they can prove), claiming a *username* whose owner is
offline/expired. The record is cryptographically valid — the issue is the ownership
*policy* (first-come + stale/released records replaceable after ~10 min, and once taken
the `sameOwner` gate blocks the real owner from ever reclaiming).

**The three options (from the ticket):**
1. **Accept** it as a property of a decentralized first-come namespace + make it explicit
   in the UI.
2. **Longer/soft-expiry + grace reclaim:** lengthen `MAX_REGISTRATION_AGE` and let a
   record's *original* owner preferentially reclaim even after it goes stale (keyed off a
   stable owner identity), instead of the current `sameOwner` gate locking them out.
3. **Stable-identity ownership:** bind name ownership to the stable peerId (from 0006) /
   a long-term key and require proof of that identity to *transfer* a name, so lapsing on
   re-publish doesn't forfeit ownership.

**My recommendation:** **Option 2** is the best balance — it directly fixes the
"unrecoverable" property (the real owner can reclaim) without the full ownership-transfer
protocol of option 3, and builds naturally on 0006's peerId binding as the stable owner
key. **Regardless of the option**, I strongly recommend the ticket's cross-cutting UI
point: mark a freshly **name-resolved, not-yet-pinned** contact distinctly from a
**key-exchange-verified/pinned** one, so a taken-over name isn't shown with full trust.
That UI distinction is a concrete follow-up I can implement once you confirm.

**Tell me:** which option (I lean 2), and whether to build the verified-vs-resolved UI
badge — both are follow-ups I can do on your say-so.

## 0014 — Inbound resource caps + DHT decompression ceilings (commit `136a9e7`) ✅ PARTIAL (scoped)

**What:** implemented the concrete, low-risk, high-value findings.
- **Finding 4 (real vuln):** the direct-offline DHT validator now rejects a compressed
  value >64KiB BEFORE gunzip/JSON.parse on the validate, selector, AND validateUpdate
  paths — closes a decompression-bomb / oversized-value vector. Also routed the group
  validator's existing guard through its shared decompress helper so its selector/update
  paths are covered too. Tests assert oversized-before-decompress rejection.
- **Finding 2:** explicit `maxInboundStreams` on chat (8), bucket-nudge (4), call-signal
  (8), file-transfer (8) handlers.
- **Finding 1 (config):** `connectionManager` now sets `inboundConnectionThreshold`,
  `maxIncomingPendingConnections`, `inboundUpgradeTimeout`.
I verified all five libp2p option names against the installed `libp2p@2.10.0` typings so
the node won't throw at startup (`maxIncomingConnections` from the ticket does NOT exist
in 2.10 — used the valid inbound-pending/threshold/timeout knobs instead). Suite 205/205;
lint actually improved (validator 2→0).

**Choices to review / deferred:**
- Deferred the three larger design pieces (flagged, not half-built): **Finding 1's
  contact-reserved headroom** (needs a contact-aware connection-eviction gater),
  **Finding 3** (a LeasePool-style per-peer/global rate limiter in front of the
  unauthenticated read + `/chat` key-exchange hot path — the most impactful remaining
  DoS hardening, but it touches the hot path and deserves care), and **Finding 5**
  (per-peer cooldown on nudge-triggered offline checks). Worth their own tickets; Finding
  3 is the one I'd prioritize.
- Cap values (stream counts, 64KiB direct ceiling, connection knobs) are conservative
  guesses — tune against real traffic if any feel tight.

---
