# Group metadata leaks in cleartext (realtime gossip frame + group-offline DHT keys)

- **Area:** Core / Group messaging (gossipsub + group-offline DHT) — privacy/metadata
- **Severity:** Low–Medium
- **Source:** Security scan — group messaging (malicious-peer threat model)
- **Status:** Open

> Scope note: this ticket covers **two** cleartext group-metadata surfaces that must be
> fixed together — realtime gossip frames (§ Realtime gossip) and group-offline DHT
> bucket keys (§ Group-offline DHT). Encrypting only the gossip frame leaves the DHT
> backup metadata exposed. Both are the group analogue of
> [[0008-offline-bucket-sender-identity-metadata-leak]].

## Threat model

The client is open source and gossipsub relays application payload bytes by topic.
For a privacy-focused messenger (especially anonymous/Tor mode), metadata that
identifies *who* is messaging *which group* is part of the threat surface even when
message *content* is encrypted. Related to the direct-path leak in
[[0008-offline-bucket-sender-identity-metadata-leak]].

## Realtime gossip

Only the message body is encrypted; the rest of the published gossip frame is
cleartext. `group-messaging.ts:335-353`:

```ts
const unsignedMessage = {
  type, groupId, keyVersion, senderPeerId: this.deps.myPeerId,
  messageId, seq, encryptedContent, nonce, timestamp, messageType,
};
const signedMessage = { ...unsignedMessage, signature: this.sign(unsignedMessage) };
const payloadBytes = new TextEncoder().encode(JSON.stringify(signedMessage));
```

So `groupId`, `senderPeerId`, `keyVersion`, `seq`, `messageId`, `timestamp`, and
`messageType` travel in the clear. The exposed audience is **peers that receive the
pubsub traffic for the topic** — i.e. subscribed/on-mesh peers, peers that learn and
join the topic, and relay/mesh participants carrying that topic — not "any peer
directly connected to a publisher" (a direct connection alone does not deliver a
topic's frames unless that peer is on the topic's mesh). Any such peer reads sender
identity and group id without ever holding the group key.

### Why the stable `groupId` makes this worse

The topic is `sha256(groupId + sha256(groupKey))` and rotates every epoch, which is
supposed to unlink a group's traffic across key rotations. But `groupId` is a **stable
UUID carried in cleartext in every frame**, so an observer who captures frames from
two different epochs can link them via `groupId` regardless of the topic change —
partially defeating the point of rotating the topic. `senderPeerId` in the clear
likewise exposes the group's membership/activity graph to on-mesh observers.

## Group-offline DHT

The group-offline DHT bucket key exposes the same identifiers to *storage* nodes (a
broader, more persistent audience than the realtime mesh). Key format:

```
/<mode-group-offline-prefix>/<groupId>/<keyVersion>/<senderPubKeyBase64url>
```

built at `group-offline-manager.ts:143-146` (`getOwnBucketKey`, suffix =
`toBase64Url(signingPublicKey)`). So `groupId`, epoch/`keyVersion`, and the sender's
stable signing key are cleartext in the DHT key. The group-offline validator uses those
same cleartext key segments to bind messages and verify signatures
(`group-dht-validator.ts:18`, `:64`, `:79`, `:99`, `:137`, `:156`, `:170`) — the same
validator-vs-metadata tension as [[0008-offline-bucket-sender-identity-metadata-leak]].
Fixing only the gossip frame leaves this exposed, which is why both surfaces are in one
ticket.

## Location

- Realtime: `src/core/group/runtime/group-messaging.ts:335-353` (frame assembly +
  publish); topic derivation `:899-903`; only `encryptContent` (`:923-928`) protects the
  body; inbound context resolution `:996` (see design constraint below).
- Group-offline: `src/core/group/runtime/group-offline-manager.ts:143-146` (bucket key);
  `src/core/group/dht/group-dht-validator.ts:18,64,79,99,137,156,170` (validator binds to
  the cleartext key segments).

## Expected behavior

An on-mesh observer without the group key should not be able to recover the group id,
sender identity, or link a group's traffic across epoch rotations from the frame.

## Design constraint — inbound needs *some* routing key before it can decrypt

The redesign is not just "encrypt everything." Inbound processing currently uses the
cleartext `groupId` + `keyVersion` to resolve the group context (and thus the
decryption key) *before* it can decrypt anything — `resolveIncomingGroupContext`
(`group-messaging.ts:996`) resolves the group by `groupId`+`keyVersion` and re-derives
the expected topic. A receiver that holds many group keys must still be able to select
the right one from what's outside the ciphertext. So the fix must supply an *opaque,
per-epoch* routing selector that a member can match against their own keys, without it
being a stable cross-epoch identifier. The topic hash itself
(`sha256(groupId + sha256(groupKey))`) is already epoch-scoped and could serve as (or
seed) that selector, since a member re-derives it from keys they hold.

## Suggested fix (needs design)

Treat both surfaces together — the goal is that no cleartext, cross-epoch-linkable,
identity-revealing field appears in either the gossip frame or the DHT key.

1. **Realtime:** move `senderPeerId`, `seq`, `messageId`, `timestamp`, `messageType`,
   and the signature into an inner authenticated envelope encrypted under the group key;
   publish only the epoch-scoped routing selector + ciphertext + nonce. Receivers select
   the key via the selector, decrypt, then run the existing membership/signature/seq
   checks on the inner fields (see the constraint above).
2. **Stop emitting the stable `groupId`** in the clear anywhere (frame or DHT key);
   replace with per-epoch values so traffic/records cannot be linked across rotations.
3. **Group-offline DHT:** apply the same treatment as
   [[0008-offline-bucket-sender-identity-metadata-leak]] — a per-pair/per-group
   pseudonymous suffix and record-carried (or recipient-pinned) verifying key instead of
   `groupId`/`keyVersion`/`senderPubKey` in cleartext, subject to the same
   validator-vs-metadata tradeoff.
4. Decide the privacy target per mode (fast vs anonymous) before implementing — this is
   the Group B priority-1 decision.

## Test coverage

Not currently covered. Once redesigned:
- A captured published gossip frame does not contain cleartext `groupId` /
  `senderPeerId`; a member can still select the right key and decrypt.
- A group-offline DHT key does not contain a stable `groupId` or the sender's global
  signing key.
- Frames/records from two epochs of the same group are not linkable by a common
  cleartext field.
- Inbound verification (context resolution, membership, per-message signature, seq
  dedup) still passes on the decrypted inner envelope.
