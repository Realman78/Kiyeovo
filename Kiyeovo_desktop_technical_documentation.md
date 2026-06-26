## Kiyeovo — Technical Documentation (EN)

### Purpose of the document

This document is the single-source technical overview of the current desktop version of the Kiyeovo application.
Its goal is to provide complete context quickly in new AI conversations without manually re-explaining architecture, flows, and key design decisions.

---

### TL;DR (quick context)

- Kiyeovo is an Electron + React + libp2p P2P messenger.
- It supports two network modes:
  - `fast` (TCP + Circuit Relay v2 + DCUtR)
  - `anonymous` (Tor onion path)
- Mode isolation is built in through:
  - mode-specific protocols
  - mode-specific DHT namespaces/prefixes
  - mode-specific pubsub topic prefixes
  - mode-aware DB queries
- First-run startup requires explicit mode selection (`network_mode_onboarded`).
- Direct chat uses:
  - key exchange (X25519 + Ed25519 signatures)
  - session symmetric keys (HKDF)
  - online sending + offline fallback into DHT buckets
  - replies (quote + jump-to) anchored to a cross-peer stable id carried in a versioned encrypted envelope (§5.4)
- Group chat uses:
  - mode-scoped GossipSub for realtime content
  - control messages over pairwise offline buckets
  - ACK/republish mechanisms for reliability
  - key epoch rotation
  - encrypted group-info metadata in DHT versioned records
  - replies (quote + jump-to), reusing the shared group `messageId` as the cross-peer id (§5.4)
- Calls are implemented for fast mode direct chats:
  - 1:1 audio/video
  - screen sharing for active calls
  - signaling over `call-signal` protocol
  - WebRTC media path in renderer
- File transfer uses a dedicated protocol with offer/accept/reject, chunked encrypted transfer, cancellation, and per-peer active-transfer limits.

---

### 1. High-level architecture

Kiyeovo runs across two runtime processes:

1. Electron Main process (Node.js runtime)
   - initializes P2P core
   - manages Tor lifecycle
   - owns SQLite lifecycle
   - exposes IPC API to renderer

2. Renderer process (React UI + Redux)
   - renders login/chat/settings/call UI
   - sends requests via preload bridge
   - receives events from core (messages, KX, group updates, file transfer, call state)

Core modules include:
- `MessageHandler`
- `KeyExchange`
- `SessionManager`
- `UsernameRegistry`
- `GroupCreator` / `GroupResponder` / `GroupMessaging` / `GroupOfflineManager`
- `GroupAckRepublisher` / `GroupInfoRepublisher`
- `FileHandler`
- `OfflineMessageManager`

Current repository layout in `src/core/`:
- `db/` - SQLite persistence and row-level types
- `direct/` - direct-chat session establishment, encryption, offline delivery, validators
- `group/control/` - invites, welcomes, state updates, ACK republish
- `group/runtime/` - realtime group messaging, offline reconciliation, state machine
- `group/dht/` - group-info publish/validate/refetch flows
- `identity/` - encrypted local identity and profile import/export
- `network/` - libp2p node construction, bootstrap, relays, health, reconnect policy
- `transport/` - Tor transport, Tor lifecycle, protocol dialing, stream helpers
- `username/` - username registry and DHT validator/record helpers
- `lib/` - remaining cross-cutting coordinators that still orchestrate multiple domains (`MessageHandler`, `FileHandler`)

---

### 2. Network modes and isolation

#### 2.1 Modes

- `fast`
  - transport: TCP + relay transport
  - Circuit Relay v2 and DCUtR
  - focus: lower latency and higher UX responsiveness

- `anonymous`
  - traffic via Tor SOCKS5 + onion announce addresses
  - focus: stronger network anonymity properties

#### 2.2 No-bridge rule

Data from one mode must not bridge into the other mode:
- different protocol IDs (`chat`, `file-transfer`, `bucket-nudge`, `call-signal`, `dht`)
- different DHT namespaces (`offline`, `username`, `groupOffline`, `groupInfoLatest`, `groupInfoVersion`)
- different pubsub topic prefixes
- mode-aware DB reads/writes and queue processing

#### 2.3 Mode switch

Mode switch is done in settings and requires app restart (no hot stack replacement in-process).

---

### 3. Startup and lifecycle flow

1. Electron app starts and creates the window.
   - privileged application and local-media URL schemes are registered before Electron becomes ready
2. Main process reads DB settings (`network_mode`, onboarding flag).
3. If onboarding requires explicit mode selection, initialization is gated until user picks mode.
4. Tor manager starts only for `anonymous` mode.
5. Encrypted identity for active mode is loaded/unlocked.
6. Libp2p node is created with mode-specific stack and validators.
7. Bootstrap/relay connectivity is established.
8. DHT status checker and periodic maintenance start.
9. Username registry, message/group/file/call handlers activate.
10. UI hydrates from init state and live IPC events.

---

### 4. Identity and authentication

Identities are encrypted locally in SQLite and are mode-aware.

Identity material includes:
- libp2p identity key (Peer ID)
- Ed25519 signing key
- RSA offline encryption key
- notifications key pair

Security model:
- AES-GCM identity encryption
- scrypt KDF
- optional OS keychain storage (`keytar`)
- recovery phrase (BIP39)
- login attempts + cooldown enforcement

Current KDF defaults live in `src/core/constants.ts`:
- `IDENTITY_SCRYPT_N = 2 ** 18`
- `PROFILE_SCRYPT_N = 2 ** 17`

These defaults are intentionally conservative for broader desktop compatibility. On stronger target hardware they can be raised, but unlock/login and profile import/export latency should be measured first instead of changed blindly.

Trusted profile import/export is also supported for out-of-band onboarding:
- exported profiles are signed, password-encrypted files containing username, peer ID, signing/offline/notifications public keys, and a default inbox key
- importing a verified profile can seed a trusted direct chat without the normal username lookup / first-contact discovery path
- trusted imported chats are tracked separately in chat state (`trusted_out_of_band`) so the app can preserve that bootstrap behavior explicitly
- export does **not** require registration: the embedded username is only a display label (the importer can rename via `customName`), and the trusted chat is built from the profile's default inbox key, so a peer can export and be reachable out-of-band without ever publishing a DHT username
- the `profile:export` IPC takes `(password, sharedSecret, filename, label)`. The renderer collects the destination via the native save dialog and a required display label (prefilled with the current username when registered). The main process validates inputs (label trimmed and bounded to 2–64 chars to match the import-side username constraint, file path required, `.kiyeovo` extension ensured) and embeds `label` as the profile username, falling back to the registered username when no label is provided
- in the UI, export lives in a dedicated `ExportDialog` opened from the `Profile` tab (available in both registered and unregistered states); it is no longer part of `UserDialog`, which now covers only peer ID, change username, and unregister
- auto-register defaults to ON for a first-ever registration: `user:getAutoRegister` treats an unset value as enabled and only an explicit `'never'` (written when the user opts out) as disabled. `RegisterIdentityDialog` persists the user's explicit choice after a successful register (`setAutoRegister(rememberMe)`) so an opt-out is durably recorded as `'never'` rather than left unset; the change-username path does not touch the setting, so renames cannot disable auto-register. Core startup auto-registration still requires an explicit `'true'`, so behavior stays consistent with the toggle

