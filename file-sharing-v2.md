# File sharing v2 — Option B: pull model + group sharing, session-bound offers

> **Scope note.** This is the trimmed **Option B**. The primary goal is **group file sharing**
> (net-new). Offers are **session-bound** (in-RAM, die when the sender process exits) — we
> deliberately drop the cross-restart "sticky offer" persistence + GC stack. See **"Removed from
> scope"** at the end for what was cut and how to re-add it later (it's additive).

## Goals

1. **Group file sharing (primary, net-new)** — offer a file to a group; each member decides and
   pulls independently. Today files are 1:1-only; this is the capability that doesn't exist yet.
2. **No 5-minute acceptance pressure** — the recipient can accept for as long as the **sender's
   process is online**, not a fixed countdown. (Not cross-restart — see Goal-3 note.)
3. **Best-effort async *notification*** — the offer is delivered like any message, so it can
   appear after the recipient was offline. But the recipient must be **online to accept**, and if
   the sender has since gone offline the offer is dead-on-arrival. Delivery is best-effort under
   bucket retention (group bucket = 50 msgs, trims oldest; direct = ~30) — **not** guaranteed.

## The core move

Split the single held-open stream into **(a) a fire-and-forget offer message** and **(b) a
recipient-initiated pull transfer stream**.

- The **offer** is an ordinary signed application message (carried in a typed envelope — see
  below). Send it and forget it. For an offline recipient it rides the existing offline bucket
  and appears on next inbox check (best-effort, Goal 3).
- The **transfer** happens when the recipient **accepts**: the recipient dials the sender, sends
  `FilePullInit{offerId}` as the first frame (then a signed challenge-response — decision 4), and
  the sender streams chunks back. Accept *is*
  the dial.
- A **group** offer is one message to the group; each member who wants the file independently
  dials and pulls. No fan-out coordination. Bytes ride the Noise-encrypted connection between the
  two peers, authorized by an app-key challenge-response (decision 4), so no group key touches file
  bytes.

## Locked decisions

1. **Pull model.** Sender offers; recipient dials and pulls; sender streams bytes.
2. **In-RAM, process-bound served-file registry (NOT persisted).** The registry holds, per offer:
   `offerId, fileId, filePath, size, checksum, authorizedPullers (in-RAM Map peerId→app key),
   chatId, isGroup`. It
   lives only in memory:
   - survives a **transient network blip** (registry stays in RAM; offer revives on reconnect);
   - **dies on sender restart/quit** → recipient pull returns `unavailable`; re-offer to revive.
   **Startup reconciliation must be split by direction/state + mode-scoped.**
   `failNonTerminalFileTransfers` (`database.ts:2501`) today fails **`incoming_pending_user`** rows
   too — which would wrongly kill the recipient's still-valid pending offers on a *recipient*
   restart. Fix: fail only genuinely-interrupted *active* transfers (`in_progress`/`connecting`/
   `downloading`/…), **preserve `incoming_pending_user`** (a recipient-side notification that
   outlives the process), and scope to the active network mode. **No new tables for serving
   authority** (it's in-RAM); the chat-history/reply row stays in `messages` (see "Serving authority
   vs message history"). The feature's only new table is the small mode-scoped tombstone table
   (Cancellation).
3. **Lazy disk read at pull time + verify.** The registry holds `filePath`, not a buffer. `size`
   +`checksum` are computed once at offer time (transient read; the offer already carries the
   checksum the recipient verifies against), then discarded. On pull, re-read `filePath`, verify
   `size`+`checksum`, then chunk. Within a session the file can still be moved/deleted between
   offer and pull → `FilePullReject{source_changed}`. Benefit: an outstanding offer holds only a
   path, so resident RAM is bounded by `MAX_CONCURRENT_FILE_SERVES × MAX_FILE_SIZE`, not by the
   number of pending offers.
4. **Transfer encryption & authorization — Noise confidentiality + app-key challenge-response
   (DECIDED).** Confidentiality/integrity ride libp2p **Noise** (E2E, forward-secret *at the
   connection level* — per-connection, **not** per-pull: streams are multiplexed and `dialProtocol`
   may reuse an existing connection, so there is no fresh handshake per transfer). Authorization is
   a **challenge-response signed with the recipient's application signing key** — a second identity
   root, separate from the libp2p identity key (`identity/encrypted-user-identity.ts:110`) —
   verified by the sender against the app public key it **snapshotted at offer time**. This yields a
   **two-key rule:** a pull requires *Noise/libp2p identity possession* **AND** *app signing-key
   possession* **AND** *membership in the offer's authorization snapshot*; compromising either key
   alone is insufficient. It needs **no pairwise session/KX** (so group non-contacts work — the app
   layer is contact-scoped and `message-handler.ts:2279` rejects file-session setup without a direct
   chat), no expiring sessions, no second byte-encryption layer, and behaves identically over TCP /
   relay / Tor. **Per-pull byte-key isolation is out of scope** (gold-plating; would need a derived
   per-transfer key). The sender-generated *challenge* (not a recipient-only nonce) gives replay
   resistance with no replay cache.
5. **No store-and-forward blob server.** The true never-both-online case stays unsupported.
6. **File-size limit is network-mode-aware (Phase 3).** `fast` mode → **100MB**, `anonymous`
   stays ~10MB. Phase 1/2 stay at 10MB everywhere (RAM-bound until streaming). Resume is skipped
   at 100MB (a dropped transfer just restarts).
7. **Offer lifecycle in Option B (no GC machinery, but explicit cleanup).** Offers die with the
   sender process (no acceptance timer, no TTL sweep, no auto-recycle). Recipient-side stale rows
   are handled lazily: a pull against a gone offer fails `unavailable` and the row goes terminal.
   But two things are required, not optional (see "Lifecycle gates & cleanup"): (a) **remove the
   `expiresAt` acceptance gates** — current offer validation requires `expiresAt` and the renderer
   independently expires rows (`MessagesContainer.tsx:73`, `Main.tsx:551`); those gates/countdowns
   must go. (b) **Explicit registry/pending-row cleanup** on chat delete/block, group
   leave/disband/remove, remote member leave (not just kick), and identity logout/core cleanup —
   otherwise a long-running process retains ignored offers indefinitely.
8. **Independent sender and recipient offer caps.** A conforming sender may keep at most
   `MAX_ACTIVE_FILE_OFFERS_PER_CHAT = 5` live registry entries for one chat. For a direct chat this
   is five offers to that peer; for a group, one group offer consumes one chat slot regardless of
   the number of authorized pullers. `ServedFileRegistry` owns and atomically enforces this cap:
   the count-and-insert is a **synchronous reservation that runs before any `await`** (file I/O,
   row persistence, transport) — otherwise two concurrent sends could both pass the check during an
   `await` gap and exceed five. The sixth send fails locally before a message row or network
   message is created, and it never evicts an older offer. A slot remains occupied while the
   registry entry can authorize a pull and is released on send rollback, sender withdrawal,
   explicit lifecycle cleanup, or process exit. **Direct** slots additionally release on terminal
   NACK or successful consumption (a single puller). **Group** slots cannot release on decline —
   group decline is **silent** (no NACK), so the sender never learns a member declined; a group
   slot releases only once every *still-authorized* member has successfully pulled, or via
   membership revocation (a removed member is dropped from `authorizedPullers`) or sender
   withdrawal. A single member's pull never frees a slot the rest can still use. The
   existing recipient caps (five **fresh** pending offers per sender and ten **fresh** pending offers
   total) remain an independent trust boundary and are checked for every realtime or
   offline-catch-up offer; retryable/error pending rows stay visible but do not consume that capacity.
   A hostile peer cannot bypass the caps by ignoring the sender rule. A lost best-effort control may therefore leave a
   sender slot occupied until manual withdrawal or restart, so the **withdrawal affordance must
   ship before or together with this cap** — without it a user can become unable to send a sixth
   offer with no recovery short of restart.

---

## Current architecture (starting point)

`src/core/lib/file-handler.ts` is **single-stream, push-model, 1:1-only**:

- `sendFile` (`:828`) opens one stream and does everything on it: pushes offer → blocks on offer
  response → pushes all chunks → blocks on completion confirm (`:845-970`).
- `#handleIncomingFile` (`:364`) holds that same stream open across the user decision
  (`#waitForIncomingOfferDecision`, `:1431`), bounded by `FILE_ACCEPTANCE_TIMEOUT`
  (`constants.ts:311`, 5 min), then receives chunks (`:512-581`).
- 1:1 enforced: `chat?.type !== 'direct'` throws on send (`:1067`); receiver requires a direct
  chat + session (`:1376-1383`).
- Whole file in RAM both sides; receiver buffers all chunks then `Buffer.concat` (`:595-601`).

Two facts the rewrite must respect:
- **Sessions are in-memory and expire after 5 min** (`SESSION_TIMEOUT = 5 * MINUTE`,
  `direct/session-manager.ts:9`) — this is why "encrypt with the existing pairwise session" can't
  be assumed for a pull (decision 4).
- **File rows live in `messages`** (`#persistOutgoingPendingTransferMessage` → `createMessage`),
  there is **no `offered` status** (`types.ts:281`), and the row lacks checksum/mime/chunks/etc.
  So serving authority must **not** be a `messages` row — keep it in the in-RAM registry.

---

## Serving authority vs message history (resolves the "delete nukes history" trap)

Two separate things, deliberately decoupled:

- **Chat-history / reply anchor** = the existing `messages` row (`message_type:'file'`,
  `client_msg_id = fileId`). This is what reply/jump and search use. The row is **never deleted by
  offer lifecycle** — reject/cancel/expire flip it to a **terminal status** (`rejected` /
  `cancelled` / `failed`), they don't remove it (resolves the earlier "drop the row locally"
  contradiction). A withdrawn/declined file leaves a coherent trace and reply anchors survive.
