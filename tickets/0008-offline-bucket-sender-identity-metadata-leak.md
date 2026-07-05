# Offline DHT bucket key leaks the sender's stable identity + social-graph out-degree

- **Area:** Core / Direct (offline messages, DHT) — privacy/metadata
- **Severity:** Low–Medium
- **Source:** Security scan — offline message bucket path (malicious-peer threat model)
- **Status:** Open

## Threat model

The client is open source and the DHT is public: any node can become a storage
node for arbitrary keys and inspect the records it holds. For a privacy-focused
messenger (especially anonymous/Tor mode), metadata that identifies *who is
messaging* and *how much* is part of the threat surface, even when message
*content* is encrypted.

## Summary

The offline-bucket DHT key is:

```
<mode>-offline / <offlineBucketSecret> / <senderSigningPublicKey base64url>
```

The final path segment is the sender's **stable ed25519 signing public key, in
cleartext** — the *same* key that signs their username registry records, so it is
publicly linkable to that user's identity. It is identical across **all** of that
sender's offline buckets to every contact.

A DHT node that stores multiple offline records can therefore group records by the
suffix to learn, without decrypting anything:

- **Sender identity** — the suffix key maps directly to a known username via the
  username registry.
- **Offline out-degree / social graph (partial)** — the number of distinct
  `<offlineBucketSecret>` values sharing one sender key ≈ the sender's number of
  offline conversation partners.
- **Activity envelope** — per bucket: message counts, `timestamp`s, record `version`,
  `message_type`, record sizes, and message UUIDs.

The *recipient* side is not leaked: `<offlineBucketSecret>` is an HKDF output over an
ECDH shared secret (`deriveOfflineBucketSecret`), unlinkable to a recipient identity.
So this is a one-sided leak of the **sender's** identity and out-degree, not the full
pair — but a stable, de-anonymizing sender identifier in a plaintext DHT key still
undercuts the privacy claim.

## Location

- `src/core/direct/key-exchange.ts:329-336` (`constructWriteBucketKey` — suffix =
  `toBase64Url(userIdentity.signingPublicKey)`), `:338-342` (`constructReadBucketKey`),
  `:309-327` (`deriveOfflineBucketSecret`).
- Suffix parsed/enforced on the DHT side at
  `src/core/direct/offline-message-validator.ts:126-143`
  (`parseOfflineBucketSenderPubKeyBase64Url`) — the validator needs the suffix to be
  the signer's pubkey, which is why it is currently in the clear.

## Expected behavior

A storage node should not be able to recover the sender's stable public identity or
count their offline conversation partners from the bucket key alone.

## Suggested fix (needs design)

**The core tension:** the suffix is in the clear precisely because the *public* DHT
validator uses it as the verification key to gate writes (a node that has never met
either party still rejects a store not signed by the key in the slot). Any fix trades
against that:

- If the sender's verifying key stays readable in the record/slot, a storage node can
  still read it — no metadata win.
- If it is hidden/encrypted, the public validator can no longer use it, so public
  write-authorization has to be replaced by something that does not reveal a stable
  global identity.

So the fix is fundamentally "how much public write-validation are we willing to give
up to hide the sender identity," and it may legitimately differ by mode. Options to
evaluate:

1. **Per-pair pseudonymous tag + recipient-side verification.** Replace the raw-pubkey
   suffix with a tag derived from the shared secret (e.g. `HKDF(sharedSecret,
   "offline-sender-tag")`), bind writes with a per-pair capability/MAC instead of a
   global public key, and have the **recipient** verify sender identity *after* fetch
   using the locally pinned key from the key-exchange-verified `users` table (the reader
   already sources the true key from there, not from the record). This accepts weaker
   public validation in exchange for hiding the stable identifier while keeping
   per-direction partitioning.
2. **Deterministic-but-opaque suffix**: derive the suffix from `HKDF(sharedSecret,
   senderPubKey)` so both parties still compute it, but it no longer equals the
   globally-linkable signing key. (Public validation still weakens, since the validator
   can't recover the signing key from the slot.)
3. **Mode-specific semantics**: keep global public-key validation in fast mode, apply a
   metadata-hiding scheme in anonymous mode — if product policy accepts different
   guarantees per mode (see Group B priority: decide the anonymous-mode privacy target).

Whatever is chosen, confirm write-authorization still prevents a third party from
writing/overwriting a bucket direction without publishing that party's stable public
key in the DHT key.

## Related lower-priority notes (fold in, not separate tickets)

- **Unsigned record fields (Low, hardening):** the **store** signature now binds the
  message-id list (so id, order, and count *are* covered at the store level), plus
  `version`, `last_updated`, and `bucket_key` (`offline-message-validator.ts:164-235`);
  the **per-message** signed payload is `{content_hash, sender_info_hash, timestamp,
  bucket_key}` (`offline-message-manager.ts:478-500`). The fields left outside *both*
  signatures are `encrypted_aes_key`, `aes_iv`, `message_type`, and `expires_at`. The
  validator independently bounds `expires_at`/TTL, so the practical residual is the AES
  fields (next note). Sign the whole record for defense-in-depth.

- **Tampered AES fields let a replica corrupt/suppress a targeted message (Low,
  adversarial reliability):** this is stronger than a pure reliability bug. On read, the
  full signed store is **not** re-verified — `getOfflineMessages` iterates raw `dht.get`
  VALUE events and applies only the structural `isValidOfflineMessage` filter
  (`offline-message-manager.ts:194-238`); per-message verification
  (`verifyOfflineMessageSignature`, `:510`) covers `content_hash` but **not**
  `encrypted_aes_key` / `aes_iv`. So a malicious replica of the victim's bucket can
  tamper those unsigned fields on one hybrid message: the signature still passes,
  `decryptOfflineMessage` fails, and — because it returns a `"[Failed to decrypt…]"`
  *string* rather than throwing — the placeholder is **saved** and the cursor advances
  (`message-handler.ts:3554-3608`). `offline_last_read_timestamp` then moves to the max
  processed timestamp (`:3622-3625`), so on a later pass the honest copy of that message
  is `<= lastRead` (`:3498`) or hits `messageExists` dedup (`:3586`) and is never
  delivered. Net: a replica node can permanently replace a specific hybrid message
  (>214 bytes) with a decrypt-failure placeholder. Low severity (requires being a
  replica for that bucket; hybrid messages only; visible-but-corrupt), but real
  adversarial leverage — fixed by signing the whole record and/or re-verifying the store
  signature on fetch.

## Test coverage

Not currently covered. Once a design is chosen:
- Two offline buckets from the same sender to different recipients do not share a
  common linkable key segment.
- The DHT validator still rejects a store not signed by the owner of that bucket
  direction.
- (Hardening) tampering an unsigned field on a stored record is detected or bounded.