---

### 5. Direct chat flow

#### 5.1 Online path and contact policy

1. User sends message to username or peer ID.
2. `MessageHandler.sendMessage` ensures contact + session.
3. If needed, key exchange runs.
4. Session-encrypted payload is sent on `chatProtocol`.
5. Message persists locally and UI event is emitted.

Direct and group text messages are limited to 2,048 characters. The
renderer rejects oversized sends, IPC validation enforces the same core limit,
and inbound envelope decoding defensively clamps text to that limit. During a
mixed-version rollout, a peer still using the previous 1,024-character limit
will silently clamp longer inbound messages until it updates.

Inbound first-contact behavior depends on contact mode:
- `active` - emits a pending contact request to UI and waits for accept/reject/timeout
- `silent` - logs the contact attempt locally without immediately creating a live conversation
- `block` - rejects or drops the request before conversation bootstrap

Contact attempts are persisted so the UI can show pending/recent inbound requests and the core can enforce timeout/cancellation/rate-limit behavior consistently across restarts.

#### 5.2 Key exchange

- message types: `key_exchange_init` / `response` / `rejected` / key rotation variants
- signed payloads (Ed25519)
- replay/future skew checks on timestamps
- HKDF-derived directional session keys
- automatic rotation after thresholds
- first direct message can be carried encrypted in KX init payload to reduce plaintext exposure during bootstrap of a new conversation

#### 5.3 Offline fallback

When direct online send cannot complete:
- payload is encrypted for recipient offline bucket
- DHT store is signed and versioned
- validators/selectors enforce integrity and update policy
- offline ACK processing prunes acknowledged local sent backlog

Offline send is **non-blocking and batched**:
- not-connected sends return immediately (optimistic `sending` row) and deliver in the background (online attempt → fall back to a durable per-recipient send queue)
- the queue coalesces a burst into one DHT write per flush; outcomes are dual-written (DB + live event) so the row settles to `offline` or `failed`
- durable across restart; **retries are manual** (no auto-resume/auto-retry); bucket-full is pre-checked (toast, draft kept, no phantom row)
- a **standalone offline ACK** (online or DHT-queued, capacity-reserved, ping-pong-guarded) clears the sender's bucket even when the recipient reads but never replies; on-connect refetch nudges and an ACK-side best-effort return nudge speed it up
- if a direct bucket is full and the user tries to send, the sender runs a bounded recovery: fetch ACKs locally, request an immediate reconnect, send one direct refetch nudge with a dedicated dial path, then fetch once more; this is single-flight and cooldown-limited per peer
- direct `DIRECT_OFFLINE_REFETCH` nudges schedule a short `500 ms` fetch delay; generic peer-activity fallback checks keep the longer debounce window

#### 5.4 Reply to a message (quote + jump-to)

Replies quote a specific earlier message and let the reader jump back to the original. Supported in **both direct 1:1 and group chats**.

Cross-peer identity:
- message row IDs are minted independently per peer, so replies anchor to a **`client_msg_id` (cid)** — a stable id that is the *same value on both sides* of a message. The sender mints it; it rides inside the encrypted body and the recipient persists the same value. File/image rows reuse the shared `fileId` as their cid (so files are reply-/jump-able too).
- a reply stores only `reply_to_client_id` (the target cid). **No quoted-content snapshot is kept** — the quote is resolved by live lookup, so deleting the original leaves no recoverable copy. When the target can't be resolved (deleted, or never received — e.g. a group reply to a message that predates your join), the quote renders a neutral, non-interactive *"Original message unavailable."*

Wire format — the plaintext that gets encrypted is a small versioned **envelope** rather than a bare string: `{ v, cid, text, reply_to? }`. This keeps the cid + reply linkage private on the transport **and** in the offline DHT-at-rest payload. The recipient decodes and validates it (bounded cid shape/length, clamped text) and falls back to plain text for any non-envelope body. The envelope + cid are built **once per send** and reused across every delivery route (online, non-blocking offline queue, synchronous offline fallback), so the same cid arrives regardless of path.

Direct file replies use the file-transfer protocol rather than the text envelope. A signed `file_offer` may carry optional `replyToCid` metadata, validated with the same cid shape/length rules and included in the signed offer payload. When present, both outgoing file rows and incoming pending-offer rows persist it as `reply_to_client_id`; the live pending-file event carries the same value so the renderer can show the quote before acceptance.

Dedup: a `UNIQUE(chat_id, client_msg_id)` index makes the same logical message delivered over two channels (online + offline) collapse to one row. Inbound inserts (`tryCreateMessage`) skip the "received" event when no row was inserted; outbound inserts use a plain insert that **throws** on a cid collision (an invariant violation, never expected). This complements the pre-existing offline-message-UUID dedup.

Groups: a group content message's `messageId` is already identical on every member, so it doubles as the shared cid — **`client_msg_id = messageId`** (no separate mint), and a reply just carries the target `messageId` inside the same envelope (`cid = messageId`), encrypted into `encryptedContent`. Both receive paths — gossip realtime and offline catch-up / late-gap repair — decode the envelope (text only; hidden call-hint system bodies stay raw), validate `messageId` (`isValidCid`, enforced in `isGroupChatMessage` for gossip and at the offline parse gate), and persist the cid + reply ref. Because `id == messageId == client_msg_id` for groups, the inbound insert uses a **targetless `ON CONFLICT DO NOTHING`** (covers the PK), and sequence/cursor state advances even for a deduped duplicate — only unread + the "received" event are gated on insertion. The reply envelope lives inside the signed offline backup, so catch-up carries it automatically.

UI: a hover **Reply** action (available in direct and group chats; hidden on un-settled/failed sends, and on files until transfer completes) opens a composer reply bar, transfers focus to the composer, and survives chat switches (`Esc`/✕ cancels). The quote renders above the bubble; clicking it scrolls to the original, waits until the target is visible and scrolling has settled, then starts a 2.5-second accent **highlight pulse**. If the target is not loaded, the renderer first requests one bottom-anchored jump window: the database locates the target cid, counts newer messages, and returns the latest history through the target plus 20 older context rows in one transaction/IPC round-trip. The window is capped at 200 rows to keep that single synchronous (non-virtualized) DOM render cheap; targets deeper than the cap report `too_deep` and fall back to the older page-by-page paging instead. Replacing the history window preserves messages that arrived during the request and resets the database pagination offset to the returned row count. Jump ownership remains scoped to the active chat and a request generation, so chat switches or newer jumps cancel stale work; only confirmed absence/exhaustion reports that the original is unavailable.