- **Serving authority** = the in-RAM registry entry, keyed by **`offerId`** (a fresh random id per
  offer — see "Re-offer identity"). Holds `filePath`, `authorizedPullers`, verification metadata.
  Created on offer, dropped on complete/cancel/process-exit.

**Recipient must persist enough to pull *and verify* across a recipient restart** (the offer is a
notification that outlives the recipient process). On the pending file message store, via the
repo's `ensureColumnExists` pattern (nullable columns; the only new table in the whole feature is
the tiny tombstone table — see Cancellation):
- `file_offer_id` — the pull/cancel/nack key, distinct from the content `fileId`.
- `checksum`, `total_chunks`, and the **protocol/envelope version** — so checksum verification and
  framing don't depend on transient sender memory. (Today the `messages` row lacks these.)

**Fresh `fileId` *and* `offerId` per offer.** The history row uses `id = client_msg_id = fileId`
and outbound inserts **throw** on a cid collision (`database.ts:2246`), so a re-offer must mint a
new `fileId` too — the same source bytes don't need a stable content id.

**Explicit ID mapping (pick one, consistently):**
- `fileId` = the message **row id** / client CID / group message id (history + reply anchor).
- `offerId` = the **capability** inside the offer payload + the pull/cancel/nack/auth key
  (persisted on the row as `file_offer_id`).
- **UI/IPC actions pass `fileId`; the core resolves `fileId → offerId`** via `file_offer_id`
  (chosen: least renderer churn — the renderer already identifies messages by their row id, and the
  capability mapping lives in one place in core).

---

## Typed application-message envelope + dispatcher (NEW — Phase 0 prerequisite)

Today every direct/group receive path decodes content as **text** (`message-handler.ts:811`,
`:3793`; `group/runtime/group-messaging.ts:270`, `:995`). "The offer is just a message" therefore
requires a real subsystem first:

- **Use one strict version-1 application envelope**: `{ v:1, cid, kind, payload }`, where `kind` is
  `'text' | 'file_offer' | 'file_offer_cancel' | 'file_offer_nack'`. Missing envelopes, missing or
  unknown `kind` values, unsupported versions, and malformed payloads are **rejected/ignored —
  never rendered as text**. There is no pre-1.0 peer compatibility path.
- **One shared inbound decode dispatcher** run on every route — direct online, direct offline
  bucket, group realtime (gossipsub), group offline store (decode-as-text today at
  `message-handler.ts:811`/`:3793`, `group-messaging.ts:270`/`:995`) — routing by `kind`.
- **A domain-neutral *outbound* application-message API** (the review's catch — today direct
  offline send auto-creates a visible text row, `message-handler.ts:2624`, and group send mints a
  text message, `group-messaging.ts:266`; calling either from `offerFile` would double-persist or
  create stray text rows). The API must make explicit:
  - **caller-provided message/correlation id** (so `offerFile` controls `fileId`/`offerId`);
  - **who persists the visible row** — caller (offer: `offerFile` already writes the `messages`
    row) vs transport;
  - **online/offline dedup** keyed on that id;
  - **control messages create no visible row** (cancel/nack are invisible);
  - **group offline-backup behavior** for the typed payload.

