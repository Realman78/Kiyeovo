# Group model design limitations (informational — architectural tradeoffs)

- **Area:** Core / Group messaging (architecture)
- **Severity:** Informational
- **Source:** Security scan — group messaging (malicious-peer threat model)
- **Status:** Open (for decision, not necessarily a fix)

## Purpose

These are structural properties of the group design surfaced during the security
scan. None is an implementation bug; each is a tradeoff of the single-creator,
DHT-backed model. Recorded so they are understood and consciously accepted (or
scheduled), not silently assumed away. The concrete implementation-level findings are
tracked separately in [[0009-group-removed-member-trailing-epoch-injection]] and
[[0010-group-gossip-cleartext-metadata-leak]].

## 1. Single-creator single point of failure; no creator-leave

All membership integrity depends on **one** creator key. Every roster change must be
creator-signed (`group-creator.ts` gates on `chat.created_by === myPeerId`; members
verify against the pinned `chat.group_creator_peer_id`'s key). There is no co-admin
and no creator-leave path (`group-responder.ts:259-261`, `group-creator.ts:532-535`).

Implications: if the creator's key is lost or compromised, the group has no recovery
or rotation of authority; if the creator goes away, membership can no longer change.

## 2. Creator equivocation

Nothing cross-checks the gossip-distributed roster (used for the authoritative
message-acceptance gate, `group-messaging.ts:1010-1016`) against the DHT-published
`GroupInfoVersionedMetadata.members` list. A malicious creator can therefore present
**different rosters to different members** — e.g. tell A that B is a member while
telling everyone else B is not. Detecting this would require members to reconcile the
gossip roster against the signed DHT member list (and each other).

## 3. Invites are not cryptographically bound to a specific invitee

`GroupInvite` (`types.ts:34-43`) contains no invitee peerId/pubkey, so the signed
invite is a bearer token valid for anyone who obtains it. Misuse is currently
prevented only by (a) RSA-encrypted delivery to the intended invitee and (b)
creator-side pending-ack bookkeeping keyed by the responder peerId
(`group-creator.ts:405-435`) — not by binding inside the invite. A robust design would
bind the invite to the invitee's identity and have the creator verify that binding at
redemption.

## 4. Eclipse / rollback for freshly-syncing peers

Every historical `groupInfoLatest` record is validly creator-signed. In-node
`validateUpdate` enforces monotonic versions, and live members never downgrade their
local `key_version` — so established members are protected against rollback. But a
peer syncing state fresh from the DHT relies on the newest record being *present* at
the node it queries; a withholding/eclipse adversary can serve only an older
(still-signed) `latest` record and show a stale roster to a new/re-syncing peer.
Mitigation would need freshness beyond "any validly-signed record" (e.g. signed
recency bounds, or multi-node reconciliation).

## 5. Group-only contact keys reduce to the creator's assertion

For a contact known *only* through a group, the peerId→signing-key mapping is whatever
the creator asserts in the roster. A pre-existing direct-key-exchange (TOFU) binding is
**not** overwritten by a creator-supplied roster key (`group-responder.ts:462-476` only
`createUser` when the user does not already exist), which limits this — but a
group-only member's key is still only as trustworthy as the creator. This is the group
projection of [[0006-dht-username-record-missing-peerid-libp2p-binding]] (peerId↔key
binding is self-asserted, not derived).

## Recommendation

Decide, per item, whether the current tradeoff is acceptable for the product's threat
model or should be scheduled. Items 2, 3, and 4 are the ones most worth an explicit
decision, since they bear directly on the "who is really in this group / who am I
talking to" guarantee the product markets.