Direct file-like sends — manual files, pasted images, and generated long-message `.txt` files — capture the current reply target when their confirmation/conversion dialog opens. The dialog shows that reply context, the optimistic file row carries `reply_to_client_id`, and the send path passes the cid into the signed `file_offer`; incoming pending file offers also carry the cid into the live Redux row so the quote is visible before acceptance. Once an optimistic file row exists, the composer reply target is cleared. If the offer fails before a durable row should remain (offline or peer-busy), the row is removed and the captured reply target is restored only when the user has not selected a newer reply target for that chat.

---

### 6. Group chat flow

Group system uses two planes:

1. Data plane: GossipSub topics per group key epoch
2. Control plane: pairwise offline bucket delivery of control messages with ACK/republish

#### 6.1 Lifecycle

- creator sends invite
- invitee accepts/rejects
- creator sends `GROUP_WELCOME` to joiner and `GROUP_STATE_UPDATE` to existing members
- members activate and subscribe to current epoch topic

#### 6.2 Key rotation and epoch model

- membership changes (join/leave/kick) rotate group key (`key_version`)
- previous topic may stay during grace window to reduce transition gaps
- sender sequence boundaries and per-member progress are tracked for epoch-safe offline replay

#### 6.3 Encrypted group-info metadata

Versioned group-info DHT records keep sensitive metadata encrypted:
- `members`
- `senderSeqBoundaries`

Flow:
- creator encrypts metadata blob with per-epoch metadata key
- metadata key is distributed per-recipient in `GROUP_WELCOME` / `GROUP_STATE_UPDATE` (RSA-encrypted)
- responders/offline manager decrypt metadata only after receiving key material

#### 6.4 Group control extensions

Implemented control events include:
- `GROUP_WELCOME`
- `GROUP_STATE_UPDATE`
- `GROUP_KICK`
- `GROUP_DISBAND`
- `GROUP_STATE_RESYNC_REQUEST`
- control ACK types

`GROUP_STATE_RESYNC_REQUEST` supports "Request group update" behavior and is rate-limited on both requester and creator sides.

#### 6.5 Group offline content

If realtime publish has no subscribers/reachability:
- message is written to sender-specific group offline bucket (`groupId` + `keyVersion` + sender)
- store is compressed, signed, and versioned
- periodic and targeted checks reconcile missed content
- the offline-backup retry queue is **durable** (survives restart) with **manual retry**: a message delivered online but whose backup failed shows a distinct "Retry offline backup" affordance (re-stores only, does not re-send)

#### 6.6 Nudge mechanism

Bucket nudges are best-effort acceleration hints (not a correctness dependency):
- direct bucket nudge
- group-refetch nudges
- cooldowns and sender validity guards

---

### 7. File transfer

File transfer uses dedicated `fileTransferProtocol`.

Flow:
1. sender emits signed `file_offer` with timeout and optional signed reply metadata
2. receiver accepts/rejects
3. accepted transfer sends encrypted chunks
4. progress/completion/failure events update UI and DB

Current operational behavior:
- one active transfer per peer at a time (prevents stream contention)
- incoming download can be canceled by user
- non-terminal transfers are marked failed on app restart/close
- duplicate filename handling uses copy-style timestamped filenames
- completed image files render inline for both sender and receiver; receivers retain the existing file card until completion, and non-previewable transfer states also remain cards
- outgoing image sends keep the sender's trusted selection/upload capability in renderer state, so the sender sees the image immediately with connecting/approval/progress/failure status beneath it; receivers still see the file-offer card until the transfer completes
- clicking an inline image opens a viewport-sized preview dialog using the same capability-backed media URL; Escape, the close control, and backdrop clicks close it
- inline images keep a compact searchable filename/size caption; completed files retain show-in-folder as a secondary action in both the message caption and preview dialog, while sender-only pending previews do not expose filesystem actions
- completed local image messages expose **Copy image** from the message row menu/right-click menu and the fullscreen preview dialog. The renderer passes only the message id; the main process revalidates that the row is a completed image message in the active network mode, rejects symlink paths, canonicalizes the stored path, decodes it with Electron's native image loader, and writes the decoded bitmap to the OS clipboard. Non-image files, pending offers, failed/expired/rejected transfers, and sender-only pending previews do not expose image copy
- unavailable inline media falls back to the file card
- images selected through the paperclip flow show a capability-backed preview in the confirmation dialog, while non-image selections keep the existing dialog layout
- direct file confirmation/conversion dialogs show the captured reply context when opened from a reply draft, and the resulting file offer carries that reply cid
- pasting a supported image MIME into a direct-chat composer opens the same confirmation dialog with a renderer-owned blob preview URL created from the clipboard `Blob` and revoked when the pasted file leaves dialog state; group chats and unsupported clipboard content retain normal paste behavior
- pasted bytes are not re-encoded or compressed; after confirmation, the main process validates the image extension and configured file-size limit, writes the file atomically without overwriting, and then hands the resulting path to the unchanged file-transfer pipeline
- pasted images persist in `kiyeovo-uploads/`, resolved as a sibling of the configured downloads directory; generated names use `pasted-image-YYYYMMDD-HHMMSS.<ext>` and collision copies receive timestamped suffixes
- generated-text upload preparation has a separate main-process IPC boundary: the renderer supplies text plus a proposed basename, while the main process trims the text, requires a portable `.txt` filename, measures UTF-8 bytes against the configured file-size limit, and atomically creates the file without accepting a destination path
- generated text files share `kiyeovo-uploads/`, collision naming, quota accounting, and account-deletion cleanup with pasted images; the save response returns the final collision-adjusted filename and byte size
- when the uploads directory grows beyond 100 MB, a shared non-blocking warning for pasted images and generated text uploads appears once per app session with an action that reveals the newly saved file in its folder
- the send-file dialog remains mounted through the shared Radix close transition and clears its local selection/preview state only after the exit lifecycle completes

Protections:
- rate limits (per peer + global)
- max pending offers (per peer + global)
- silent rejection thresholds for abuse
- path traversal and file-size guards
- backend remains authoritative even if UI pre-checks exist

Local image delivery foundation:
- renderer pages do not receive arbitrary filesystem-read access and do not load `file://` URLs
- on-disk images are exposed through the dedicated `kiyeovo-media://media/<token>` protocol
- tokens are random, process-lifetime capabilities bound to canonical filesystem paths; paths are never embedded in renderer media URLs
- a token can be minted only for a completed, active-network file message persisted in the database, the exact image selected through the trusted OS open dialog, or the exact pasted-image file just created by the validated upload handler
- pasted-image save capabilities do not accept renderer paths: the renderer supplies bytes and a sanitized image filename, and the main process chooses and creates the destination before minting the sender-preview token
- generated text uploads do not mint media capabilities and cannot be loaded through `kiyeovo-media://`
- completed-message grants are mode-scoped in the database and require a persisted file path plus an image extension from the shared allowlist
- symbolic-link file grants are rejected; accepted paths are canonicalized before token binding
- the protocol resolves the canonical path again before serving, requires a regular file and an `image/*` content type, and returns `no-store`/`nosniff` headers
- unknown, stale, non-image, or retargeted capabilities are rejected

---

### 8. Direct 1:1 Calls