This inbound dispatcher **and** outbound API are a hard prerequisite for offers, cancels, and nacks.

---

## Protocol frames (pull stream)

Reuse `fileTransferProtocol` (`constants.ts:54`); the **recipient dials**, first frame is the pull.
The pull path uses the normal protocol dialer/fallback behavior for the active network mode.

```
recipient → sender :  FilePullInit       { type:'file_pull_init', offerId }
sender    → recipient: FilePullChallenge  { type:'file_pull_challenge', offerId, challenge }      // random per-stream
recipient → sender :  FilePullAuth       { type:'file_pull_auth', offerId, senderPeerId, requesterPeerId, challenge, signature }
sender    → recipient (either):
                      FilePullReject      { type:'file_pull_reject', offerId, reason }
              or      FileChunk*          (stream of chunks)  // then sender ends its side
recipient → sender :  FileTransferConfirm { type:'file_transfer_confirm', offerId, success, reason? }
```

`FilePullAuth.signature` covers a **domain-separated, versioned** payload (Ed25519, app signing key):

```ts
{ domain: 'kiyeovo-file-pull-v2', offerId, senderPeerId, requesterPeerId, challenge }
```

`FilePullReject.reason`: `unauthorized` (peer ∉ authorizedPullers, or bad/absent app signature) ·
`unavailable` (offerId not in registry — never offered, withdrawn, or sender restarted) ·
`source_changed` (file no longer matches `size`+`checksum`) · `busy` (`MAX_CONCURRENT_FILE_SERVES`
reached; transient).

`FileTransferConfirm.reason`: present only when `success:false`; one of `integrity`, `disk`,
`other`, or `canceled`.

New types (`src/core/types.ts`):

```ts
export type FilePullRejectReason = 'unauthorized' | 'unavailable' | 'source_changed' | 'busy';
export interface FilePullInit       { type: 'file_pull_init'; offerId: string }
export interface FilePullChallenge  { type: 'file_pull_challenge'; offerId: string; challenge: string }   // base64 random
export interface FilePullAuth       { type: 'file_pull_auth'; offerId: string; senderPeerId: string; requesterPeerId: string; challenge: string; signature: string }
export interface FilePullReject     { type: 'file_pull_reject'; offerId: string; reason: FilePullRejectReason }
// New plaintext chunk frame (decision 4 = no app byte-encryption; Noise encrypts the wire):
export interface FileChunk          { type: 'file_chunk'; offerId: string; index: number; data: string; hash: string }
// Carried in the typed envelope (NOT pull-stream frames); signatures REQUIRED, domain-separated:
export interface FileOfferCancel    { type: 'file_offer_cancel'; offerId: string; signature: string }
export interface FileOfferNack      { type: 'file_offer_nack'; offerId: string; reason: string; signature: string }
```

`FileOfferResponse` (`:300`) and its round-trip are removed (accept is the dial).

**Chunk frame is plaintext-over-Noise (decision 4).** `data` is application **plaintext**;
confidentiality comes from the Noise connection, integrity from per-chunk `hash` (BLAKE3) +
full-file checksum. So **don't reuse `#createEncryptedChunks`** (`file-handler.ts:769`) — it
requires a `ConversationSession` and emits XChaCha nonces/ciphertext. **Extract `#createChunks`**
(no session, no nonce) producing the frame above. The cancel/nack signatures cover their own
domain-separated payloads (e.g. `{domain:'kiyeovo-file-cancel-v2', offerId}` /
`{domain:'kiyeovo-file-nack-v2', offerId, reason}`).

### Operational timeouts (removing the *acceptance* timer ≠ removing *operational* ones)

The serve handler MUST bound every wait and always release slots:
- **first-frame**: peer opens the stream but sends no `FilePullInit` (or stalls before
  `FilePullAuth`) → drop.
- **idle / chunk**: reuse `CHUNK_RECEIVE_TIMEOUT` / `CHUNK_IDLE_TIMEOUT` between chunks.
- **total-transfer**: hard cap so a slow-loris can't pin a slot forever.
- **confirm-wait**: bounded wait for `FileTransferConfirm` after the last chunk.
- **`finally` release** of the serve leases on every exit path: the global
  `MAX_CONCURRENT_FILE_SERVES` slot **and** the per-peer `MAX_CONCURRENT_FILE_SERVES_PER_PEER` slot
  (acquired all-or-nothing from a `LeasePool`), plus the offer serve lock. Direct offers are
  exclusive per offer. Group offers are exclusive only per requester: different members may pull the
  same offer concurrently, but a second concurrent pull by the *same* requester is rejected `busy`.
  Per-peer policy: a peer may serve up to `MAX_CONCURRENT_FILE_SERVES_PER_PEER` (5) concurrent
  pulls, while the requester-scoped group lock prevents a single member double-serving/double-counting
  the same offer.

---

## Sender: registry + serve handler

```ts
interface ServedFile {
  offerId: string
  fileId: string
  filePath: string
  size: number
  checksum: string
  authorizedPullers: Map<string, string>   // peerId → app Ed25519 signing pubkey (base64); snapshot at offer time
  chatId: number
  isGroup: boolean
}
private servedFiles = new Map<string, ServedFile>()   // keyed by offerId; in-RAM only
```

`authorizedPullers` is a **Map**, not a `Set`: it pins each authorized peer to the exact app
signing key accepted for it, snapshotted at offer time from the direct-contact record (1:1) or the
group roster (`GroupRosterEntry.signingPubKey`, `group/types.ts:150`). Pinning the key in the
snapshot makes the authority explicit and prevents a later mutable DB lookup from silently changing
which key is accepted.

- **`offerFile(...)`** — transient read to compute `size`+`checksum`, validate size, **snapshot
  `authorizedPullers` (peerId → app signing pubkey) from the contact record (1:1) or group roster
  (`group/types.ts:150`)**, register the in-RAM `ServedFile` (fresh `offerId`), persist the chat
  `messages` row (existing path) + send the **signed** offer via the typed envelope, emit
  `OutgoingFileOfferPending`, return fast. No buffer retained, no dialing. **Must NOT take a serve
  lease** (the per-peer/global serve slots and the per-offer lock are for active serves only, taken
  after pull-auth). Registry insertion is the
  atomic sender-cap reservation and **must be the first synchronous step, before the `stat`/read
  and before persisting the row** (reserve a slot keyed by the fresh `offerId` up front, populate
  metadata after); if the per-chat cap is already full, abort synchronously without creating a row
  or sending an offer. If any later step (file I/O, persistence, transport setup) fails, roll the
  registry entry back so the slot is freed.
  - **The signed `FileOffer` payload must include `offerId`.** `buildSignedFileOfferPayload`
    (`file-handler.ts:226`) currently signs only `fileId` + metadata; add `offerId` so the offer
    and the pull authorization bind the *same* unique capability.
