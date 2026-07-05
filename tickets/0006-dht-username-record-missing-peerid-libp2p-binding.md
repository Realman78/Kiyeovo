# DHT username record does not bind `peerID` to the libp2p identity key

- **Area:** Core / Identity + Username registry (DHT)
- **Severity:** Medium
- **Source:** Security scan — identity & key-exchange (malicious-peer threat model)
- **Status:** Open

## Threat model

The client is open source, so any remote peer may run a modified client. The DHT
is a public, writable store: any node can attempt to publish a record. Identity
records must therefore be self-authenticating against a key the claimed owner
provably controls.

## Summary

A username record is
`{ peerID, username, signingPublicKey, offlinePublicKey, timestamp, kind, signature }`.
Its `signature` is verified using the **`signingPublicKey` contained in the record
itself** (`username-record.ts:66-72`), and the DHT validator additionally checks
only that `sha256(peerID)` / `sha256(username)` matches the DHT key slot
(`username-dht-validator.ts:37-42`). Nothing proves the record's author controls
the **libp2p private key for `peerID`** — `peerID` is a self-asserted string signed
by a signing key the author chose.

The libp2p identity key and the application signing key are generated
independently (`encrypted-user-identity.ts:111-116`) with no proof-of-possession
linking them, and `peerID` encodes the libp2p public key — not the signing key. So
an attacker can mint a valid record for **any victim's peerId** carrying the
**attacker's own** signing and offline keys.

**Scope note.** This ticket covers the *cryptographic binding* problem: a record can
assert a `peerID` its author does not control. A separate, independent problem — that
an attacker using their *own* real peerId can take over an expired/unregistered
*username* — is **not** fixed by adding a libp2p binding and is tracked as its own
policy ticket, [[0015-username-stale-record-takeover-policy]]. Keep the two distinct:
peerID self-assertion is a missing crypto binding; stale username ownership is a
protocol/product policy decision.

## Where a poisoned record is accepted

- Base validator `usernameRegistrationValidator` (`username-dht-validator.ts:62-81`)
  accepts any well-formed, self-signed record whose `sha256(peerID)` matches the
  `by-peer` slot. On any DHT node that does not already hold the victim's record,
  only this base validator runs → accepted.
- `usernameRegistrationValidateUpdate` (`:117-184`) permits *replacing* an existing
  record when it is `released`, or stale (`existingAgeMs > MAX_REGISTRATION_AGE`,
  i.e. `2 × REREGISTRATION_INTERVAL` = 10 min → `:167-172` `ALLOW_REPLACE`). Records
  are re-published every `REREGISTRATION_INTERVAL` (5 min), so a victim offline for
  ~10 minutes has a claimable `by-peer` slot.

## Consequence A — first-contact denial of service (not confidentiality)

`resolveRecipientOfflinePublicKeyBase64` (`key-exchange.ts:500-518`) resolves the
recipient's offline public key as: caller-supplied → pinned DB value → **else
`usernameRegistry.lookupByPeerId(peerId).offlinePublicKey`** (the un-bound `by-peer`
record). `createInitiatorKeyExchangeRequest` (`:531-535`) then RSA-encrypts the
initiator's **first message body** to that key.

