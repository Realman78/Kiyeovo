# Kiyeovo Tickets — Index

Findings are organized into **review groups** by shared root cause / theme, so each
group can be reviewed (and often fixed) together. Every ticket appears in exactly one
group. Severity in parentheses.

Two bodies of work are indexed here:
- **Groups A–E** — the feature-by-feature **security scan** (malicious-peer threat
  model: the client is open source, so the app must be secure from the recipient's
  side). Tickets `0005`–`0015`.
- **Group F** — earlier **test-review** findings surfaced while writing the risk-based
  test suite. Tickets `0001`–`0004`.

---

## Group A — Identity & trust binding (DHT)

The structural root cluster: identity in the DHT is self-asserted, and trust changes
are adopted silently. `0006` is the keystone crypto binding; `0007` and `0011` lean on
it, and `0015` is the separate namespace-ownership *policy* question it does not solve.

- **[0006](0006-dht-username-record-missing-peerid-libp2p-binding.md)** (Medium) — DHT
  username record does not bind `peerID` to the libp2p key (peerID-spoofed records) +
  fail-open by-peer lookup. *Root crypto enabler of this group.*
- **[0007](0007-tofu-signing-key-change-no-alert.md)** (Low–Medium) — a pinned signing
  key is silently overwritten from the DHT with no change alert; the fallback write is
  even **unconditional** (happens on failed re-verification).
- **[0015](0015-username-stale-record-takeover-policy.md)** (Medium) — stale/expired
  username records can be taken over → name-based impersonation of offline users;
  unrecoverable. A protocol/product policy decision, **not** fixed by `0006`.
- **[0011](0011-group-model-design-limitations.md)** (Informational) — group-model
  design limitations (single-creator SPOF, creator equivocation, invites not
  invitee-bound, eclipse rollback for fresh syncers). Depends on `0006`.

## Group B — Metadata / privacy leaks

Content is encrypted, but stable identifiers travel in cleartext in DHT keys / gossip
frames, exposing who-talks-to-whom to storage nodes and mesh relayers. Matters most in
anonymous/Tor mode.

- **[0008](0008-offline-bucket-sender-identity-metadata-leak.md)** (Low–Medium) —
  offline DHT bucket key leaks the sender's stable signing pubkey + social-graph
  out-degree; also covers the tampered-AES-field replica corruption/suppression note.
- **[0010](0010-group-gossip-cleartext-metadata-leak.md)** (Low–Medium) — group
  cleartext metadata on **two** surfaces: realtime gossip frame *and* group-offline DHT
  keys (`groupId` / `keyVersion` / `senderPeerId`); stable `groupId` links traffic
  across key rotations. Must be fixed together.

## Group C — Resource exhaustion / DoS (unauthenticated network surface)

Remote, largely pre-authentication availability attacks; both reachable over relay.

- **[0005](0005-unbounded-inbound-stream-reads-dos.md)** (High) — unbounded inbound
  stream reads → pre-auth remote memory-exhaustion crash. (Timeout fix must abort the
  stream, not just race a promise.)
- **[0014](0014-missing-connection-stream-resource-caps.md)** (Medium) — no inbound
  connection/stream caps or per-peer rate limits (chat/nudge/call-signal — file-transfer
  already bounded); plus the direct-offline DHT validator decompresses before any
  size cap.

## Group D — Fail-closed / defense-in-depth gaps

Single-layer protections where one regression flips protection into a leak/injection.

- **[0012](0012-webrtc-ip-leak-no-defense-in-depth.md)** (Medium) — WebRTC anonymity
  rests on one signaling-layer mode gate with no WebRTC-layer backstop; any call
  started in anonymous mode leaks the real IP. (Live mode-switch is *not* a current path
  — mode change requires restart; teardown is lifecycle hardening.)
- **[0009](0009-group-removed-member-trailing-epoch-injection.md)** (Low–Medium) — a
  removed group member can inject content into the trailing epoch during the
  boundary-snapshot race — affects **non-creator** readers (the creator has local
  boundaries).

## Group E — Data at rest / local trust

- **[0013](0013-backup-restore-no-encryption-no-integrity.md)** (Medium) — DB backup is
  plaintext; restore is an unauthenticated raw DB replacement (reachable pre-login) that
  can swap the identity/trust store. Related raw-path issue: `0003`.

## Group F — Earlier test-review findings (pre-scan)

Surfaced while writing the risk-based test suite; not part of the malicious-peer
security scan.

- **[0001](0001-trusted-import-self-import-guard.md)** (Medium) — trusted profile import
  lacks an explicit self-import guard; normal state gives the wrong duplicate-contact
  error, and inconsistent local state can leave partial DB writes.
- **[0002](0002-trusted-import-non-atomic-create.md)** (Medium) — trusted profile import
  is non-atomic (`createUser` + `createChat` with no rollback).
- **[0003](0003-get-file-metadata-and-backup-raw-renderer-paths.md)** (Medium) —
  `GET_FILE_METADATA` and backup/restore stat/use raw renderer-supplied paths. Related
  to `0013`.
- **[0004](0004-chatslice-stale-renderer-state-and-name-normalization.md)** (Low) —
  stale renderer-local chat state + un-normalized contact name.

---

## Severity tally (security scan, 0005–0015)

- **High:** 1 (`0005`)
- **Medium:** 5 (`0006`, `0012`, `0013`, `0014`, `0015`)
- **Low–Medium:** 4 (`0007`, `0008`, `0009`, `0010`)
- **Informational:** 1 (`0011`)

## Scan coverage

Reviewed: message ingestion, file/media transfer (clean — no ticket), identity & key
exchange, offline message buckets, group messaging, call/WebRTC, backup/restore,
notifications bucket (inert scaffolding — no ticket), network/transport.

Not reviewed (lower priority / different trust model): bootstrap & relay *server*
infrastructure, the contact-authorization/blocking state machine, recovery-phrase flow.

**Through-line:** cryptographic *authentication* is consistently solid (no SQLi, no XSS,
no path traversal, no unauthenticated live impersonation). The weaknesses cluster in the
**DHT identity/metadata layer** (Groups A, B) and in **fail-closed / defense-in-depth**
(Groups C, D) — i.e. a modified peer's leverage is on the publication and
resource-exhaustion paths, not on breaking live crypto.
