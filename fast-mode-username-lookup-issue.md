# Fast-mode username lookup fails: "User not found" for an online, registered user

## Symptom

In **fast mode**, two clients (`marin` and `darin`) each register a username
successfully, but neither can find the other when sending a message. The send
fails immediately with `User '<name>' not found`.

```
[IPC] Sending message to marin: oi
[USERNAME][LOOKUP][READ] key=marin events=8 values=0 firstValueMs=none tookMs=393 found=no
[USERNAME][LOOKUP][MISS] key=marin
Failed to send message to marin: User 'marin' not found
```

The lookup walk is fast and healthy (reaches 8 peers in ~400 ms) — it just
never finds a node holding the record.

## What this is NOT

- **Not the username lookup logic.** The walk runs fine; it returns zero values
  because no reachable node serves the record.
- **Not a recent self-dial gater change.** We added a `denyDialMultiaddr` guard
  that blocks dialing our own peer ID (to stop wasted Tor circuits on a separate
  bug). Verified it is exonerated here: the `[ConnectionGater] Blocked outbound
  dial to self` log never fires in the failing sessions, and `getPeerId()`
  returns the *target* peer ID for circuit addresses, so only genuine self-dials
  are blocked. It does not touch fast-mode bootstrap/relay/peer dials.
- **Not "registration failed."** Registration reports success — but see below,
  that success is weaker than it looks.

## Key finding 1: "Successfully registered" ≠ "record stored on a reachable node"

Registration path: `register` → `publishRegistrationPair` → `publishRecord`
(`src/core/username/username-registry.ts`).

A publish is only treated as a **failure** by `getPublishFailureError` when
`acceptedCount === 0` **and** (`rejectedCount > 0` or `errorCount > 0`). If the
PUT walk reaches **zero** peers (`accepted=0, rejected=0, errors=0`), it returns
`null` → no error → "Stored records" logs → the UI says success. `publishRecord`
also never logged its counts, so the success line told us nothing about where
the record actually landed.

We added a temporary `[TEMP_LOG][USERNAME][PUBLISH]` line to surface the counts
and the responding peers.

## Key finding 2: the record publishes to exactly one reachable node

marin's registration (both the username-key PUT and the peerID-key PUT):

```
[TEMP_LOG][USERNAME][PUBLISH] complete accepted=1 rejected=1 errors=4 tookMs=1001 accepted[WWggddVu] rejected[WWggddVu] errors[MpDTs28u,TcUWViuZ,MpDTs28u,TcUWViuZ]
[TEMP_LOG][USERNAME][PUBLISH] complete accepted=1 rejected=1 errors=6 tookMs=1001 accepted[WWggddVu] rejected[WWggddVu] errors[857Avfxi,gNfoZ7bR,w3q7uhes,857Avfxi,gNfoZ7bR,w3q7uhes]
```

The same shape appeared for darin's registration.

### Interpreting these counts correctly

Reading kad-dht `put()` (`node_modules/@libp2p/kad-dht/dist/src/content-fetching/index.js:105`):

1. Store record **locally** (always).
2. `getClosestPeers(key)` — a walk. Every contacted peer emits a `PEER_RESPONSE`
   with `closerPeers` and **no record** during this phase.
3. For each `FINAL_PEER`, send `PUT_VALUE`. If the peer does **not** echo the
   stored value back, kad-dht emits a synthetic `QUERY_ERROR` *"Value not put
   correctly."*

Our counter classified any `PEER_RESPONSE` with `record == null` as "rejected",
so **`rejected` here is mostly lookup-phase noise, not a validator refusal.** The
meaningful signals are:

- **`accepted[WWggddVu]`** — `WWggddVu` echoed the value back and got **no**
  "Value not put correctly" error → it **actually stored the record**.
- **`errors[...]`** — every *other* candidate peer (the ones genuinely closest to
  the key) is **unreachable**: `MpDTs28u, TcUWViuZ, 857Avfxi, gNfoZ7bR, w3q7uhes`.

So marin's record exists in exactly two places: **marin's local datastore** and
**`WWggddVu`**.

### Who is who

| Peer                 | Peer ID suffix |
| -------------------- | -------------- |
| relay                | `44E8q83x`     |
| darin (client)       | `kN3gdWu9`     |
| marin (client)       | `GhQrX4fb`     |
| `WWggddVu`           | **unknown — most likely the bootstrap (to confirm)** |

`WWggddVu` is not the relay and not either client, so it is almost certainly the
**bootstrap**. The nodes actually closest to the key (`MpDTs28u`, etc.) are
unreachable — consistent with both clients being NAT'd with no advertised
circuit address (marin's own log showed `[CONFIG][FAST][RELAY] localCircuitAddrs=0`
despite a successful relay reservation).

## The open question (what the next log answers)

If the record sits on the bootstrap and **both** clients talk to that same
bootstrap, darin's GET *should* retrieve marin's record — yet it returns
`values=0`. Two possibilities remain, and they lead to different fixes:

1. **The lookup never queries `WWggddVu`.** darin's walk heads toward the
   *unreachable* closest peers and terminates before asking the bootstrap for the
   value. → Small-network **routing/reachability** problem: the record lives on a
   node the looker-up doesn't consult.
2. **`WWggddVu` is queried but does not serve the record.** It accepted the
   `PUT_VALUE` echo but isn't persisting/serving it on GET (record expired, not
   persisted, or a GET-side namespace/selector/validator mismatch on the server).
   → **Server-side storage/serving** problem.

To disambiguate we added a temporary lookup-side log:

```
[TEMP_LOG][USERNAME][LOOKUP][PEERS] key=marin responded[...] values[...] errors[...]
```

- If `WWggddVu` is in `responded[]` but not in `values[]` → case 2 (server not
  serving the record).
- If `WWggddVu` is absent from `responded[]` → case 1 (looker-up never asks the
  holder).

## Root-cause shape (current best understanding)

This is a **fast-mode DHT storage/reachability topology issue**, not an
application lookup bug:

- Both clients are NAT'd and effectively undialable (no advertised circuit
  address even after a relay reservation).
- The DHT's "closest peers to the key" are unreachable, so a record only ever
  lands on whatever reachable node happens to be in the query path (here,
  `WWggddVu` / probably the bootstrap) plus the publisher's local store.
- For lookups to work reliably, there must be a **stable, reachable DHT node that
  both clients consult AND that persists+serves these records**. The next log
  confirms whether the bootstrap is that node or not.

## Open questions for infra

1. What is the bootstrap's peer ID — is it `WWggddVu`?
2. Are both clients connected to the **same** bootstrap?
3. Is the deployed bootstrap running the current build (same `kiyeovo-fast` DHT
   protocol, same username validators/selectors) and **persisting** DHT records
   across the GET path?
4. Why do NAT'd fast-mode clients end up with `localCircuitAddrs=0` despite a
   successful relay reservation? (Undialable peers make the DHT replica set
   collapse to "the bootstrap + local store.")

## Temporary instrumentation added (to strip once resolved)

- `src/core/username/username-registry.ts` — `[TEMP_LOG][USERNAME][PUBLISH]`
  (accept/reject/error counts + responding peer suffixes in `publishRecord`).
- `src/core/username/username-registry.ts` — `[TEMP_LOG][USERNAME][LOOKUP][PEERS]`
  (responded/values/errors peer suffixes in `readRegistrationForKey`).
