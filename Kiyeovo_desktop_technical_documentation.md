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
- Group chat uses:
  - mode-scoped GossipSub for realtime content
  - control messages over pairwise offline buckets
  - ACK/republish mechanisms for reliability
  - key epoch rotation
  - encrypted group-info metadata in DHT versioned records
- Calls are implemented for fast mode direct chats:
  - 1:1 audio/video
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

---

### 5. Direct chat flow

#### 5.1 Online path and contact policy

1. User sends message to username or peer ID.
2. `MessageHandler.sendMessage` ensures contact + session.
3. If needed, key exchange runs.
4. Session-encrypted payload is sent on `chatProtocol`.
5. Message persists locally and UI event is emitted.

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

#### 6.6 Nudge mechanism

Bucket nudges are best-effort acceleration hints (not a correctness dependency):
- direct bucket nudge
- group-refetch nudges
- cooldowns and sender validity guards

---

### 7. File transfer

File transfer uses dedicated `fileTransferProtocol`.

Flow:
1. sender emits signed `file_offer` with timeout
2. receiver accepts/rejects
3. accepted transfer sends encrypted chunks
4. progress/completion/failure events update UI and DB

Current operational behavior:
- one active transfer per peer at a time (prevents stream contention)
- incoming download can be canceled by user
- non-terminal transfers are marked failed on app restart/close
- duplicate filename handling uses copy-style timestamped filenames

Protections:
- rate limits (per peer + global)
- max pending offers (per peer + global)
- silent rejection thresholds for abuse
- path traversal and file-size guards
- backend remains authoritative even if UI pre-checks exist

---

### 8. Calls (MVP scope)

Call support is implemented for direct chats in fast mode.

Scope:
- 1:1 audio and video
- no group calls yet
- no offline call queue (offline/unreachable peers fail immediately)

Architecture:
- signaling over `call-signal` protocol (`CALL_OFFER`, `CALL_ANSWER`, `CALL_ICE`, `CALL_REJECT`, `CALL_END`, `CALL_BUSY`)
- signaling signed and validated in core
- renderer `CallService` owns `RTCPeerConnection` and media tracks

Behavior highlights:
- pre-check for direct contact and active connectivity before offer
- outgoing ring timeout (30s)
- busy/reject/end handling with local cleanup on both sides
- media controls: mute/deafen
- video UI includes compact/fullscreen variants and stream swap controls
- ICE servers default from `DEFAULT_WEBRTC_ICE_SERVERS` in `src/core/network/default-infrastructure.ts`
- fast mode has a runtime ICE editor in `Connection status -> Calls`
- runtime overrides are stored in the settings table and loaded by renderer `CallService` when a call starts or is accepted
- validation is format-based only; there is no built-in health check for STUN/TURN reachability

---

### 9. DHT data model

Primary categories:

1. Username registry
   - by-name and by-peer mapping
   - signed payload with validator/select/update logic

2. Direct offline stores
   - per-recipient bucket model
   - message/store signatures + validateUpdate

3. Group offline stores
   - sender buckets per group and epoch

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
- `group_offline_sent_messages`
- `group_key_history`
- `group_offline_cursors`
- `group_pending_acks`
- `group_pending_info_publishes`
- `group_invite_delivery_acks`
- `group_sender_seq`, `group_member_seq`, `group_epoch_boundaries`
- `file_transfers`
- `bootstrap_nodes`

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

Connection Status dialog supports:
- bootstrap list management and ordering
- relay reservation retry in fast mode
- explicit bootstrap retry
- mode-sensitive tabs and counters

"Online" status is DHT-reachability focused, not just generic socket presence.

Current beta clients also seed default public bootstrap/relay entries from source constants. Those defaults can be overridden from the UI without rebuilding.

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
- default ICE servers are defined in `src/core/network/default-infrastructure.ts`
- users can add runtime ICE overrides from `Connection status -> Calls` in fast mode
- supported entry types are `stun`, `turn`, and `turns`
- TURN entries require username + credential
- multiple ICE servers are supported and passed to `RTCPeerConnection` in order

Practical self-hosting path:
- run a TURN server such as coturn
- open `3478/tcp`, `3478/udp`, and the relay port range you configure (for example `49160-49200` on both TCP and UDP)
- add matching STUN/TURN URLs in the app UI instead of rebuilding

Notes:
- the app validates ICE entry format, but it does not probe server health yet
- if a custom ICE entry list is saved, that runtime list is used instead of the default constant

---

### 12. UI and state management

Renderer stack: React + Redux.

Main slices:
- `userSlice` (identity, connected state, registration flags, mode markers)
- `chatSlice` (chats/messages, pending KX/contact attempts, group/file/call events)
- `appConfigSlice` (runtime-editable limits/settings)

Main event sinks from Electron:
- message/chat/group events
- file transfer lifecycle events
- call incoming/signal/state/error events

UI is event-driven while core remains authoritative.

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
     - allow only trusted main-frame requests for `media` and sanitized clipboard writes, preserving calls and copy actions without broad renderer permission grants

---

### 14. Reliability and operational strategies

Current resilience layers:
- periodic DHT status probing
- bootstrap/relay retry mechanisms
- pending-ACK republish cycles (including retirement/reactivation behavior)
- per-bucket mutation locks for offline store writes
- group offline check orchestration with single-flight style guards
- startup cleanup of interrupted file transfers

---

### 15. Known tradeoffs and limits

- Mode switch requires restart.
- Single SQLite file increases mode-scoping complexity.
- Offline behavior is eventual consistency over DHT propagation.
- Group control delivery is ACK/republish based (not strict real-time consensus).
- Calls are currently fast-mode direct-chat only (1:1, no group call).
- STUN/TURN validation is format-only; there is no live health-check/testing UI yet.
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
- fast-mode direct audio/video calling

The main engineering priorities going forward are preserving mode isolation, keeping flow complexity manageable in message/group handlers, and documenting trust/identity/DHT-semantic changes as first-class artifacts.