If U opens a conversation with V while holding no pinned offline key for V, and an
attacker has poisoned V's `by-peer` record, U encrypts the first message body to the
attacker's RSA key. The impact is **denial of first contact, not disclosure**: the
`key_exchange_init` is delivered *only over a live dial* (`openKeyExchangeInitStream`,
`:401`; there is no offline-bucket fallback for the init, and no offline bucket secret
even exists pre-session — it is HKDF-derived from the X25519 ECDH shared secret,
`deriveOfflineBucketSecret` `:309-327`). So the init travels the authenticated Noise
stream straight to V, who then cannot RSA-decrypt the body (it was encrypted to the
attacker's key) and rejects/aborts the handshake. The plaintext never reaches any
publicly readable location, so the attacker does not learn the message; they only
break/deny the first contact until U obtains V's real key.

(Earlier drafts of this ticket claimed a confidentiality break here via a public
offline bucket. That is incorrect: the offline bucket requires an already-established
ECDH secret, so no first-contact message is ever deposited in a third-party-readable
bucket.)

## Consequence B — fail-open by-peer lookup feeds the poisoned record

The binding gap only bites because a consumer trusts a `by-peer` lookup without
re-checking it locally. `lookupByPeerId` (`username-registry.ts:192-199`) passes
`undefined` as its validation predicate — unlike `lookup(username)`, which passes
`reg => reg.username === username` — so it does **not** locally assert that the
returned record's `peerID` equals the requested peerId. `resolveRecipientOfflinePublicKeyBase64`
(`key-exchange.ts:510-512`) then consumes that record's `offlinePublicKey` with no
re-check. So even a client that wanted to fail closed currently does not. The DHT
validator enforces `sha256(peerID) == slot` network-side, but a lookup consumer should
not depend solely on remote validators having run.

## Why this is the root enabler (not standalone impersonation)

On its own the binding gap yields the first-contact DoS above and erodes defense in
depth. Its larger significance is as an **enabler**: the poisoned key it permits is
exactly what [[0007-tofu-signing-key-change-no-alert]] silently adopts, and what the
non-transport-anchored offline-message verification later trusts. The name-based
*impersonation* people usually associate with "username squatting" lives in the stale
takeover policy, [[0015-username-stale-record-takeover-policy]], and is **not** fixed
here.

## Location

- `src/core/username/username-record.ts:66-72` (`verifyUsernameRegistrationSignature`
  — verifies against the record's own `signingPublicKey`).
- `src/core/username/username-dht-validator.ts:37-42` (`verifyKeyBinding` — only slot
  hash, no libp2p proof), `:62-81` (base validator), `:117-184` (`validateUpdate`
  stale/released/owner rules).
- `src/core/username/username-registry.ts:192-199` (`lookupByPeerId` — no local
  `peerID` match check; passes `undefined` predicate).
- `src/core/direct/key-exchange.ts:500-518` (offline-key resolution falls back to the
  DHT record, `:510-512`, with no `peerID` re-check), `:531-535` (first message
  encrypted to the resolved key).
- `src/core/identity/encrypted-user-identity.ts:111-116` (libp2p key and signing key
  generated independently, no PoP binding).

## Expected behavior

A username record must prove that its author controls the libp2p private key for the
claimed `peerID`, so a peer cannot publish a record for a peerId they do not own.

## Suggested fix

Two parts — the cryptographic binding and a local fail-closed check. (Neither fixes
stale username takeover; that is [[0015-username-stale-record-takeover-policy]].)

**1. libp2p proof-of-possession in the record + validator.**
- When building a record, also sign the canonical payload with the **libp2p private
  key** and include that as a second signature (e.g. `peerBinding`).
- In `usernameRegistrationValidator` / `verifyKeyBinding`, extract the libp2p public
  key embedded in `peerID` (Ed25519 peerIds carry the pubkey in the identity multihash)
  and verify `peerBinding` against it, in addition to the existing `signingPublicKey`
  signature. Reject records where the libp2p proof is missing or invalid. Apply the
  same check in `usernameRegistrationSelector` and `validateUpdate` so replicas and
  updates are equally protected.

**2. Local fail-closed lookup validation.**
- Make `lookupByPeerId` assert `reg.peerID === requestedPeerId` locally (mirror the
  `reg.username === username` predicate that `lookup` already passes), and reject a
  mismatched record.
- Have `resolveRecipientOfflinePublicKeyBase64` (and any other by-peer consumer) fail
  closed on a mismatch rather than trusting the validator alone.

What this fixes: peerID-spoofed records are rejected at publish/read (part 1) and never
consumed even if one slips through a mis-behaving node (part 2). This removes the
first-contact DoS (Consequence A) and the un-bound key that
[[0007-tofu-signing-key-change-no-alert]] silently adopts. It does **not** make name
ownership provable against a same-peerId squatter — see 0015.

Consider additionally: pin the offline public key on first successful, fully-bound
contact and warn on change (see 0007).

## Test coverage

Not currently covered. Add:
- Validator rejects a `by-peer` record whose `peerID` does not match the libp2p key
  that signed the `peerBinding` (and accepts a correctly bound one).
- `lookupByPeerId` rejects a record whose `peerID` != the requested peerId.
- `resolveRecipientOfflinePublicKeyBase64` refuses an offline key from an unbound or
  mismatched record (fails closed).