Direct-call support is implemented for direct chats in fast mode.

Scope:
- audio-first 1:1 calling
- optional per-participant camera enable during an active call
- screen sharing inside active 1:1 calls
- no offline call queue (offline/unreachable peers fail immediately)
- no system-audio sharing with screen share yet; microphone call audio continues through the normal call audio track

Architecture:
- signaling over `call-signal` protocol (`CALL_OFFER`, `CALL_ANSWER`, `CALL_ICE`, `CALL_REJECT`, `CALL_END`, `CALL_BUSY`, `CALL_CAMERA_STARTED`, `CALL_CAMERA_STOPPED`, `CALL_SCREEN_SHARE_STARTED`, `CALL_SCREEN_SHARE_STOPPED`)
- signaling signed and validated in core
- renderer `CallService` owns `RTCPeerConnection`, local audio/camera/display tracks, and sender replacement
- Electron main owns the Linux fallback source-picker request and only returns a display source selected by the trusted renderer

Behavior highlights:
- direct 1:1 calls are a single `Call` product; new outgoing offers are audio-only
- incoming legacy start-time `video` offers are explicitly rejected as unsupported (`policy`)
- pre-check for direct contact and active connectivity before offer
- outgoing ring timeout (30s)
- busy/reject/end handling with local cleanup on both sides
- media controls: mute/deafen/camera
- camera is independent per participant; one side may enable video while the other stays audio-only
- visual mode starts automatically when camera or screen-share media appears, but fullscreen remains manual
- if the last visual source disappears, the call UI switches back to the audio-only layout automatically
- visual UI includes compact/fullscreen variants, stream swap controls when both cameras are on, and fullscreen idle control fade
- screen sharing replaces the main video surface while active; the camera is not kept as a second primary tile in the current phase
- only one side may screen-share at a time; local sharing wins if a remote started signal arrives during local sharing
- ICE servers fall back to `DEFAULT_WEBRTC_ICE_SERVERS` in `src/core/network/default-infrastructure.ts`; the current default list is empty
- fast mode has a runtime ICE editor in `Setup -> STUN/TURN servers`
- runtime overrides are stored in the settings table and loaded by renderer `CallService` when a call starts or is accepted
- saved entries are format-validated, and the STUN/TURN Setup pane also provides explicit point-in-time reachability tests

Camera and screen-share implementation notes:
- calls pre-negotiate a shared video transceiver so screen sharing can start without mid-call SDP renegotiation
- audio-only direct calls still pre-negotiate the optional video m-line so camera or screen sharing can attach later
- local camera and screen share reuse the same shared video sender
- camera state is signaled explicitly with STARTED/STOPPED messages so the remote UI can update deterministically
- starting screen share replaces the shared visual sender's track with the captured display track
- stopping screen share restores the camera track if camera is on; otherwise it restores `null`
- display capture is requested at up to 1920x1080 and 30fps, with `contentHint = "detail"` for screen/text readability
- screen-share sender parameters currently cap bitrate at 4 Mbps and prefer maintaining resolution
- remote screen-share UI is driven by signed STARTED/STOPPED call signals, not only by WebRTC track `ended`/`mute` state
- macOS and supported portal-backed Linux environments can use the system picker; Linux fallback uses Electron `desktopCapturer` plus Kiyeovo's in-app source picker
- if the source picker is cancelled or the call ends while it is open, captured tracks are stopped and no sharing state is committed

---

### 9. DHT data model

Primary categories:

1. Username registry
   - by-name and by-peer mapping
   - signed payload with validator/select/update logic

2. Direct offline stores
   - per-recipient bucket model
   - message/store signatures + validateUpdate
   - local UX capacity view is derived from the local mirror plus actively queued pending writes; failed offline-backup rows remain retryable local state but do not consume capacity
   - effective direct capacity is split into `30` sendable slots, `10` reserved group-control slots, and `1` reserved ACK slot

3. Group offline stores
   - sender buckets per group and epoch
   - local UX capacity view shows only the current sender epoch (the bucket the next group message would use)
   - group fullness is tracked by both message count and compressed store size (`64 KiB` app-level cap)

4. Group info records
   - `latest` pointer record
   - `versioned` state records with encrypted metadata blob

All DHT records are mode-scoped and validator-protected.

---

### 10. SQLite model (conceptual)

Single DB file, with mode-aware scoping where needed.

Core tables include:
- `users`
- `chats`
- `messages`
- `encrypted_user_identities`
- `notifications`
- `chat_participants`
- `settings`
- `offline_sent_messages`
- `offline_sent_message_categories` (local sidecar for direct-bucket breakdown: `regular`, `control`, `ack`)
- `pending_offline_sends` (durable 1:1 offline-send queue)
- `group_offline_sent_messages`
- `pending_group_offline_backups` (durable group offline-backup retry)
- `group_key_history`
- `group_offline_cursors`
- `group_pending_acks`
- `group_pending_info_publishes`
- `group_invite_delivery_acks`
- `group_sender_seq`, `group_member_seq`, `group_epoch_boundaries`
- `file_transfers`
- `bootstrap_nodes`

Reply feature adds two columns to `messages`: `client_msg_id` (cross-peer stable id / cid, defaults to the row id; file rows use `fileId`) and `reply_to_client_id` (the cid a reply points at). A `UNIQUE(chat_id, client_msg_id)` index backs cross-channel (online + offline) dedup. Migrations follow the repo's `ensureColumnExists` + `CREATE INDEX IF NOT EXISTS` pattern (no formal migration framework).

