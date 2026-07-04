# Unbounded inbound stream reads → unauthenticated remote memory-exhaustion DoS

- **Area:** Core / Transport (P2P message ingestion)
- **Severity:** High
- **Source:** Security scan — inbound message ingestion (malicious-peer threat model)
- **Status:** Open

## Threat model

The client is open source, so any remote peer may run a modified client that
ignores all sender-side limits. Every inbound stream must be treated as
attacker-controlled and bounded on the receiving side.

## Summary

All inbound libp2p stream reads drain the *entire* stream into memory with no
byte cap before any size validation runs. `StreamHandler.readMessageFromStream`
buffers every chunk, allocates a second full-size copy, then `JSON.parse`s the
whole thing. The `MAX_MESSAGE_CONTENT_LENGTH` (2048) cap only applies far
downstream in `isTextPayload`, after decryption — it never protects the read.

Critically, on the `/chat` protocol the unbounded read happens **before
authentication**: the only gate ahead of it is the block-list check; the session
lookup that would reject an unknown peer runs *after* the full stream has been
read. With `runOnLimitedConnection: true`, any peer that knows the victim's
peerId — reachable directly or via relay, with no prior relationship or key
exchange — can open a `/chat` stream, send arbitrarily large data, and force an
out-of-memory crash on demand.

## Location

Shared read helper (root cause):
- `src/core/transport/stream-handler.ts:7-25` (`readMessageFromStream`) — `for await`
  over `stream.source` with no accumulated-length check; then `new Uint8Array(totalLength)`
  (second full copy); then `JSON.parse` of the whole payload.

Unauthenticated reachability:
- `src/core/lib/message-handler.ts:796-828` (`chatProtocol` handler) — `readMessageFromStream`
  at `:810` runs after only `isBlocked(remoteId)` (`:800`); the `getSession` /
  "no active session" drop is at `:824-828`, i.e. *after* the read. Registered with
  `runOnLimitedConnection: true` (`:859`).

Same unbounded pattern (defense-in-depth, fix alongside):
- `src/core/lib/message-handler.ts:2011-2016` (`readBucketNudgePayload`).
- `src/core/lib/message-handler.ts:867` (call-signal read).
- `src/core/direct/key-exchange.ts:1342` and `:1660` (key-exchange reads).

No transport-level byte cap exists to backstop this: `src/core/network/node-factory.ts`
sets only `maxOutboundStreams` (on ping), no per-stream inbound byte limit.

## Steps to reproduce

1. Learn the victim's peerId (public; it is how anyone reaches them).
2. Dial the victim (directly or via a relay) and open the `/chat` protocol stream.
3. Without performing a key exchange, stream a large payload (e.g. hundreds of MB
   to a few GB) into the stream and let the handler read it.
4. The victim buffers the entire stream (plus a second copy) before any session
   or size check → memory exhaustion / OOM crash.

## Expected behavior

Reject oversized inbound streams early, before buffering the whole payload and
before any parse/decrypt. A peer with no session should not be able to make the
client allocate unbounded memory.

## Suggested fix

1. Enforce a byte ceiling *inside* the shared read helper so every protocol
   inherits it. Accumulate length in the read loop and abort (close/reset the
   stream) as soon as it exceeds the cap, instead of checking after the fact:

   ```ts
   static async readMessageFromStream<T>(stream: Stream, maxBytes: number): Promise<T> {
     const chunks: Uint8Array[] = [];
     let total = 0;
     for await (const chunk of stream.source) {
       const bytes = (chunk as any).subarray() as Uint8Array;
       total += bytes.length;
       if (total > maxBytes) {
         try { await stream.abort?.(new Error('inbound message exceeds cap')); } catch {}
         throw new Error('inbound message exceeds cap');
       }
       chunks.push(bytes);
     }
     // ...assemble + JSON.parse as before
   }
   ```

2. Use a **protocol-specific envelope cap**, not one small shared value — size each
   from the actual envelope. Chat and bucket-nudge can be small (text cap is 2048
   chars). **Call-signal needs a larger cap** because it carries WebRTC SDP, which is
   routinely larger than "a few KB"; pick a bound from realistic SDP sizes. Key-exchange
   envelopes carry RSA-wrapped bodies and should be sized accordingly. Pass the
   appropriate cap per call site rather than assuming one maximum fits every handler.

3. Pair with a read timeout (see "Related — read timeout" below) so a peer cannot hold
   a stream open indefinitely by dribbling bytes.

## Related — read timeout (fold in or split out)

There is also no time bound on inbound reads: a peer can open a `/chat` (or
call-signal) stream and send bytes slowly, or never close, pinning the handler
and a stream slot (slowloris-style). Wrap the read in an abort-after-timeout. This is
the same class of resource-exhaustion issue and is cheapest to fix together with the
byte cap.

**The timeout must abort/reset the underlying stream — a `Promise.race` alone is not
sufficient.** If you only race the read promise against a timer, the losing branch (the
`for await` over `stream.source`) keeps running and keeps buffering bytes after the
timeout "wins"; the memory/slot pressure is not actually relieved. The timeout handler
must call `stream.abort(...)` (or reset) so the source iteration stops. Note there is
already a key-exchange path that races a timeout around `readMessageFromStream`
(`src/core/direct/key-exchange.ts:1342`) — that pattern should **not** be copied as-is,
because it does not guarantee the stream source is aborted on timeout.

## Also clean up

`src/core/transport/stream-handler.ts:27-36` (`readFileFromStream`) is dead code
(no non-test callers): it is uncapped *and* writes attacker-supplied bytes to a
hardcoded CWD-relative path `gottenfile.txt`. Delete it, or if it is ever
revived, give it the same bound + a validated destination path.

## Test coverage

Not currently covered. Add transport-level tests:
- `readMessageFromStream` aborts and throws once the accumulated byte count
  exceeds the cap, without buffering the whole oversized payload.
- A read that stalls past the timeout is aborted.
- Regression: a normal-sized envelope still round-trips.