- **serve handler** (`#setupProtocolHandler`, `:344`) — **challenge-response**. On `FilePullInit`,
  reply `FilePullChallenge{challenge}` (random, per-stream). On `FilePullAuth`, verify **in this
  order, before acquiring a serve slot or touching disk**:
  1. `offerId` exists in the registry (else `unavailable`).
  2. Noise-authenticated `remotePeer` == `requesterPeerId` (else reject).
  3. `requesterPeerId ∈ authorizedPullers` (else `unauthorized`).
  4. signature valid over `{domain:'kiyeovo-file-pull-v2', offerId, senderPeerId, requesterPeerId,
     challenge}` using the **snapshotted** app signing key for that peer (else `unauthorized`).
  5. `challenge` belongs to this stream and is unconsumed (else reject).
  Only then: acquire serve slot (else `busy`) → re-read `filePath` + verify `size`+`checksum`
  (mismatch → drop entry, `source_changed`) → stream chunks → read confirm.
  **Security:** the request carries only an opaque `offerId` (never a path), so a peer can't read a
  file we never offered; and the app-signature step binds authority to a second identity root, so a
  stolen libp2p key alone cannot pull.
- **Close-on-complete:** on a successful `FileTransferConfirm`, 1:1 → drop the registry entry
  (offer consumed); group → remove this puller from `authorizedPullers`, drop the entry once it's
  empty.

---

## Recipient: accept = pull, with an explicit state machine

Offer arrival → persist pending `messages` row (`incoming_pending_user`, store `file_offer_id`)
and emit `PendingFileReceived`. No acceptance timer.

`acceptPendingFile(fileId)` (core resolves `fileId → offerId`) → look up `sender_peer_id` +
`offerId` off the row, dial, run the challenge-response (`FilePullInit` → receive
`FilePullChallenge` → send app-key-signed `FilePullAuth`), receive + verify checksum, write file,
send confirm. On success the row →
`completed` (frees its `MAX_PENDING_FILES_*` slot).

**State machine (corrects the earlier "sticky in every case"):**

| Outcome on accept            | Class      | Next state                                  |
|------------------------------|------------|---------------------------------------------|
| Streamed + checksum OK       | success    | `completed` (terminal)                      |
| Dial fails (sender offline)  | transient  | back to **pending** ("Sender offline")      |
| `busy`                       | transient  | stays **pending**; toast, **no auto-retry** |
| `unavailable` / withdrawn    | terminal   | failed/withdrawn ("No longer offered")      |
| `source_changed`             | terminal   | failed ("Sender no longer has this file")   |
| `unauthorized`               | terminal   | failed                                      |
| user reject                  | terminal   | row → `rejected` (kept, not deleted)        |
| sender cancel                | terminal   | row → `cancelled` (kept, not deleted)       |

- **Single-flight / CAS on accept** so a double-click can't launch two pulls for one `offerId`.
- **`busy` does not auto-retry:** the row stays pending with the Download action available and a
  toast tells the user to try again soon; the user re-taps. `busy` is the only non-terminal reject.
- **Presence relabel (no auto-pull):** show "Download" vs "Sender offline"; the user taps.

---

## Cancellation (1e — required before Phase 1 release)

`cancelOffer(fileId)` (core resolves `fileId → offerId`): drop the in-RAM registry entry + send a `FileOfferCancel{offerId}`
(**signature required**, domain-separated) via the typed envelope (direct or offline bucket;
group → group message). Recipient verifies `sender == offerer` via signature, flips the pending row
to terminal `cancelled`, emits `PendingFileCancelled` (frees its pending slot). Does not abort an
in-flight transfer.

**Out-of-order safety needs a bounded cancellation tombstone (chosen).** Fresh `offerId` stops
*cross-generation* cancels, but a cancel that arrives **before its own offer** (same generation,
reordered across online vs bucket routes) would otherwise be a no-op and let the delayed offer
appear afterward. So the recipient records cancelled `offerId`s in a small mode-scoped
**`file_offer_cancellation_tombstones`** table (bounded; entries expired at `MESSAGE_TTL`; survives
restart — cleaner than JSON-in-settings, and queryable); an incoming offer whose `offerId` is
tombstoned is suppressed. This is the feature's only new table. This
makes cancel causally safe without requiring causal delivery on every route.

## Rejection feedback — `FileOfferNack` (in scope)

Removing the held stream removes today's `FileOfferResponse{accepted:false}`. Re-home it: when
`#evaluateIncomingFileOffer` returns the polite `{kind:'reject', reason}` (inbox full /
rate-limited), the recipient sends a signed `FileOfferNack{offerId, reason}`; the sender marks the
row `failed` and drops the registry entry, freeing its sender slot. The
`{kind:'silent-reject'}` anti-spam tier stays silent. In 1:1 chats, an explicit
human decline sends the same signed control with `reason:'declined'`; the sender changes its still-
active row to `rejected` and drops the served-file entry. The recipient's local rejection is
authoritative and the NACK is best-effort, so a delivery failure never restores the local pending
row. Transport-level "delivered" (`message-handler.ts:2746`) still tells the sender the offer
reached the peer's node; the NACK adds the file-layer result.

The typed-offer path bounds rejection traffic without verifying every over-limit flood message:
pending-capacity rejection uses `inbox_full`; once the per-peer offer rate is exceeded, at most one
valid signed NACK is attempted per rate window (`inbox_full` if capacity is also full, otherwise
`rate_limited`) and later excess messages in that window are silent.

**NACK is 1:1-only; group rejection is silent (chosen).** A group co-member often has no
direct offline channel back to the sender, and one member's inbox-full must **never** fail the
whole group offer. So in groups, system and human rejection are silent — the sender keeps serving
the other members best-effort; the rejecting member simply doesn't pull. (No group-addressed
control message, avoiding its metadata/privacy cost.)

## Re-offer identity

**Fresh random `offerId` *and* `fileId` per offer.** `offerId` = capability/auth key; `fileId` =
this message's content/cid. `fileId` must be fresh too — the history row uses
`id = client_msg_id = fileId` and outbound inserts **throw** on a cid collision
(`database.ts:2246`). Fresh `offerId` removes the causal hazard where a delayed cancel/nack from a
prior generation hits a new offer. A re-offer is simply a new offer; the prior one is cancelled or
dies with the session.