Conversation search adds a full-text index, `messages_fts`: an **external-content** FTS5 table (`content='messages'`, no duplicated content column) over `content` + `file_name`, keyed on the `messages` integer `rowid`, using the **`trigram`** tokenizer for case-insensitive substring matching. Three triggers keep it in sync — `AFTER INSERT`, `AFTER DELETE`, and `AFTER UPDATE OF content, file_name` (guarded by a value-change `WHEN` so routine `transfer_status`/`local_send_state`/receipt writes don't churn the index). It is created idempotently with a one-time `'rebuild'` backfill on first creation only. The trigram tokenizer keeps an indexed copy of derived 3-gram posting data in shadow tables (`messages_fts_data`/`_idx`/`_docsize`/`_config`); this lives in the same plaintext DB file under the same OS-disk-encryption trust model. Search itself is exposed via `searchChatMessages(chatId, query, { limit, snapshotMaxRowid, cursor })` (IPC `messages:searchInChat`), scoped to one chat, excluding system messages, newest-first. Column scope: text messages match `content`, file/image messages match `file_name` only. Queries ≥3 chars use the indexed trigram MATCH (refined by a type-scoped LIKE); 1–2 char queries fall back to a chat-scoped LIKE (trigram cannot index <3-char terms). Pagination is **keyset** on `(timestamp, rowid)` — not OFFSET — so a message deleted mid-search cannot shift later pages; `snapshotMaxRowid` additionally freezes the searchable universe and total for the life of one query.

Practical rule: relationship/context (`chats`, participants, statuses) is authoritative for UI behavior, not `users` cache alone.

---

### 11. Connectivity and infrastructure

#### 11.1 Bootstrap node

`npm run bootstrap` launches a mode-aware validator node.

Current behavior:
- persistent Level datastore at `./bootstrap-datastore/<mode>`
- validator stack active for username, direct offline, group offline, group info records
- startup mode comes from `BOOTSTRAP_NETWORK_MODE=fast|anonymous`
- announce addresses come from `BOOTSTRAP_ANNOUNCE_ADDRS` as a comma-separated list

Operational notes:
- bootstrap announce addresses are raw announce multiaddrs, not client-facing `/p2p/...` addresses
- the process prints its Peer ID on startup; client-facing bootstrap entries are formed as `<announce_addr>/p2p/<peerId>`
- anonymous bootstrap does not spawn Tor by itself; if you run `BOOTSTRAP_NETWORK_MODE=anonymous`, your onion service must forward the announced onion address to the local bootstrap listener (default: TCP 9001)

#### 11.2 Relay node

`npm run relay` provides Circuit Relay v2 reservations for fast mode.

Operational notes:
- relay listen address defaults to `/ip4/0.0.0.0/tcp/4002`
- announce addresses come from `RELAY_ANNOUNCE_ADDRS`
- the process prints its Peer ID on startup; client-facing relay entries are formed as `<announce_addr>/p2p/<peerId>`
- optional tuning env vars include `RELAY_MAX_RESERVATIONS`, `RELAY_RESERVATION_TTL_MS`, `RELAY_DEFAULT_DURATION_LIMIT_MS`, and `RELAY_DEFAULT_DATA_LIMIT_BYTES`
- there is no relay layer in anonymous mode

#### 11.3 Client connectivity UX

The main window sidebar is now split into:
- a thin left navigation rail for `Chats`, `Groups`, and `Setup`
- a context pane that changes based on the selected rail section
- utility rail actions at the bottom for `Profile`, `Settings`, and `Help`

Current navigation rollout status:
- `Chats` shows the legacy mixed sidebar content (direct chats, group chats, and request/invite sections)
- `Groups` shows group invites plus a groups-only chat list
- `Setup` shows mode-aware context navigation for bootstrap, relay, and ICE configuration
- the Bootstrap Setup pane is a page-native workspace with separate status, configured-server, and add-server sections; it supports listing, adding, removing, ordering, copying, retrying, and viewing current liveness
- the Relay Setup pane provides the equivalent controls for Fast-mode relay nodes and relay reservation retries
- a relay retry is reported as failed when none of the attempted relay reservations connect; partial connectivity reports the connected/attempted count
- the ICE Setup pane supports adding, editing, removing, ordering, copying, and testing STUN/TURN servers
- ICE test results are retained in renderer Redux for the current app session and include a test timestamp; editing or removing a server invalidates its previous result
- ICE tests continue to completion if the user navigates away, while request IDs prevent older overlapping tests from replacing newer results; Test-all batch state is tracked separately so its progress indicator remains active until every test in that batch settles
- Setup context navigation and content use one continuous background treatment; when the context pane is collapsed, Bootstrap, Relay, and STUN/TURN remain available as icon-only actions
- the Setup context pane keeps its internal content at the final expanded width while the parent clips the width transition; labels fade out quickly on collapse and fade in after expansion begins, avoiding repeated text wrapping and competing horizontal motion
- `Settings` is the single settings entry point and is a rail-only page with page-native action rows for About, Notifications & Sounds, downloads, network-mode switching, application configuration, database backup, account deletion, and quitting the app; the duplicate footer settings button and legacy settings modal have been removed
- in anonymous mode, the Settings page also exposes Tor transport settings; edits require explicit confirmation and an app restart, and a failed automatic restart leaves a visible manual-restart action after the settings have been saved
- changing network mode requires confirmation and an app restart; if the mode is saved but automatic restart fails, the Settings page keeps the running mode distinct from the pending saved mode and tells the user that a manual restart is required
- database backup uses a native save dialog and leaves the user on Settings after completion; the backup is a raw SQLite copy and is not encrypted as a whole (encrypted identity blobs remain password-encrypted, but decrypted message content and other local data are readable), so it must be stored as sensitive data; account deletion requires a typed confirmation before wiping local data and restarting, removes the resolved `kiyeovo-uploads/` directory (pasted images and generated text uploads) while leaving downloads untouched, and uses a native error dialog before still restarting if upload cleanup fails after the database wipe; closing the confirmation dialog always clears the typed phrase
- quitting from Settings requires confirmation and then uses Electron's existing graceful shutdown path, which closes network services and the database before process exit
- `Help` is a rail-only Questions & Answers page with local searchable accordion content and category filters for explaining user-facing P2P concepts such as the app's high-level P2P/DHT model, dual network modes, anonymous mode, username registration, trusted profiles, offline delivery, offline file-sharing limits, bootstrap/relay servers, STUN/TURN call setup, troubleshooting, security/privacy expectations, backups, self-hosting, and feedback reporting
- `Profile` is a rail-only page that is the single home for identity management (peer ID, username registration, change username, auto-register toggle, trusted-profile export, and unregister); it reuses the existing register and identity dialogs rather than re-implementing them inline. The auto-register toggle is a registered-only row on the tab itself (moved out of `UserDialog`); trusted-profile export is reachable in both states via `ExportDialog`
- the `Profile` rail action shows an amber attention dot while no username is registered, nudging first-run users toward registration; the dot uses a profile-specific accessibility label rather than the Setup wording
- the sidebar footer adapts to identity state: a registered user's identity chip is a shortcut into the `Profile` tab, while an unregistered user's Register button opens the registration modal in place (it does not navigate to the tab); the empty chat-area and chat-list "Register" calls-to-action route to the `Profile` tab instead of opening a modal directly
- registration logic is owned by a single shared `RegisterIdentityDialog` wrapper (register handler, loading/error state, and Redux updates) used by both the footer and the `Profile` tab, so the two entry points cannot diverge
- `Help` remains a placeholder pane
- the left rail remains visible while the adjacent sidebar pane can collapse independently
- the left rail may expand on hover/focus as an overlay to reveal labels without shifting the main layout
- `Main` owns the active rail section and active Setup subsection so the sidebar context pane and main content area use the same navigation state
- navigation state is renderer-local UI state; it is not persisted or stored in Redux
- initial infrastructure onboarding persists `not_started`, `in_progress`, `completed`, or `skipped` independently for fast and anonymous mode; Electron derives the active-mode settings key rather than accepting a mode from the renderer, and absent or invalid values read as `not_started`
- `not_started` opens a dedicated full-window welcome page; `Start setup` enters a full-window mode-aware guide around the real Setup pages, while `Skip for now` opens Chats
- fast-mode guidance progresses through Bootstrap, Relay, an optional Register step, and optional STUN/TURN configuration (in that order); anonymous-mode guidance contains Bootstrap followed by the optional Register step
- the optional Register step reuses the shared `RegisterIdentityDialog`; it is "configured" when a username is registered (`user.registered`) and may be skipped like Calls. It is layered into the wizard via a wizard-local `WizardStepId = SetupSection | 'register'` and an internal flag, so `register` is never added to `SetupSection` and `Main` keeps driving only the network steps (the wizard renders its own register panel instead of the passed network page when the register step is active)
- the guide's numbered step indicators are clickable, so users may configure sections in any order without skipping the entire guide
- Bootstrap and Relay must still contain configuration before the Ready state can be reached; the Register and STUN/TURN steps may be skipped, and the Ready summary does not describe an unconfigured or warning-acknowledged ICE list (or an unregistered identity) as configured
- starting, skipping, and completing the guide persist `in_progress`, `skipped`, and `completed` respectively before changing the UI; failed writes leave the current onboarding surface open. When resuming an `in_progress` guide, the wizard waits for an initial user-state snapshot before deciding whether to auto-open Register, so already-registered users are not routed there by the default unregistered Redux state
- restarting an `in_progress` guide keeps the app behind an opaque loading surface until both persisted status and Setup readiness are available, then opens the first missing required section, or Calls in fast mode when Bootstrap and Relay are already configured; the resume decision is applied once so later readiness refreshes do not move the active step
- switching network modes preserves each mode's independent onboarding history; removing configuration later shows normal Setup warnings without reopening a completed or skipped guide

Setup readiness is mode-aware:
- anonymous mode evaluates bootstrap only
- fast mode evaluates bootstrap, relays, and ICE configuration
- no configured bootstrap produces a red Setup indicator
- in fast mode, no configured relay produces an amber Setup indicator
- missing ICE configuration produces an amber Setup indicator unless the user explicitly acknowledges that they do not plan to use calls
- acknowledging missing ICE suppresses only its global warning; it does not mark calls as configured
- setup readiness checks configuration existence only; it does not represent current server reachability
- unreadable bootstrap configuration produces a red indicator; unreadable relay or ICE configuration produces amber when bootstrap configuration is known to exist
- the Setup context navigation mirrors readiness per subsection: missing Bootstrap is marked red, missing Relay or ICE is marked amber, and read failures are labeled as status unavailable rather than not configured; these dots remain visible in the collapsed icon-only pane
- renderer Setup navigation signals may target Bootstrap, Relay, or STUN/TURN directly; `Main` remains the owner that applies the requested rail section and Setup subsection

Contextual infrastructure guidance is owned by `ConnectivityGuidanceProvider`, which consumes Setup readiness but does not redefine it:
- starting or accepting a direct or group call with no configured ICE servers opens one confirmation per renderer session; the user may open STUN/TURN Setup or try anyway
- acknowledging the passive missing-ICE reminder does not suppress this action-triggered confirmation
- calls are not disabled solely because ICE is missing, because host candidates may still work on a local network
- a direct WebRTC connection failure or a group-call participant connection timeout shows a cooldown-limited warning with a STUN/TURN Setup action only while ICE is known to be missing; the wording covers both initial connection and a failed active media path, while rejection, ringing timeout, signaling errors, and media-permission failures do not claim an ICE problem
- local direct-call ICE candidates are buffered until the initial offer or answer has been delivered; this prevents candidate signaling from racing the initial SDP dial, and later ICE-send failures are logged without producing duplicate user-facing errors
- outbound call signaling failures are returned to the initiating renderer action instead of also being emitted as global call errors; unreachable-peer failures are typed and shown once with user-friendly wording, while unsolicited inbound validation errors remain global events
- message send responses and background send-state events carry typed `bootstrap_unavailable` or `peer_unreachable` connectivity reasons from the core/IPC boundary; renderer components do not parse human-readable errors to choose infrastructure guidance
- `bootstrap_unavailable` links to Bootstrap Setup only when the readiness snapshot also confirms that no bootstrap server is configured
- `peer_unreachable` links to Relay Setup only in fast mode when no relay is configured, and the wording says a relay may improve reliability rather than claiming it caused the failure
- successful online sends and successful offline DHT delivery remain silent; guidance appears only for terminal send failures and is cooldown-limited to avoid repeated popups
- action-bearing warning toasts use a wider desktop layout than ordinary toasts so guidance text and its Setup action remain readable without widening short notifications
- toast auto-dismiss timing is owned by the Radix toast lifecycle, so all toast variants pause dismissal while hovered, focused, or while the window is blurred

Setup readiness is owned by a provider around the main application. The rail consumes only readiness state, while Setup pages consume a stable refresh action. Successful Bootstrap, Relay, or ICE Setup add/remove actions trigger a new read so the rail indicator reflects configuration completeness without placing readiness state or invalidation counters in `Main`.

Bootstrap and Relay Setup pages cache their configured-node lists and per-node liveness in Redux (the `setupNodes` slice, keyed by section). The pages still own fetching and the 3-second liveness polling, which runs only while a page is mounted, so no background polling continues for unmounted pages. Redux retains the last-known snapshot, so navigating away and back renders the cached list immediately instead of re-flashing a loading/checking state; only the first load per app session shows a loading state until the initial snapshot is cached. Each section tracks a monotonic generation that every mutation (add, remove, reorder) increments. A configuration read captures the generation when it starts and is discarded on arrival if a newer mutation has occurred, preventing a slow in-flight poll from overwriting a more recent list or order with a stale snapshot that would otherwise persist in the cache.

The legacy Connection Status dialog and its dialog-specific tab components have
been removed. Bootstrap, relay, and ICE configuration now live exclusively in
their Setup panes. The sidebar connection-status button routes directly to
`Setup -> Bootstrap`.

"Online" status is DHT-reachability focused, not just generic socket presence.

Default bootstrap, relay, and ICE lists are currently empty. Users must provide infrastructure for the selected mode.

#### 11.4 Tor and anonymous-mode setup

Anonymous desktop clients use the bundled Tor binary stored under `resources/tor/<platform>`.

Practical notes:
- `npm run download:tor` downloads Tor for the current platform
- `npm run setup` performs install + Tor download together
- the desktop app runs its bundled Tor instance on ports `9550/9551` by default to avoid clashing with system Tor / Tor Browser
- bootstrap infrastructure for anonymous mode is still a separate node process plus an onion service in front of it; the desktop client bundle only covers the client-side Tor dependency

#### 11.5 WebRTC ICE / STUN / TURN

Current behavior:
- calls are fast-mode only and use WebRTC media in the renderer
- the default ICE list in `src/core/network/default-infrastructure.ts` is currently empty
- users can add runtime ICE overrides from Setup in fast mode
- supported entry types are `stun`, `turn`, and `turns`
- TURN entries require username + credential
- multiple ICE servers are supported and passed to `RTCPeerConnection` in configured order; the browser's ICE agent may gather and check candidates in parallel, so this is not a strict first-server-then-next retry order

Practical self-hosting path:
- run a TURN server such as coturn
- open `3478/tcp`, `3478/udp`, and the relay port range you configure (for example `49160-49200` on both TCP and UDP)
- add matching STUN/TURN URLs in the app UI instead of rebuilding

Notes:
- Setup can probe each configured server through the renderer's WebRTC engine: STUN requires a server-reflexive candidate, while TURN/TURNS requires a relay candidate and distinguishes invalid credentials when WebRTC reports an authorization failure
- test results describe the last explicit test rather than continuous health; they remain in memory for the app session and display how long ago the test completed
- if an ICE entry list is saved, that runtime list is used instead of the empty default constant
- users may acknowledge the missing-ICE Setup warning if they do not plan to use calls; call setup remains visibly unconfigured

---

### 12. UI and state management

Renderer stack: React + Redux.

Main slices:
- `userSlice` (identity, connected state, registration flags, mode markers)
- `chatSlice` (chats/messages, pending KX/contact attempts, group/file/call events)
- `appConfigSlice` (runtime-editable limits/settings)

DHT connectivity freshness (`userSlice.connected`) is maintained globally by an always-mounted `useDHTConnectionStatus` hook in `Main` (snapshot + `dht-connection-status` subscription). This keeps the connected flag correct in rail-only views (Profile/Settings) and the setup wizard, where `SidebarHeader` is not mounted, so the registration UI no longer falsely reports the network as disconnected. `SidebarHeader` retains its own auto-register-on-connect logic; only connectivity reporting was lifted to the global hook, not auto-register ownership.

Main event sinks from Electron:
- message/chat/group events
- file transfer lifecycle events
- call incoming/signal/state/error events
- screen-share source selection requests from Electron main

Composer behavior:
- chat composer is multiline
- `Enter` sends the current message while `Shift+Enter` inserts a newline
- drafts auto-expand up to five visible lines, then switch to internal scrolling
- direct and group text messages have a 2,048-character send limit
- sending a trimmed direct-chat draft above 2,048 characters opens a text-file conversion dialog before the offline text-mailbox capacity check; group chats keep the hard-limit error because group file transfer is not supported
- the conversion dialog shows the trimmed character count and UTF-8 byte size, warns that the recipient must be online, preselects an editable `long-message-YYYYMMDD-HHMMSS.txt` filename, and disables confirmation while another transfer is active or the configured file-size limit is exceeded
- after generated text is saved, the existing direct file-offer path remains the sole owner of the optimistic file row and transfer state. The original draft stays visible until the awaited file transfer confirms completion; offline/busy failure, rejection, expiry, save failure, and transfer failure preserve it
- composer drafts have an in-memory monotonic revision per chat. Successful generated-text transfer clears the source chat's draft only when its revision is unchanged from conversion start, so editing and later restoring the same text still prevents automatic clearing
- long-message sends capture the source chat and peer explicitly, preventing a later chat switch from retargeting the generated file; switching chats while the confirmation dialog is open closes it without changing the draft
- message selection mode is entered either from **Select messages** in the direct/group chat header menu or from a message's hover/focus chevron menu; choosing the row action enters the mode with that message selected. The chevron fades/slides in, and its menu opens downward in the upper viewport half or upward in the lower half; right-clicking the message bubble/card opens the same row menu unless the target is editable text or inside the active text selection, in which case the native text context menu is allowed instead. Empty row space does not open the message menu. The same row menu holds **Reply** when the message is replyable, **Copy** for text messages, plus other eligible row actions. While selection mode is active the chat header's right-side controls (call / group-call / overflow menu) are replaced by a single **Cancel** button; the composer area keeps `ChatInput` mounted but hidden/inert (preserving drafts and in-flight send queues) and shows a selection bar with the left-aligned `N selected` count and the **Delete** action. The mode exits on **Cancel**, on `Esc`, on leaving the chat, or on switching out of the Chats/Groups section (the `ChatWrapper` stays mounted when hidden, so `Main` passes an `active` flag that cancels selection when the section is left). Settled and failed text messages are selectable. File/image rows are selectable only after reaching a terminal state (`completed`, `failed`, `expired`, or `rejected`); queued/sending messages and active file transfers remain protected. Reply, copy, jump, retry, and file controls are inert while selection mode is active.
- conversation search is entered from **Search messages** in the direct/group chat header menu or with `Ctrl+F` / `Cmd+F`. The shortcut refocuses an open search and is consumed without leaving message-selection mode. Search replaces the complete chat header with an auto-focused search field and **Cancel**, while `ChatInput` remains mounted but hidden/inert so drafts and send queues survive. The search header owns the live input locally and emits only a 250 ms debounced query to `ChatWrapper`, preventing each keystroke from re-rendering the full message tree. Settled queries search the entire local chat history through `messages:searchInChat`; the composer area shows `N of total` on the left and previous/next controls on the right. Results are newest-first, fetched in cursor pages only when navigation crosses the loaded boundary, and each result reuses the bounded message jump-window path described in §5.4. `Enter` / `Shift+Enter` step to the next / previous match and `Esc` cancels search (the keyboard listeners are mounted only while search is open, so normal composer `Enter`-to-send is untouched). While search is open every loaded message highlights the matched query fragments inline — in text bubbles and filenames, rendered as React text segments only (never HTML injection) — and the active search result additionally keeps a persistent accent border until navigation or search cancellation. That border is drawn with `outline` rather than `box-shadow` so it stays visible immediately and throughout the reply-pulse, which animates `box-shadow` on the same bubble; the transient pulse starts only after the target row is visible and scrolling has settled. Search requests and jumps carry renderer generations/request IDs so rapid typing, cancellation, chat changes, or section changes cannot apply stale results or leave navigation pending. Search and selection are structurally exclusive because both entry actions live in the normal header menu, which is absent while either mode is active.
- **Delete for me** requires confirmation and removes selected message rows only from local state/storage; it sends no peer notification or protocol tombstone and does not delete transferred files. Renderer-only failed optimistic rows are removed without IPC. Persisted rows are revalidated and deleted in one database transaction, together with any durable direct-send or group-backup retry record they own; matching in-memory group retry state is then discarded. Stale, duplicate, cross-chat, newly active, or otherwise ineligible selections fail without partial deletion. The renderer updates only after transaction success, clears a reply target that referenced a deleted message, and reconciles the chat preview against both the latest remaining settled database row and any newer settled message already in Redux; unsent rows are excluded from this preview. It then invalidates pagination and refetches the visible history window, merging messages that arrived during the request before resetting the database offset. Selection remains active on failure and exits on success; while its confirmation dialog is open, the dialog owns `Esc`.
- pasted line breaks are preserved in both the draft and rendered text messages
- opening a chat establishes stick-to-bottom intent; asynchronous message growth such as image loading keeps the latest message anchored until the user explicitly scrolls upward, while returning to the bottom restores anchoring
- every normal message renders its timestamp in 24-hour `HH:mm` format inside the bubble at bottom-right; text reserves timestamp width at the end of its final line so short messages share one line with the time instead of receiving permanent extra height. Delivery/retry metadata remains below the bubble, while system-event timestamps remain centered below their event
- rendered text message bubbles expose Copy through the hover/focus chevron menu and the bubble/card right-click menu, copying only the message text content to the clipboard; selected text and editable fields use a main-process native context menu for standard text actions such as Copy, Paste, and Select All
- completed inline image messages expose **Copy image** through the hover/focus/right-click row menu and the fullscreen preview dialog
- messages can be **replied to**: a hover reply affordance and the message row dropdown's **Reply** action quote a specific message and focus the composer; the composer shows a cancelable reply bar (survives chat switches, `Esc`/✕ to cancel); the quote renders as a full-width header enclosed inside the reply bubble (resolved by live lookup, shows *"Original message unavailable."* if the original is gone), so the quote and reply share the width of whichever is wider. Clicking the quote jumps to the original before starting a 2.5-second highlight pulse once the target is visible, paging older history in if needed. Reply works in both direct and group chats; it is hidden only on un-settled/failed sends (and on files until transfer completes). When the viewport is away from the latest message, a floating down-chevron returns it to the bottom. See §5.4.
- inbound message notifications are batched over a short renderer-side window so offline/startup bursts produce one sound and one summary desktop notification instead of one per message

UI is event-driven while core remains authoritative.

Wake/resume behavior:
- on OS `resume` / `unlock-screen`, the renderer shows a temporary banner: `Waking up... give me 30 more seconds`
- the banner hides early when the wake-triggered reconnect and recent-chat offline sync both settle; otherwise it auto-hides after 30 seconds

Offline inbox capacity panel behavior:
- the panel auto-opens for confirmed offline delivery, full-inbox errors, or explicit user open; it does not auto-open for the provisional non-blocking `sending` state before a direct message has actually fallen back to offline

Call UI state:
- Redux tracks active call state plus screen-share local lifecycle (`idle` / `starting` / `sharing` / `stopping`) and remote sharing state
- `CallService` remains the owner of `RTCPeerConnection`, local/remote `MediaStream`s, display capture tracks, and sender replacement
- fullscreen call controls sit above the fullscreen video surface, fade after idle, and reappear on user activity
- dialogs are layered above call fullscreen controls so source pickers and safety prompts remain reachable

---

### 13. Security model and key decisions

1. Direct E2EE:
   - session crypto post-KX
   - signed KX payloads and timestamp guards

2. Offline integrity:
   - message and store signatures
   - validator enforcement

3. Group integrity and recovery:
   - signed control messages
   - ACK + republish + resync
   - encrypted group-info metadata in DHT

4. Access policy:
   - blocked peers
   - contact mode (`active` / `silent` / `block`)
   - connection gater checks

5. Mode isolation:
   - protocol + namespace + topic + DB scoping

6. Renderer hardening:
   - `contextIsolation: true`
   - `nodeIntegration: false`
   - renderer CSP present in `index.html`
   - `webPreferences.sandbox: true`
   - packaged UI is served via a custom `kiyeovo://app/...` protocol instead of `file://`
   - local images use a separate CSP-allowlisted `kiyeovo-media://` capability protocol; the renderer cannot register arbitrary paths
   - packaged builds flip a minimal Electron fuse set via `electron-builder`:
     - disable `runAsNode`
     - disable `enableNodeOptionsEnvironmentVariable`
     - disable `enableNodeCliInspectArguments`
     - disable extra `file://` privileges
     - enable embedded ASAR integrity validation
     - leave `OnlyLoadAppFromAsar` for a later follow-up
   - preload is bundled as a standalone artifact so it remains compatible with sandboxed Electron preload constraints
   - the renderer bridge is an explicit whitelist exposed through `contextBridge`; raw `ipcRenderer` is not exposed to the UI
   - unpackaged Linux development may still require machine-level `chrome-sandbox` helper setup on some VM/distro combinations
   - IPC sender validation in the main process:
     - only the main app window's main frame can invoke privileged IPC handlers
     - untrusted IPC senders are rejected and logged in the main process
   - navigation blocking in the main window:
     - deny unexpected navigations away from the trusted app UI
     - `target="_blank"` / new-window requests are denied inside Electron
     - only an explicit allowlist of trusted external `https` URLs is opened via the OS browser
     - the policy is centralized in the Electron layer rather than embedded inline in startup orchestration
   - embedded `webview` usage is explicitly blocked because Kiyeovo does not rely on in-app website embedding
   - explicit session permission handling:
     - deny renderer permission requests by default
     - allow only trusted main-frame requests for `media`, `display-capture`, `speaker-selection`, and sanitized clipboard writes, preserving calls, screen sharing, output-device switching, and copy actions without broad renderer permission grants
     - display-media requests are additionally routed through Electron's display-media handling; the Linux fallback source selection uses trusted IPC and source IDs produced by main process enumeration

---

### 14. Reliability and operational strategies

Current resilience layers:
- periodic DHT status probing
- bootstrap/relay retry mechanisms
- pending-ACK republish cycles (including retirement/reactivation behavior)
- per-bucket mutation locks for offline store writes
- durable offline-send / group-backup queues with crash-safe (transactional) state and manual retry
- group offline check orchestration with single-flight style guards
- startup cleanup of interrupted file transfers (and reconciliation of interrupted offline sends → `failed`)

---

### 15. Known tradeoffs and limits

- Mode switch requires restart.
- Single SQLite file increases mode-scoping complexity.
- Offline behavior is eventual consistency over DHT propagation.
- Group control delivery is ACK/republish based (not strict real-time consensus).
- Direct 1:1 calls are currently fast-mode only.
- Screen sharing currently sends display video only; system/window audio sharing is intentionally out of scope for the current phase.
- STUN/TURN reachability tests are manual point-in-time snapshots; there is no continuous ICE health monitoring.
- On some Linux environments, sandboxed unpackaged Electron runs may still require host-specific sandbox-helper setup during development.
- Unpackaged restart uses an explicit relaunch path for Linux development robustness; packaged releases still target the standard Electron relaunch behavior.

---

### 16. Recommended "AI handoff" text

To quickly bootstrap a new AI chat:

1. "Read `Kiyeovo_desktop_technical_documentation.md` as the source-of-truth architecture."
2. "I am currently working on [bug/feature], in [fast/anonymous] mode, focus area [direct/group/file/call/offline]."
3. "Provide a minimal-change plan + regression risks + verification checklist."

---

### 17. Short glossary

- KX: key exchange
- DCUtR: Direct Connection Upgrade through Relay
- Bucket nudge: lightweight hint to refetch offline bucket data
- Group epoch: group key version (`key_version`)
- Resync request: member->creator request for fresh group state snapshot
- Pending ACK queues: local control payload queues republished until ACK/terminal outcome

---

### 18. Conclusion

Kiyeovo Desktop MVP combines:
- mode-aware P2P messaging
- robust offline fallback
- group state reconciliation and encrypted group metadata distribution
- controlled file transfer pipeline
- fast-mode direct calling with optional camera and screen sharing

The main engineering priorities going forward are preserving mode isolation, keeping flow complexity manageable in message/group handlers, and documenting trust/identity/DHT-semantic changes as first-class artifacts.
