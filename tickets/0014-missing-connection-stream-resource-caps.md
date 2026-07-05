# Missing connection/stream caps and per-peer rate limits on unauthenticated network surface

- **Area:** Core / Network (libp2p node config, protocol handlers) — DoS / availability
- **Severity:** Medium
- **Source:** Security scan — network/transport (malicious-peer / resource-exhaustion threat model)
- **Status:** Open

## Threat model

The client is open source and reachable by any peer that knows its peerId, directly
or **over relay circuits** (every app handler sets `runOnLimitedConnection: true`).
For a messenger, availability is a security property: a peer who can exhaust the
victim's connection table, stream slots, or CPU can knock them offline / make them
unreachable to real contacts. Complements the per-read byte bound in
[[0005-unbounded-inbound-stream-reads-dos]] (that caps *size per read*; this caps
*count of connections/streams* and *rate of unauthenticated work*).

## Findings

### 1. No inbound-connection cap, rate limit, or contact headroom

`node-factory.ts:376-378` sets the *only* connection cap:

```ts
connectionManager: { maxConnections: 100 },
```

There is no `maxIncomingConnections`, no inbound connection-rate limit / upgrade
throttle, and no reserved headroom for known contacts. So all 100 slots can be
consumed by inbound (including Sybil) connections, evicting real contacts and making
the victim unreachable.

The `connectionGater` (`connection-gater.ts`) helps only partially:
`denyInboundEncryptedConnection` blocks *blocked* peers always, and *unknown* peers
**only when `contact_mode === 'block'`** (`:31-37`) — not the default — and even then
only **after** the Noise handshake (so the crypto work is already spent, and the gate
is per-connection, not rate-limited).

### 2. No global inbound-stream cap; no explicit per-protocol `maxInboundStreams`

`yamux()` is used with defaults (`node-factory.ts:375`); no muxer-level inbound-stream
cap, and none of the app handlers set `maxInboundStreams` — only `ping` sets a limit,
and it's `maxOutboundStreams: 8` (`:339`).

The urgent gap is the **chat, bucket-nudge, and call-signal** handlers: no per-protocol
inbound-stream cap *and* unbounded reads (0005), so the multiplier is large. **File
transfer is not in the same bucket** — it lacks a handler-level `maxInboundStreams` too,
but already has real application-level protections: pre-auth global/per-peer leases and
post-auth serve leases (`file-handler.ts:119`, `:307`; `32/2` and `15/5` from
`constants.ts:340`), length-prefixed frame size caps and absolute per-frame read
deadlines (`frame-stream.ts:31`). Adding `maxInboundStreams` there is worthwhile for
consistency/defense-in-depth, but it is not the urgent unbounded-read risk.

### 3. `/chat` and `/call-signal` do unauthenticated pre-validation work

Both handlers **read and parse the full inbound stream before any validation**
(`message-handler.ts:810`, `:867`), gated only by `isBlocked`. That read/parse plus
stream-slot pressure is the primary DoS — describe it that way first. What happens
*after* the read differs between the two, and the distinction matters:

- `/chat` (`message-handler.ts:796-860`): genuinely runs `handleKeyExchange`
  (asymmetric crypto) for **any** peer (`:815`) — key exchange from an unknown peer is a
  legitimate first-contact flow, so the crypto work really is unauthenticated.
- `/call-signal` (`message-handler.ts:862-880`): `verifyIncomingCallSignal` checks
  `ensureDirectCallContact` (`:1374`) **before** signature verification (`:1402`), and
  group call signals validate eligibility/membership/identity before signature work
  (`group-call-signaling.ts:423`, `:466`). So for an unknown peer the only work is the
  unbounded read/parse — *not* arbitrary signature crypto. Frame call-signal as
  read/parse + slot exhaustion, not "signature work from any unknown peer."

Both are reachable over relay.