## Group specifics (Phase 2)

- Offer rides a typed `kind:'file_offer'` group message over the `GroupMessaging` application-message path
  (gossipsub + DHT offline backup). `authorizedPullers` = group roster minus self, snapshot at offer
  time as an in-RAM `Map<peerId, signingPubKey>` (from `GroupRosterEntry`, `group/types.ts:150`).
- **Membership revocation (must-have), at the right granularity:**
  - **Remote** member leave / kick / block (someone *else* goes) → **delete only that peer** from
    `authorizedPullers` of every outstanding offer. **Do not terminalize the whole group offer**
    unless the Map becomes empty (then drop the entry). Without this, a removed member stays
    authorized until the offer ends — the "removed members lose access" claim holds only *with* this
    hook (`GROUP_KICK` / `GROUP_STATE_UPDATE`). Trivial on the in-RAM Map.
  - **Local** leave / disband / chat deletion (*I* go, or the group/chat ends) → **close the whole
    offer** (drop the registry entry, terminalize the row).
- Concurrent multi-pull is fine (the per-peer serve lease isolates each peer at
  `MAX_CONCURRENT_FILE_SERVES_PER_PEER`, the per-offer lock serializes pulls of the same offer);
  bound global fan-out with `MAX_CONCURRENT_FILE_SERVES`.
- Best-effort delivery under group-bucket retention (50 msgs / 64KB / `MESSAGE_TTL`).

---

## Lifecycle gates & cleanup

- **Remove `expiresAt` acceptance gates.** Offer validation currently requires `expiresAt`, and the
  renderer expires rows on a countdown (`MessagesContainer.tsx:73`, `Main.tsx:551`). Phase 1 must
  drop the validation requirement and the renderer countdown — offers don't expire on a timer in
  Option B.
- **Explicit cleanup triggers (mode-scoped), at the right granularity:**
  - **Close the whole offer** (drop registry entry + terminalize the row): direct chat deletion;
    blocking the 1:1 peer; *local* group leave / disband / chat deletion; identity logout / core
    `cleanup()`.
  - **Remove only that peer** from `authorizedPullers` (close the offer only if the Map empties):
    a *remote* group member leaving / being kicked / blocked (see Group specifics).
- **Sender cancellation needs a real UI affordance** — without TTL/auto-recycle, a manual
  "withdraw offer" control is the user's only way to clear an offer they no longer want to serve.

## Code organization (do this before growing `FileHandler`)

