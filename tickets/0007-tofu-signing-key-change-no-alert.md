# No trust-on-first-use alert: pinned signing/offline key is silently overwritten from the DHT

- **Area:** Core / Identity + Key exchange
- **Severity:** Low–Medium
- **Source:** Security scan — identity & key-exchange (malicious-peer threat model)
- **Status:** Open

## Summary

When a signature from a known contact fails to verify against the **pinned** DB
signing key, the code does not reject or warn — it silently re-fetches the key from
the DHT and **overwrites the pinned key**. Legitimate key rotation and attacker key
substitution are therefore indistinguishable to the user, which defeats the security
value of pinning (trust-on-first-use with no alarm on change is just
trust-on-every-use).

**The overwrite is worse than "adopt on successful re-verification": in
`verifySignatureWithFallback` the DB write is unconditional — it happens even when the
refreshed key ALSO fails to verify.** At `key-exchange.ts:251` `valid` is computed
against the DHT key, but the `updateUserKeys` / `createUser` write at `:255-270` is not
guarded by `if (valid)` — it runs regardless — and the function then returns
`{ valid, ... }`. So a mere DHT lookup returning *any* record for the peer replaces the
pinned signing/offline keys even on a failed-signature message. A pinned key is not
stable state.

## Location

- `src/core/direct/key-exchange.ts:227-277` (`verifySignatureWithFallback`): on pinned
  verification failure, falls through to the DHT lookup and writes the DHT key back via
  `updateUserKeys` / `createUser` (`:255-270`) — **unconditionally, before/regardless of
  the `valid` result computed at `:251`**.
- `src/core/direct/key-exchange.ts:1039-1056` (`verifyKeyExchangeInitSignature`) +
  `:1082-1092` (`ensureUserExistsWithKeys`): also overwrites a differing pinned key after
  a DHT refresh. (This path recomputes `signatureValid` against the refreshed key and
  assigns it only inside the `refreshed.peerID === remoteId` guard, so it is less
  egregious than the `verifySignatureWithFallback` unconditional write — but it still
  adopts a changed key with no alert.)

## Scope / how bad

Both call sites are anchored to the **transport-authenticated `remoteId`**, and the
DHT fallbacks require `record.peerID === remoteId`. So an attacker cannot use a live
connection to overwrite the key for *another* peer's peerId — they would need that
peer's libp2p private key. That transport anchoring is what keeps this from being a
direct live-impersonation vector, and why the severity is Low–Medium rather than High.

Its real impact is:
- Loss of a change-alert: a user is never told when a contact's identity key changed,
  so a substitution (e.g. via a poisoned DHT record — see
  [[0006-dht-username-record-missing-peerid-libp2p-binding]]) or a suspicious rotation
  passes silently.
- It compounds ticket 0006 on the **non-transport-anchored** offline path, where the
  adopted key is later used to verify/encrypt without a live Noise connection to anchor
  identity.

## Expected behavior

Treat a change to a previously-pinned identity key as a security-relevant event:
surface it to the user and require acknowledgement (or block until confirmed), rather
than adopting it silently. Distinguish an authenticated, rate-limited **rotation**
(signed by the *currently pinned* key) from an unsolicited key *replacement* (signed
only by the new key), and only auto-accept the former.

## Suggested fix

1. **Immediate (correctness):** never mutate pinned keys in `verifySignatureWithFallback`
   before verification succeeds. Move the `updateUserKeys` / `createUser` write inside
   the `if (valid)` branch, so a failed-signature fallback cannot rewrite pinned state.
   This is a concrete acceptance criterion independent of the larger design work.
2. Do not overwrite an *existing* pinned `signing_public_key` purely because a new
   signature verifies against a DHT-fetched key. If the pinned key exists and the
   incoming signature fails against it, treat it as a key-change event.
3. Accept a new long-term key automatically only when it arrives through the
   authenticated rotation flow (signed by the current pinned key). For any other
   change, record it and raise a UI alert ("This contact's security key changed"),
   gating further messaging on user confirmation.
4. Keep an audit trail (old key, new key, timestamp, source) to support the alert and
   later review.

## Test coverage

Not currently covered. Add:
- A fallback where the refreshed DHT key ALSO fails to verify (`valid === false`) does
  NOT write to `updateUserKeys` / `createUser` — pinned state is unchanged.
- A signature that fails against the pinned key but verifies against a *different*
  DHT key does NOT silently replace the pinned key; it raises a change event and does
  not mark the message as verified-from-that-contact without confirmation.
- An authenticated rotation signed by the current pinned key IS accepted without an
  alert.