Note on the existing key-exchange rate limit: there is a per-peer key-exchange attempt
limit (`KEY_EXCHANGE_RATE_LIMIT_DEFAULT`; enforced in `authorizeContactRequest`,
`key-exchange.ts:806`, counting recent attempts at `:2479`), but it runs **after** the
envelope is read and after the initial-body decryption path (`:738`, `:758`) — it is
product/anti-spam behavior, not a pre-read transport resource cap, and does not bound
the read/parse/decrypt work this ticket is about.

### 4. Direct offline DHT validator decompresses/parses before any size cap

The DHT runs as a full server (`clientMode: false`), so its record validators are
**unauthenticated network-facing work** any peer can trigger with a PUT. The
group-offline validator caps the compressed value **before** decompressing —
`group-dht-validator.ts:53-57`: `if (value.length > GROUP_OFFLINE_STORE_MAX_COMPRESSED_BYTES) throw`.
The **direct-offline** validator does not: `offlineMessageValidator`
(`offline-message-validator.ts:81-124`) goes straight to `gunzipAsync(value)` + `JSON.parse`
at `:98-99` with no compressed-size ceiling. So a peer can PUT a small highly-compressed
value (decompression bomb) or an oversized value and force the validator to inflate/parse
it. Give direct offline a compressed-size ceiling before gunzip/parse (mirror the group
validator), and consider a **generic size ceiling for every DHT namespace validator**,
since they are all unauthenticated entry points.

### 5. Lower-severity notes

- **Nudge → offline-check has no explicit per-peer receive cooldown**
  (`message-handler.ts:1761-1790`): throttled by the known-contact gate
  (`isKnownNudgeSender`), a 4s debounce, and single-flight — so a *malicious contact*
  can sustain roughly one victim-side DHT GET per ~4s. Bounded to contacts and
  de-duplicated, but no hard rate limit.

## What's already well-bounded (for contrast)

- **File-transfer** pre-auth/serve uses a `LeasePool` with atomic global+per-peer
  caps (`32/2` pre-auth, `15/5` serve — `file-handler.ts:119-120`). This is the pattern
  the other unauthenticated handlers should adopt.
- **Reconnect controller** is timer-driven with threshold + 120s cooldown + single-flight
  (`reconnect-controller.ts`); remote churn cannot force reconnect loops.
- **Relay is client-only** — the node makes reservations but does not run
  `circuitRelayServer`, so it can't be abused as an open relay.

## Suggested fix

1. Set `connectionManager.maxIncomingConnections` and an inbound
   connection-rate/upgrade-timeout limit; reserve headroom so known contacts aren't
   evicted by an inbound flood.
2. Set explicit `maxInboundStreams` on the app protocol handlers — priority is
   **chat, bucket-nudge, call-signal**; add it to file-transfer too, but as
   defense-in-depth (it already has lease/frame bounds), not as the urgent fix.
3. Put a per-peer + global rate/concurrency limiter in front of the unauthenticated
   read/parse (and, for `/chat`, key-exchange crypto) — reuse the existing `LeasePool`
   pattern rather than relying on `isBlocked` alone. This is distinct from the existing
   post-read key-exchange attempt limit (Finding 3), which stays as anti-spam behavior.
4. Give the direct-offline DHT validator a compressed-size ceiling before gunzip/parse
   (mirror `group-dht-validator.ts:53-57`), and consider a generic size ceiling applied
   to every DHT namespace validator.
5. Add an explicit per-peer cooldown on nudge-triggered offline checks.

## Test coverage

Not currently covered. Add:
- Inbound connections beyond the incoming cap are rejected and known contacts retain
  reserved capacity under an inbound flood.
- A peer exceeding the per-protocol inbound-stream cap is throttled/reset.
- The `/chat` and `/call-signal` rate limiter rejects/queues excess unauthenticated
  attempts per peer.
- The direct-offline DHT validator rejects an oversized compressed value before
  attempting to decompress/parse it.
