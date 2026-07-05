# Stale/expired username records can be taken over (name-based impersonation) — policy decision

- **Area:** Core / Username registry (DHT) — protocol/product policy
- **Severity:** Medium (policy decision with a real impersonation impact)
- **Source:** Security scan — identity & key-exchange; separated out of
  [[0006-dht-username-record-missing-peerid-libp2p-binding]] during Group A review
- **Status:** Open (needs a product/protocol decision, not only a code fix)

## Why this is separate from 0006

0006 is about a record asserting a `peerID` its author does not control (a missing
cryptographic binding). **This** ticket is about a different attack that a libp2p
proof-of-possession does **not** fix: an attacker using their **own real peerId** (which
they fully control and can prove) claiming a *username* whose legitimate owner is
offline/expired/unregistered. The record is entirely valid and self-consistent — the
problem is the *ownership policy*, not the signature.

## Summary

`by-name` username registration is first-come, and the validator intentionally allows
replacing a stale/released record:

- `usernameRegistrationValidateUpdate` `ALLOW_REPLACE` when the existing record is
  `released` or stale (`existingAgeMs > MAX_REGISTRATION_AGE` = `2 ×
  REREGISTRATION_INTERVAL` = 10 min) — `username-dht-validator.ts:167-172`.
- `ensureUsernameAvailableForRegistration` only blocks a *fresh active* record owned by
  a different peerId — `username-registry.ts:390` (approx).

Records are re-published every `REREGISTRATION_INTERVAL` (5 min), so a username whose
owner has been offline for ~10 minutes (or never registered it) is claimable.

## Impact

A victim who searches for a taken-over name dials the **attacker's** peerId and
completes a fully valid handshake — but the UI labels the attacker with the trusted
name. This is name-based impersonation of an offline/absent user; transport
authentication does not help, because the victim really is talking to the attacker and
only the name→peer mapping is wrong.

It is also currently **not recoverable**: once the attacker's record is the fresh
active one, `validateUpdate`'s `sameOwner` check (`username-dht-validator.ts:174-183`)
rejects the legitimate owner's re-registration as an owner mismatch (different peerId).
While the attacker keeps republishing every < 10 min, the real owner can never reclaim
the name.

## Location

- `src/core/username/username-dht-validator.ts:167-172` (`ALLOW_REPLACE` on stale/released),
  `:174-183` (`sameOwner` gate that also blocks legitimate reclaim).
- `src/core/username/username-registry.ts:~390` (`ensureUsernameAvailableForRegistration`).

## Decision to make

This is a protocol/product policy question (sibling to
[[0011-group-model-design-limitations]]). Options, roughly in increasing strength:

1. **Accept it** as a known property of a decentralized, first-come namespace and make
   it explicit in the UI (see below).
2. **Longer/soft-expiry + grace reclaim:** lengthen `MAX_REGISTRATION_AGE`, and give a
   record's *original* owner a preferential reclaim window even after it goes stale
   (e.g. the `sameOwner` path should let the prior owner replace a stale record even
   if someone else grabbed it, keyed off a stable owner identity).
3. **Stable-identity ownership:** bind name ownership to a stable identity
   (the libp2p peerId from 0006, or a long-term signing key) and require proof of that
   identity to *transfer* a name, so a lapse in re-publishing does not forfeit ownership.

Regardless of option: because name→peer trust is only as strong as this policy, the UI
should distinguish a **verified/pinned** contact from a **name-resolved, not-yet-pinned**
one, so a freshly-resolved username is not presented with the same trust as an
established, key-exchange-verified contact.

## Test coverage

Once a policy is chosen:
- A stale record's original owner can reclaim their name (if option 2/3).
- A different-peerId claimant is blocked/deprioritized per the chosen rule.
- UI marks a not-yet-pinned name-resolved contact distinctly from a verified one.