`FileHandler` is already large. Put the in-memory serving authority + revocation in a focused
**`ServedFileRegistry`** (the `servedFiles` map, `authorizedPullers`, snapshot/lookup/revoke/drop),
and keep **protocol serving/pulling** separate from the **typed-message transport** (Phase 0). This
keeps responsibilities cohesive and makes the deferred persistent-offer work (see "Removed from
scope") genuinely *additive* — swap the registry's backing store — rather than another rewrite of
`FileHandler`.

---

## What stays (reuse, don't rebuild)

- Offer signing + validation: `#createSignedFileOffer` (`:1153`), `isFileOfferSignatureValid`
  (`:238`), `#evaluateIncomingFileOffer` checks (`:1267`) — size, chunk count, `basename`
  path-traversal guard, sender-in-contacts, replay/dedup (`messageExists`, `:1358`), rate limiting.
- Chunking + integrity: per-chunk BLAKE3, full-file checksum, length-prefix framing (`:803`). But
  **replace** `#createEncryptedChunks` (`:769`, session + XChaCha) with a new session-free
  `#createChunks` emitting the plaintext `FileChunk` frame (decision 4 — Noise encrypts the wire).
- Progress throttling (`:207`); transfer-status DB writes; unique filename allocation (`:621-655`);
  per-peer/global pending limits (re-pointed at DB pending rows) + silent-reject backoff.
- direct-first `dialProtocolWithRelayFallback(..., preferDirect:true)` for the recipient's reverse
  dial: use direct TCP when reachable, then relay fallback for NAT/unreachable cases.

---

## Phasing

> Each phase **updates the technical documentation** (§7 file transfer + §10 schema) under the
> repo's doc-sync expectation, and lands its **pure-logic tests** (see Testing).

- **Phase 0 — typed envelope + dispatcher + outbound API.** Extend the reply envelope with `kind`;
  one shared inbound decode dispatcher across all four routes **and** the domain-neutral outbound
  application-message API (caller-id, who-persists, dedup, control=no-visible-row, group backup).
  Prerequisite for everything below.
- **Phase 1 — 1:1 pull-model.** New pull frames; `sendFile` → `offerFile` + serve handler;
  recipient dial+pull; remove `FILE_ACCEPTANCE_TIMEOUT` / held stream / `FileOfferResponse`;
  in-RAM registry; lazy read + verify (`source_changed`); operational timeouts; state machine +
  CAS; re-point pending caps at DB rows; **Noise + app-key challenge-response authorization
  (decision 4)** incl. adding `offerId` to the signed `FileOffer`. Then: cancellation, nack.
  Riskiest (reworks the battle-tested 1:1 path) → manual multi-machine. Delivered as increments:

  - **1 — file offerings (done).** Typed `file_offer`; sender persists a caller-owned
    `awaiting_acceptance` row; recipient validates and persists `incoming_pending_user`; no
    countdown; pending rows survive restart.
  - **1b — reject NACK (done).** Reject → signed `declined` NACK; capacity/rate rejections emit
    `inbox_full`/`rate_limited` NACKs (signature-validated first, so no reflection oracle; rate
    NACK throttled to one per window per peer); verified NACK terminalizes the sender's matching
    `awaiting_acceptance` row.
  - **1c — served-file registry + pull-authentication foundation (NEXT).** Establishes
    *authorization state and capacity*; **no file bytes move and Accept stays unavailable** — that
    is the milestone seam. Scope:
    - Add a focused `ServedFileRegistry` owning the atomic `MAX_ACTIVE_FILE_OFFERS_PER_CHAT = 5`
      sender cap: **synchronous reserve-before-`await`** (count-and-insert keyed by the fresh
      `offerId` before stat/read/persist), no eviction, roll the entry back on any later failure.
    - Integrate direct offers: snapshot the recipient's app signing key into the entry's
      `authorizedPullers`, register **before** persistence/transport, roll back on failure.
    - Drop the registry entry on terminal NACK by plugging into the **already-shipped**
      `#handleFileOfferNack`: when `terminalizeOutgoingFileOfferFromNack` succeeds, also
      `registry.release(offerId)`. (Touches committed code → named step + end-to-end test.)
    - Add strict pull frame schemas — **provisional**, shapes may adjust once 1d's pull handler
      consumes them — and the domain-separated challenge/signature helper (solidly in scope: it
      verifies against the snapshotted app key, this milestone's core).
    - Unit tests: atomic capacity **including concurrent reserve-before-await** (two `sendFile`
      calls racing the 5th slot — exactly one wins, registry never exceeds five), rollback,
      authorization snapshots, revocation, bad keys, peer mismatch, replayed challenges, and
      terminal-NACK-frees-a-direct-slot through the existing handler.
    - Observable (manual, offline recipient): five offers to one direct chat succeed, the sixth
      fails locally with no row/network message; declining one frees a slot and a further offer
      then succeeds; a failed send leaks no slot; a wrong app key cannot authenticate a pull.
  - **1d — direct pull transfer (implemented in slices).** Moves bytes and turns Accept on. Riskiest increment
    (re-registers a live protocol handler and reworks the 1:1 path) → manual multi-machine.
    **Transfer only — no cancellation/withdrawal (that is 1e).** Consumes the 1c primitives. Scope:
    - **ID contract:** UI/IPC keep passing **`fileId`** (`acceptPendingFile(fileId)`); the core
      resolves `fileId → offerId` via `file_offer_id` and uses `offerId` only internally for the
      registry/pull/challenge. No `offerId` crosses the IPC boundary.
    - **Sender serve handler** on `fileTransferProtocol`: `FilePullInit{offerId}` →
      `PullChallengeStore.issue(offerId)` → `FilePullChallenge`; on `FilePullAuth` → resolve
      `offerExists`/`getAuthorizedKey(offerId, requester)` from the registry and run
      `evaluateFilePullAuth` (with `consumeChallenge`) → reject or proceed. **Only *after*
      authentication succeeds**, take the offer serve lock (direct: exclusive per offer; group:
      exclusive per requester, so different group members can pull the same offer concurrently),
      then atomically acquire **both** the
      global serve slot (`MAX_CONCURRENT_FILE_SERVES = 15`, else `busy`) **and** the per-peer slot
      (`MAX_CONCURRENT_FILE_SERVES_PER_PEER = 5`, else `busy`) from one `LeasePool`
      (acquire-both-or-neither; never hold one while failing the other) → re-read path + verify
      `size`+`checksum` (mismatch → `release(offerId)` + `source_changed`) → stream `FileChunk`s →
      read `FileTransferConfirm`. A `finally` releases the offer lock and both leases on every
      exit path; on a successful confirm, direct offers `registry.release(offerId)`, while group
      offers remove only the requester and release the registry entry after the last puller. If the stream is interrupted
      before a valid confirm (or the confirm is malformed/missing), the sender's visible row returns
      to `awaiting_acceptance` and the registry entry survives for a full re-pull. Terminal sender
      row writes (completion / `source_changed` / integrity-fail / recipient-cancel) are
      **compare-and-set against the active serving state** (`terminalizeServedFileIfActive`) so the
      first terminal state wins and a serve completion can never overwrite an earlier signed NACK.
      - **Challenge lifecycle:** the challenge is bound to **this stream's** `offerId` *and* the
        exact value issued on this stream — `FilePullAuth` must present both (a challenge issued on
        another stream/offer is rejected). The `finally` calls **`PullChallengeStore.discard(offerId,
        challenge)`** — the surgical per-stream removal — on timeout/disconnect/any exit, so it
        drops only this stream's challenge. **Not `dropOffer(offerId)`**, which would wrongly
        invalidate concurrent streams pulling the same offer (`dropOffer` is reserved for offer-level
        teardown: withdrawal/cancel/`source_changed`).
      - **Pre-auth stream bound:** cap the number of concurrent *unauthenticated* inbound streams
        (those past `FilePullInit` but not yet authenticated) so an attacker cannot exhaust memory
        with challenge-holding streams; this is separate from and smaller-impact than the serve
        slot, which is post-auth only.
      - `MAX_CONCURRENT_FILE_SERVES = 15` is bound to the **10MB** Phase-1 limit: Phase-1 serves
        buffer whole files, so resident RAM ≈ `serves × MAX_FILE_SIZE` (≈150MB worst case). Phase 3
        must land true streaming **before** raising the file limit, or this constant drops.
    - **Recipient `acceptPendingFile(fileId)`**: single-flight/CAS guard against
      double-click, resolve `offerId`, dial, `FilePullInit` → receive `FilePullChallenge` →
      app-key-signed `FilePullAuth`; receive chunks → per-chunk BLAKE3 + full-file checksum verify →
      write to disk via the shared **`writeFileWithCopySuffix`** helper (`flag:'wx'` +
      `_copy_<timestamp>` suffix; do **not** resurrect the removed `access()`-then-write path) →
      send `FileTransferConfirm`. Active recipient cancellation is best-effort signaled as
      `FileTransferConfirm{success:false, reason:'canceled'}` before the receive stream is aborted.
      - **Recipient memory bounds (defense against a malicious sender):** the per-frame
        `MAX_FILE_CHUNK_DATA_LENGTH` is *not* sufficient — a sender could stream unlimited
        valid-sized frames. Additionally require: **contiguous indices** (each chunk's `index` is
        the next expected, starting at 0); **at most `totalChunks`** frames; **cumulative decoded
        bytes never exceed the offered `size`**; on completion **exactly `totalChunks` and decoded
        bytes === `size`**; **reject duplicate or extra frames**. Any violation → abort + discard
        the partial file.
    - **State machine** (plan table): streamed+checksum OK → `completed`; dial fails → **pending**
      ("Sender offline"); **`busy` → toast "offerer is busy currently, try again soon", row stays
      pending (Download available), no auto-retry**; `unavailable`/`source_changed`/`unauthorized`
      → terminal `failed`. (`rejected`/`cancelled` rows are produced by reject (1b, shipped) and
      cancel (1e).) `busy` is the only non-terminal reject. Presence relabels Download vs "Sender
      offline"; never auto-pulls.
    - **Failure-mode DB outcomes** (must be specified and tested — **only a confirmed transfer
      consumes the offer**; the serve slot is always released in `finally`, the question is whether
      the registry *entry* survives for a re-pull):

      | Outcome                          | Recipient row                                   | Sender row + registry                              |
      |----------------------------------|-------------------------------------------------|----------------------------------------------------|
      | mid-transfer disconnect          | discard partial → **pending** ("interrupted"); user re-taps for a **full re-pull (no resume, no auto-restart)** | `awaiting_acceptance` unchanged; **keep** entry |
      | integrity/checksum failure       | terminal **failed** ("integrity"); discard partial; negative confirm | **failed**; `release(offerId)` — the file is bad, the offer is dead |
      | disk-write failure               | **pending** ("could not save, retry"); discard partial; negative confirm | `awaiting_acceptance` unchanged; **keep** entry — local problem, offer still good |
      | recipient cancels active download | terminal **failed** ("canceled by user"); partial discarded | **failed**; `release(offerId)` — explicit user intent frees the sender slot |
      | lost success-confirm (sender's confirm-wait times out, recipient saved OK) | **completed** | remains `awaiting_acceptance`; **keep** entry |
      | source changed at pull           | terminal **failed** (`source_changed`)          | **failed** ("file no longer available"); `release(offerId)` |
      | streamed + confirmed OK          | **completed**                                   | **completed**; `release(offerId)`                  |

      Notes: (a) the sender branches release-vs-keep on the **confirm's reason** (integrity →
      release, disk/other → keep, canceled → release); trusting the recipient's reason is safe
      because either path only affects the *offerer's own* slot, never a third party. (b) a
      **lost success-confirm leaves the
      offer occupying a sender slot** (recipient already has the file and won't re-pull) until
      withdrawal (1e) or restart — the accepted cost of a dropped confirm.

    - **Renderer progress delivery:** main-process progress IPC is coalesced per `messageId`, and
      any queued progress for a message is dropped before its terminal event is sent. This keeps
      cancel/failure/completion UI state from sitting behind hundreds of stale chunk-progress
      events.

    - **Deferred-from-1c cleanup:** cap the **raw on-wire frame length** at the stream reader
      (length-prefixed read; a value guard can't see pre-parse bytes); wire
      `onFileTransferProgress`/`onFileTransferComplete` (removes the two "unused field" warnings);
      extract `#createChunks` (plaintext + per-chunk BLAKE3, no session) from `git show` of the
      pre-removal handler.
    - **Tests.** Pure units: chunk/reassembly + per-chunk and full-file checksum verify; the
      recipient memory-bound rejections (non-contiguous index, extra/duplicate frame, cumulative
      over-size, short final); challenge bound-to-stream + discarded-on-exit; state-machine
      transition + failure-mode-DB-outcome classification. Manual multi-machine: real transfer over
      TCP / relay / Tor; direct-first behavior when both relay and LAN addresses are known; full
      reject-reason matrix; `busy` toast under `MAX_CONCURRENT_FILE_SERVES`;
      every operational timeout releases its slot and discards its challenge.
  - **1e — withdrawal / cancellation (implemented).** Split out of 1d
    because it adds cancellation UI, signed control handling, a new tombstone table, and reorder
    semantics on top of the transfer rewrite. `cancelOffer(fileId)` (core resolves `offerId`):
    `registry.release(offerId)` + signed domain-separated `FileOfferCancel` via the typed envelope;
    recipient verifies `sender == offerer`, flips the pending row to terminal `cancelled` (frees its
    pending slot), emits `PendingFileCancelled`. **Bounded mode-scoped cancellation tombstone** so a
    cancel that arrives before its own offer (online-vs-bucket reorder) suppresses the late offer.
    UI exposes withdrawing a still-pending outgoing offer — this is the affordance that recovers a
    sender slot pinned by a lost NACK without restarting. Tests: cancel release + tombstone (cancel-before-offer
    suppresses the offer), signature/`sender==offerer` rejection, duplicate/late cancel no-op.
- **Phase 2 — groups.**
  - **2a — group offer delivery/persistence (implemented).** `sendGroupFile(chatId, ...)`
    persists the caller-owned group file row, reserves one per-chat sender slot, snapshots the
    active group roster minus self into the in-RAM `authorizedPullers` Map, and sends the signed
    `kind:'file_offer'` through the group application-message path (GossipSub + DHT offline backup).
    Incoming realtime/offline group offers validate and persist as `incoming_pending_user`; group
    capacity/rate rejection is silent and group Reject is local-only.
  - **2b — group pull completion safety (implemented).** Group Accept is enabled. A successful
    group pull removes only the requester from `authorizedPullers`; the sender row becomes
    `completed` and the slot frees only when the last authorized puller succeeds. A recipient cancel
    during an active group pull removes only that requester and leaves the offer alive for the rest,
    unless that was the last puller.
  - **2c — group sender status + concurrent same-offer pulls (implemented).** Outgoing group file
    rows persist `file_group_download_total` and `file_group_download_completed`. The sender bubble
    uses count-based status (`Downloaded by 0/M`, `Downloaded by N/M`, `Completed`, `Cancelled`)
    instead of per-transfer 0–100 upload progress. Direct offers remain exclusive per offer, but
    group offers can serve the same offer concurrently to different requesters; only a duplicate
    concurrent pull from the same requester receives `busy`. Successful group confirms increment the
    completed count exactly once because `ServedFileRegistry.removePuller()` is the idempotency gate.
    When the last authorized puller is gone, the final sender row status is count-driven rather than
    last-action-driven: all downloaded → `completed`; some downloaded → `partially_completed`
    rendered as `Downloaded by N/M`; none downloaded → `cancelled`.
  - **Next group slices.** Membership-revocation hook; group withdrawal/cleanup. Delivers Goal 1.
- **Phase 3 — later.** True per-chunk disk streaming (both sides — recipient must stop
  `Buffer.concat`-ing all chunks, `:595-601`); mode-aware **100MB** in fast mode; reconsider
  store-and-forward.

## Testing

### Automated tests for pure logic (NEW — first tests in the repo)

The repo has no test framework today (verification has been manual). For this feature we add a
**lightweight test setup, scoped to deterministic units only** — no networking:
- typed-envelope encode/decode + validation (bounds and exact version; bare text, missing/unknown
  `kind`, unsupported versions, and malformed payloads are rejected, not rendered);
- challenge-response transcript: signature construction/verification over the domain-separated
  payload; reject on wrong/absent signature, peer mismatch, stale/consumed challenge;
- `ServedFileRegistry` authorization + revocation (snapshot Map, kick/leave removes peer), atomic
  five-per-chat capacity (synchronous reserve-before-await), rollback, and slot release on every
  terminal path — including the group rule that a slot frees only after *all* authorized pullers
  have pulled or all have declined, not on the first;
- recipient state-machine transitions (transient vs terminal);
- cancellation tombstone (cancel-before-offer suppresses the offer);
- startup reconciliation: which `transfer_status` values get failed vs preserved, mode-scoped.

Networking paths (dial/pull, relay, group fan-out) stay **manual / multi-machine** below.

### Manual / multi-machine

1. 1:1 both online: offer → accept → transfer; checksum match, progress, completion; row →
   `completed`, registry entry dropped (later pull → `unavailable`).
2. 1:1 recipient offline at offer, sender stays online: offer appears later from bucket → accept
   pulls successfully; no 5-min pressure.
3. 1:1 sender goes offline before accept: accept → "Sender offline" (transient, stays pending);
   sender returns *in the same process* → blip-survival, accept succeeds; sender *restarts* →
   `unavailable`, re-offer needed.
4. 1:1 source file changed/deleted after offering: accept → `source_changed` (terminal); no crash.
5. Double-click accept: single-flight prevents two concurrent pulls for one `offerId`.
6. Operational timeouts: peer opens stream and sends nothing → first-frame timeout, slot released;
   peer stops mid-stream → idle/total timeout, slot released.
7. Cancel (1:1): `cancelOffer`; online recipient sees it disappear; later pull → `unavailable`;
   pending slot freed. Offline recipient gets the cancel from the bucket on next online.
8. Offer-nack: recipient inbox full → `FileOfferNack` → sender row `failed` with reason; beyond
   silent-reject threshold → no nack. 1:1 human decline → signed `declined` NACK → sender row
   `rejected`; duplicate/late/unknown-offer NACKs are no-ops.
8b. Sender cap: with the recipient offline, five live offers to one direct chat succeed; the sixth
    fails locally with no row/network message and does not evict the first. A terminal NACK or
    sender withdrawal frees exactly one slot. For a group, five active group offers consume five
    slots regardless of roster size, and a group slot frees only after every authorized member has
    pulled or declined — one member's pull/decline leaves the slot occupied for the rest.
9. Malicious/unknown pull: unknown `offerId` → `unavailable`, no disk read; peer ∉ authorizedPullers
   → `unauthorized`, no disk read (auth checks run before slot/disk).
9b. App-key auth: valid `FilePullAuth` signed with the snapshotted app key → succeeds; **wrong or
    absent signature** → `unauthorized`, no disk read; `requesterPeerId` ≠ Noise `remotePeer` →
    reject.
9c. Replay resistance: capture a valid `FilePullAuth` and re-send it on a new stream → rejected
    (challenge belongs to the original stream / already consumed); no replay cache needed.
9d. Stolen-libp2p-key simulation: a peer with the right PeerId but the wrong app signing key →
    `unauthorized` (two-key rule holds).
10. Group, 3 members: one offer; two accept, one ignores; both accepting members can pull
    concurrently; a duplicate concurrent pull by the same member receives `busy`; ignorer unaffected.
11. Group member offline at offer: receives it from the DHT offline store on next online, then
    pulls (if sender still online).
12. Group, simultaneous accepts beyond `MAX_CONCURRENT_FILE_SERVES`: excess → `busy` toast, rows
    stay pending; manual re-tap after the in-flight serves drain completes them.
13. Group member kicked after offer: revocation removes **only** that peer from `authorizedPullers`;
    their pull → `unauthorized`, but the **other members still pull** (offer not terminalized).
14. **Recipient restart with a pending offer:** the `incoming_pending_user` row is preserved (not
    failed by startup reconciliation) and still pullable; persisted `checksum`/`total_chunks`/
    version let verification run without the sender's memory.
15. **Reject keeps history:** user rejects → row → `rejected` (not deleted); a reply pointing at it
    still resolves. Same for sender cancel → `cancelled`.
16. **Cancel-before-offer reorder:** deliver the cancel before its offer → the tombstone suppresses
    the offer; it never appears.
17. **Group system rejection is silent:** a group member's inbox-full produces no sender-visible
    failure and doesn't fail the offer for others; the other members still pull.
18. **Cleanup granularity:** *local* leave/disband/chat-delete/logout → whole offer closed (pulls →
    `unavailable`, rows terminalized); *remote* member leave → only that peer removed, offer lives
    for the rest.
19. **Strict envelope rejection:** bare text and envelopes with a missing/unknown `kind`, an
    unsupported version, or a malformed payload are ignored and never shown as text.

---

## Removed from scope (was in the full plan; preserved for later — all additive)

These were cut to ship group sharing at roughly half the cost/risk. None require a rewrite to
re-add later; each layers on top of Option B.

- **1B persistence — cross-restart sticky offers.** Persisting the served-file registry so an
  offer survives a *sender restart* (not just a network blip). *Cut because:* it required new
  tables, restart hydration, and splitting `failNonTerminalFileTransfers`, and the review found it
  the most under-specified, highest-risk part — for the modest UX of "my offer survives me
  quitting." *Re-add:* a `served_file_offers` + normalized `served_file_offer_pullers(offer_id,
  peer_id, state)` table (normalized, **not** JSON — recycling/per-recipient completion/revocation
  need per-row state), rehydrate on startup, split the startup failer to rehydrate `offered` rows.
- **Decision-5 GC machinery.** 7-day TTL sweep (5A) and sender auto-recycle-oldest (5B). *Cut
  because:* with session-bound offers there's nothing to garbage-collect across restarts; offers
  die with the process. (5C close-on-complete is **kept** — it's inherent to the pull path.)
- **Persisted `expiresAt` / core GC sweeper ownership.** Only needed once offers outlive the
  process. Currently `expiresAt` isn't persisted (renderer reconstructs it from the 5-min const,
  `MessagesContainer.tsx:73`); a persisted, mode-scoped, core-owned sweeper is part of the sticky
  re-add, not Option B.
- **Same-`fileId` upsert (old Fork 2).** Replaced by fresh-`offerId`-per-offer, which is causally
  safe; the upsert is unnecessary and is dropped, not deferred.
- **Durable typed outbox / reserved bucket capacity for offer/cancel/nack.** Option B accepts
  best-effort delivery under bucket retention (Goal 3). If async control messages prove flaky in
  practice, add a durable outbox + reserved slot category later.

> **Doc bug to fix separately:** the technical documentation lists a `file_transfers` table
> (`Kiyeovo_desktop_technical_documentation.md:441`), but file rows actually live in `messages`.
> Reconcile the doc independently of this plan.
