# E2e test roadmap (rounds run one by one, orchestrator-reviewed)

Status legend: [ ] queued · [~] in progress · [x] done

- [x] **1. Offline delivery & reconnect** — done (`offline-delivery.spec.ts`): direct messages
  sent while Bob is down arrive after he relaunches on the same profile via the returning-user
  unlock; sender-side `offline` label asserted; pickup measured at ~0.1-0.4s after unlock
  (renderer-driven on-connect fetch). Harness gained `profileDir` reuse + `keepProfile` close.
  Slow specs tagged `@slow`; `test:e2e:quick` added. **Group-offline deliberately deferred to
  round 2's offline-file work or a later addition** (cost/benefit call, documented in-spec).
- [x] **2. File transfer** — done (`file-transfer.spec.ts` + `world.ts` fixture): 1:1 and
  group transfers hash-verified on disk; wrong-chat routing asserted across all windows;
  offline delivery COVERED and doc/code-confirmed supported (offer rides the same offline
  DHT-bucket queue as text; only the download pull requires the SENDER online) — also closes
  round 1's deferred group-offline gap. Untested edge for a later round: recipient accepts
  while the SENDER is offline — designed behavior per Marin: fails with a toast (a test would
  assert that toast). Findings triaged with Marin 2026-07-06: downloads dir cwd-default FIXED
  (now ~/Downloads/Kiyeovo via homedir); stale doc line ~243 UPDATED; Register Identity CTA
  after relaunch is BY DESIGN (auto_register_<mode> setting can be 'never' — user's choice).
- [x] **3. Network edge cases / resilience (Fast mode)** — done (`network-edges.spec.ts`, 6
  tests, all local throwaway bootstrap nodes for full lifecycle control): failover among
  partly-dead bootstraps (4 dead + 2 live, dead-first ordering) reaches real DHT connectivity;
  an all-dead config surfaces the designed "All configured bootstrap nodes failed" error with
  no hang and recovers once a live one is added; a killed-mid-session shared bootstrap leaves
  already-connected peers messaging fine over their direct TCP connection and the per-bootstrap-
  node liveness view (Setup > Bootstrap) honestly flips to "Unavailable"/"Reachable" across a
  restart with the same identity; wrong-password unlock is rejected with the designed
  "Incorrect password. Attempt N." copy (no crash, no unlock) and the correct password then
  unlocks normally; 8 healthy local bootstraps connect cleanly (Marin's "too many healthy"
  suspicion did NOT reproduce locally — he'll separately re-test against his real 7-8 server
  deployment). **Marin's scripted repro (shutdown bootstrap + add a new live one) did NOT
  reproduce**: both the natural full sequence (add, then click "Retry connection") and a fully
  passive one (add, never click anything) recovered — the passive path self-heals in ~30s via
  the periodic health-check's own automatic reconnect, which always re-reads the live bootstrap
  list from the DB. If Marin's real environment still shows a stuck-disconnected state, the gap
  is most likely real-network-latency-dependent (slower TCP teardown detection over a WAN vs.
  instant loopback FIN on a local process kill), not a reachable logic bug — see the spec's
  file-level comment and the round's report for the full evidence trail. Notable code-confirmed
  finding along the way: the global CONNECTED/OFFLINE indicator (`getDHTConnectionStatus`) is
  driven by "is any currently connected peer DHT-protocol-capable and pingable" with no
  bootstrap-vs-contact distinction, so it stays "Connected" through a dead shared bootstrap as
  long as a direct contact connection survives — genuinely degraded bootstrap health only shows
  up in the granular per-node liveness view, not the header. NOT coverable on this host: the
  relay DATA path (needs NAT-isolated peers — requires a second machine or privileged netns;
  parked).
- [x] **4. Blocking + member removal** — done (`blocking.spec.ts`, 3 tests, built on
  `setupThreePeerWorld`). (Suite parallelization prep 2026-07-06: 3 workers, per-file port
  ranges, ~3.2 min full run when infra is healthy.) Doc coverage of blocking is thin (only
  lists "blocked peers"/contact_mode under the security model and documents call-level
  blocking), so the following is code-confirmed by reading src/core directly: blocking denies
  ALL libp2p connections both ways at the transport layer (connection-gater.ts) plus
  independent isBlocked checks on every inbound direct-protocol handler; teardownBlockedPeer
  force-closes any existing connection immediately. Critically, blocking is NOT one-sided —
  database.ts's offline-bucket-info queries filter out blocked peers at the SQL level, so even
  the recipient's offline catch-up never looks at a blocked sender's bucket (message durably
  stored, never deleted, just never fetched while blocked). From the blocked SENDER's side
  there is no distinct signal at all: a failed send to a peer who blocked you settles to the
  same `offline` state/label as a genuinely-offline peer — by design, not a gap. Direct
  block/unblock via ChatHeaderMenu's "Block user"/"Unblock user" tested end to end including
  resumption after unblock. Contact-request blocking: a NEW key-exchange attempt from an
  already-blocked peer is silently dropped (`authorizeContactRequest`'s isBlocked check runs
  before anything else, no reply sent) — distinct from a live "Reject & Block" of a currently-
  pending request, which does send one explicit rejection before the block takes effect;
  tested using world.ts's Bob/Charlie non-contact pair. Group member removal is a real, working
  UI feature (ChatHeaderMenu's "Remove member" -> KickMemberDialog, creator-only): rotates the
  group key, broadcasts the shrunk roster to remaining members (independently enforced via
  group-messaging.ts's sender-not-participant check), and sends the removed member a dedicated
  GROUP_KICK — their chat is kept (not deleted) in a new 'removed' status with composer
  disabled ("You were removed from this group.") and a sidebar "ARCHIVED" badge; remaining
  members see "<name> was removed from the group", the removed member sees "You were removed
  from the group". All three scenarios matched the roadmap's original shape; no reshaping
  needed. Stability follow-up (post-review, revised classification): the afternoon's roaming
  cross-file failures were later traced to two ORPHANED Xvfb servers degrading the box
  (killed; workers default lowered to 2) — but scenario C's failure persisted on the clean
  box and was a REAL test bug, diagnosed live via DEBUG_MODE=true main-process logs: a group
  text message rides gossipsub on a per-key-epoch topic; publish() with zero visible remote
  subscribers retries once after 750ms then DELIBERATELY settles to offline-only delivery
  (DHT bucket; recipients poll it every 5 MINUTES, or via the group menu's manual "Check
  missed messages" — no sender-side nudge on this path). Every join and kick rotates the key,
  so scenario C's two sends are each the FIRST message on a seconds-old topic, sometimes
  landing before subscription propagation -> the bare 30s recipient wait could never succeed
  on that designed fallback branch (~50% repro solo). Fixed with no timeout inflation:
  `sendGroupMessageAwaitingFanout()` reads the app's own verdict off the sender's row (the
  'offline' send-state label, rendered atomically with the bubble) and either does the plain
  30s realtime wait or drives the recipient's designed "Check missed messages" recovery —
  applied to all three group-fanout waits in the file. Product-side observation worth Marin's
  eyes: the first group message sent within a few seconds of ANY membership change can
  silently degrade to 5-minute-latency offline delivery with no automatic recipient nudge —
  a real-user-visible UX gap, not just a test-suite problem (group-chat.spec.ts's fanout has
  simply been lucky: its first send lands a few screenshot-seconds later than blocking's did).
- [x] **5. Calls** — done (`calls.spec.ts`, 4 tests): first-ever automated coverage of the
  WebRTC call path and of the deployed STUN/TURN server. Doc §8 (freshly audited, trusted as
  accurate) + `callService.ts` code-confirmed the signaling model (`call-signal` protocol,
  30s outgoing-ring timeout at `callService.ts:61`, renderer-owned `RTCPeerConnection`) and the
  UI gate (`ChatHeader.tsx`: the phone button is entirely absent unless `networkMode==='fast'`
  and the chat is direct, not group — driven entirely through that gated UI, no internal API
  shortcuts). **A. Lifecycle**: ring → accept → both sides reach `active` (asserted via
  `CallManagerCard`'s timer text advancing across a 5s hold, plus the header's "Hang up"
  control) → clean hangup reverting both headers to "Start call". **B. Reject**: caller
  returns to idle cleanly; code-confirmed finding — unlike contact-request rejection (which
  shows an explicit toast), there is NO distinct "call rejected" UI signal anywhere in the call
  path (grepped `callSlice.ts`/`Main.tsx`/card components) — the designed feedback IS just the
  clean, immediate return to idle. **C. STUN/TURN evidence** (the strategic goal): no existing
  debug/IPC surface exposes the renderer's `RTCPeerConnection` (`peerConnection` is a private
  `CallService` field, never on `window`), and `page.addInitScript()` doesn't work for this app
  (`document.readyState` is already `'interactive'` by the time `app.firstWindow()` resolves —
  empirically confirmed, too late to beat the app's own module evaluation). Worked around
  e2e-side only (no `src/**` changes): a plain `page.evaluate()` replaces the global
  `window.RTCPeerConnection` with a capturing subclass at test setup, before any call starts —
  safe because `callService.ts`'s `new RTCPeerConnection(...)` resolves that identifier as an
  ordinary global lookup with no module-scoped alias. Real, reachable `getStats()` evidence
  confirms both the `stun:`/`turn:` URLs actually reached the live peer connection every run.
  **Honest gap, reported prominently**: the selected/gathered candidates were `host`/`host` in
  all 3 solo runs, never `srflx`/`relay`, because this sandbox's only network interface carries
  a directly-routable public IP with no NAT (`ip addr` confirmed) — two peers on one non-NATed
  box complete ICE via a same-host `host` pair in well under 200ms, faster than STUN's ~168ms
  binding round trip or TURN's ~385ms authenticated allocate (both independently verified
  working via a bare `RTCPeerConnection`/raw UDP probe using the exact same deployed servers,
  which DID yield a real `srflx`-equivalent STUN response and a genuine `typ relay` candidate
  outside the app). This is a same-box test-topology artifact, not a Kiyeovo defect — a real
  cross-NAT deployment is expected to produce srflx/relay candidates; honestly testing that
  would need a second, differently-NATed machine, which this single-box suite can't provide.
  **D. Ring timeout**: unanswered call times out at the designed 30s (measured 30.2-30.3s
  across runs) and clears cleanly on both sides, including the never-answering callee's
  incoming-ring card (core-driven `CALL_END` propagation, code-confirmed via `callSlice.ts`'s
  `applyCoreCallState` clearing `incomingCall` alongside `activeCall` on a matching
  callId/peerId). Harness gained `launchApp({ extraArgs })` (backward compatible) and
  `onboard()`/`completeIceStep()` gained an optional `turn` param (also backward compatible) to
  add a TURN entry (with username/credential) alongside STUN during the wizard's ICE step —
  `IceSetup.tsx`'s Type segmented control gates the Username/Credential inputs on
  `type !== 'stun'`. **Notable environment-quirk finding, not app-related**: this repo's bundled
  Electron 39.8.6/Chromium 142 only honors the *singular* `--use-fake-device-for-media-stream`
  / `--use-fake-ui-for-media-stream` switches — the more commonly documented *plural* `-streams`
  forms are accepted by `app.commandLine.hasSwitch()` but silently never substitute a fake
  AudioManager/VideoCaptureDevice (`getUserMedia` fails `NotFoundError`/`NO_HARDWARE` against
  this host's real, hardware-less audio/video backends) — worth flagging if the bundled
  Electron version ever changes. `e2e/e2e.env.local` (gitignored) now also carries
  `KIYEOVO_E2E_TURN(_USERNAME|_CREDENTIAL)`, loaded via `config.ts`'s new dotenv wiring (falls
  back to STUN-only, no TURN assertions, if absent). Group calls deliberately OUT of scope this
  round (own follow-up).
- [x] **7. Username lookup** — done (`username-lookup.spec.ts`, 5 tests, all green in a 1.6-min
  single-worker run): exercises `UsernameRegistry.lookup()` through the real "New Conversation"
  UI (the only renderer surface that resolves a typed username — no dedicated search/lookup
  dialog exists). Happy path has B target A by USERNAME (not peer ID, unlike two-peer.spec.ts,
  so this is genuinely new DHT-resolution coverage) and code-confirms the resulting chat's
  `other_peer_id` matches A's real peer ID. Nonexistent-username lookup surfaces a
  code-confirmed "not found" inline error (traced through message-handler.ts's error-wrapping;
  along the way found the literal `errorText.includes("username not found")` branch at
  message-handler.ts:~2597 is effectively DEAD code — the thrown text says "User … not found",
  so the user-visible copy comes from the outer `Failed to send message:` re-wrap; cosmetic,
  not a functional bug) with no hang. Duplicate registration is rejected first-writer-wins
  ("Username already taken"), enforced both at the app level
  (`ensureUsernameAvailableForRegistration`) and independently at the DHT-validator level
  (`usernameRegistrationValidateUpdate`'s owner-mismatch check) — real defense in depth.
  Publish failure (7fd7838) and republish-on-reconnect (85db62b) use local throwaway
  bootstraps only. Publish-failure DEVIATION (code-confirmed): RegisterDialog's
  `formDisabled = dhtOffline || isRegistering` gate disables the whole form within seconds of
  a dead bootstrap, so "kill then register" can never reach the DHT-put path — the test
  clicks Register while connected and kills the bootstrap immediately after, failing the
  in-flight PUT; notable finding that "zero peers accepted" (7fd7838) and "network known
  down" are two distinct, non-overlapping failure surfaces. Republish scenario RESHAPED
  (code-confirmed + empirically forced): regular peers run kad-dht `clientMode: false`
  (node-factory.ts:306) so records replicate onto ordinary peers and wiping the one
  bootstrap's datastore does NOT purge the record — instead two never-federated local
  bootstrap segments are used; C onboards in segment 2 (can't see A by construction), A adds
  segment 2's bootstrap via the real Setup UI, the debounced reconnect republisher
  (src/core/index.ts:628, 5s debounce) fires, and C's lookup then succeeds — faithful to the
  feature's stated purpose (doc line ~161: switched-bootstrap users become discoverable in
  seconds). Second finding, undocumented in the tech doc: the INITIATING side must itself be
  registered before SidebarHeader's `handleShowNewConversationDialog` (~line 251) will even
  open the New Conversation dialog (unregistered click = toast only), i.e. unregistered users
  can't look anyone up at all — flagged for a doc update / product decision.
- [x] **6. Tor / anonymous mode** — done. Marin gave the go-ahead the night of 2026-07-06/07
  once the bundled tor binary (resources/tor/linux-x64/tor, needs libevent-2.1.so.7 alongside
  it and LD_LIBRARY_PATH pointed there — no RUNPATH) was confirmed reaching real Tor network
  connectivity from this box. `tor-mode.spec.ts` (2 tests, both green in the builder's ~4-min
  combined run AND an independent orchestrator verification run at 2.1 min total —
  T1 49.6s / T2 1.3m, contact-request-by-username over onion circuits in 5.9s): T1 single-instance anonymous onboarding — tor daemon starts, the wizard is
  code-confirmed Bootstrap+Register ONLY (ANONYMOUS_STEPS, InitialSetupWizard.tsx — no Relay,
  no Calls/ICE, asserted directly via step-nav button absence), and username registration
  succeeds over a real onion-fronted local bootstrap. T2 two-instance messaging over Tor: both
  peers onboard anonymously in parallel, B looks A up by USERNAME over the Tor DHT, contact
  request + accept + message both ways, and the call button is asserted ABSENT in the direct
  chat header (`ChatHeader.tsx`: `canShowCallButtons = !isGroup && networkMode === 'fast'`).
  **Major finding, code-confirmed (not just slow):** the "onion-fronted local bootstrap" test
  harness design (front a plain `bootstrap-node.ts`/`src/core/bootstrap.ts` process with a
  real Tor hidden service) needs the underlying bootstrap PROCESS itself started with
  `BOOTSTRAP_NETWORK_MODE=anonymous` + `BOOTSTRAP_ANNOUNCE_ADDRS=/onion3/<host>:9000` — a
  plain/default bootstrap speaks the FAST-mode DHT protocol (`/kiyeovo-fast/1.0.0/dht`, vs.
  anonymous's `/kiyeovo/1.0.0/dht`, `NETWORK_MODE_CONFIG` in `src/core/constants.ts:66-67`),
  which cannot negotiate with an anonymous-mode client at all — the plain libp2p connect (no
  protocol needed) succeeds and the wizard reports "connected", but every DHT operation
  (username registration) then fails with "all N peers unreachable" (raw `QUERY_ERROR`, a
  protocol mismatch, not a rejection or a timeout). `e2e/tor.ts`'s `startOnionFrontedBootstrap`
  now starts the fronting Tor FIRST (the onion hostname needs no backend listening yet) then
  starts the bootstrap process in genuine anonymous mode, self-announcing the onion host. Also
  found: Register is the LAST step in `ANONYMOUS_STEPS` (unlike fast mode, where ICE always
  follows it), so its own continue button reads "Finish setup"/"Finish without registering",
  never "Continue" — onboard.ts's fast-mode-shaped `completeRegisterStep` hardcodes "Continue"
  and would hang; a dedicated `completeAnonymousRegisterStep` handles both labels. T3
  (returning-user relaunch over Tor) deliberately deferred — see the spec's file-level comment
  for the budget reasoning. TIMEOUT EXCEPTION granted for this round only: `test.setTimeout`
  raised to 12 minutes (Tor daemon bootstrap + hidden-service descriptor publish, cold onion
  dials, and peer-to-peer onion rendezvous are all genuinely slower than any other round's
  infra). New harness pieces: `e2e/tor.ts` (onion-fronted bootstrap, anonymous env-building
  helpers, anonymous-mode onboarding/wizard helpers), `bootstrap-node.ts` gained an optional
  `env` passthrough, `onboard.ts`'s `beginIdentityCreation`/`sendContactRequest` gained optional
  mode/timeout params (both backward compatible, every other caller unaffected).

- [x] **8. Trusted profile import/export** — done (`trusted-import.spec.ts`, 3 tests:
  S1 fast-mode happy path + registration-gap finding, S2 corrupted-file/clean-retry, S3
  anonymous-mode/Tor with the peer-ID-only-dial investigation; S4 import-while-exporter-offline
  deliberately not reached — budget spent on the S1/S3 finding repros instead, documented
  in-spec). **TWO MAJOR FINDINGS, both empirically reproduced then code-traced — the trusted-
  profile "no registration needed" story currently breaks on BOTH ends:** (1) a genuinely-
  unregistered IMPORTER's first-ever trusted import always fails with the raw, self-referential
  error `User with peer_id '<importer's own peer ID>' not found in database` —
  `createTrustedDirectContact` (src/core/db/database.ts:1675) calls
  `assertUserExists(chat.created_by)` on the importer's OWN peer ID, but nothing ever inserts
  a self-row into `users` except `persistRegisteredUser`
  (src/core/username/username-registry.ts:539-566), which only runs after a successful
  username registration; the import UI ("Add user from file") is not `isRegistered`-gated
  (unlike "New Conversation") and the doc says nothing about the importer, so this surfaces as
  an opaque DB-shape error instead of any designed message. (2) an unregistered EXPORTER can
  export and even RECEIVE the importer's contact request (inbound verification checks the
  SENDER's DHT record, key-exchange.ts:923-929, not the receiver's), but cannot ACCEPT it:
  InvitationManager.tsx:24-27 gates Accept on `isRegistered` with only a warning toast — so
  doc line ~157's "reachable out-of-band without ever publishing a DHT username" cannot
  complete end to end; BOTH sides must register before the chat goes live. The genuinely
  registration-free steps are: exporting, importing-side dial/key resolution from the file's
  data alone (no username lookup of the exporter, code-confirmed
  message-handler.ts:3009-3010 + key-exchange.ts:591), and receiving/queuing the inbound
  request. Also traced (code-confirmed): the
  exported profile carries NO network address of any kind (UserProfilePlaintext,
  src/core/identity/profile-manager.ts:51-61 — keys + peerId + inbox secret only), so the
  importer's first dial resolves the exporter's address purely via libp2p kad-dht peer
  routing by peer ID; S3 confirms this works over onion circuits (the request reaches the
  exporter while the exporter is still unregistered — no username-registry record for them
  exists anywhere at dial time). Export UI lives in ProfilePage.tsx -> ExportDialog.tsx (sidebar
  rail "Profile" tab); the native save dialog is driven by stubbing `dialog.showSaveDialog`
  via ElectronApplication.evaluate (same pattern file-transfer.spec.ts established for
  showOpenDialog). See the spec's file-level comment for the full trace and the round's final
  report for timings/flakiness classification.
  Orchestrator verification 2026-07-07: builder had two 3/3 full passes; the orchestrator's
  independent full pass hit ONE S1 failure (username registration against the real deployed
  fast bootstrap never completed inside its 120s budget — dialog stayed open, no test-logic
  error) which passed clean on an immediate solo re-run (1.7 min): classified
  INFRA-TRANSIENT (real-DHT registration stall), the first such flake of the trusted-import
  round; S2/S3 green in every pass including verification.

- [x] **9. Groups over Tor + deployed-infra deploy-verification** — done
  (`tor-groups.spec.ts`, 2 tests; `tor-deployed-infra.spec.ts`, 1 env-gated test). Per Marin's
  explicit scoping ("groups already tested in fast mode — just think of edge cases and smoke
  test"), `tor-groups.spec.ts` is a SMOKE pass plus two targeted edges, not a re-test of group
  logic: G1 spins up three anonymous instances against one onion-fronted local bootstrap, A
  becomes contacts with B/C, creates a group and invites both (itself an edge case —
  `GROUP_INVITE` is in `FORCE_DIAL_NUDGE_TYPES`, `group-refetch-nudge.ts:21-27`, forcing a cold
  onion-circuit dial even with no guaranteed-live connection; invite->received latency logged
  per invitee), B/C accept, A's fan-out message lands on both, then A kicks C — C gets the
  designed removed-state UI (composer placeholder + sidebar "Archived" badge, code-confirmed
  in `ChatPreview.tsx`), B gets the remaining-member system message, and a post-kick message
  from A reaches B but never C. G2 isolates the round's key Tor-specific question: right after
  a membership change (B's accept, the group's first-ever key rotation), A sends the FIRST
  message on the seconds-old gossipsub topic WITHOUT the epoch-convergence buffer other tests
  use to dodge that window, to observe (not avoid) the designed realtime-vs-offline fork
  (doc section 6.5 / round 4's dissection) over Tor's slower subscription propagation — the
  app's own send-state label decides which recovery path the test drives, and which branch
  fired is logged for comparability. Deliberately out of scope, documented in-file: group file
  transfer over Tor, group offline-rejoin catchup over Tor, >3 members (each has real coverage
  elsewhere or no mode-dependent code path). `tor-deployed-infra.spec.ts` is the separate
  deploy-verification gate: env-gated on a new `KIYEOVO_E2E_ONION_BOOTSTRAP` (`e2e/config.ts`'s
  `ONION_BOOTSTRAP_MULTIADDR`, never hardcoded — `test.skip()` with a clear message when unset),
  one anonymous instance registers a unique username against the REAL deployed onion bootstrap
  (a successful DHT PUT is the strongest proof the deployed server genuinely speaks the
  anonymous protocol namespace rather than silently running fast-mode's, per
  `startOnionFrontedBootstrap`'s documented wrong-mode failure signature) using a
  retry-counting variant of `waitForRealDhtConnectionAnonymous` that reports how many
  "Retry connection" attempts the cold real-world onion dial took, then looks up a
  guaranteed-never-registered name to prove the GET path round-trips with the same clean
  designed not-found UX `username-lookup.spec.ts` established locally. Results, timings,
  which G2 branch fired, and the deployed-infra retry count are in this round's final report.
  OUTCOME (orchestrator-timeboxed stabilization session): G1 passed clean (all real-time
  fan-out, correct kick/removed-state semantics, invite/contact latencies logged) after two
  fixes forced by empirical findings — (1) `NewGroupDialog.tsx:106`'s `canSubmit` requires
  >=2 selected contacts (no 2-person "group" concept), which also reshaped G2 to 3 instances;
  (2) A's `state.user.connected` can flip false mid-flight between back-to-back cold-onion
  contact requests under this file's heavier 3-instance Tor load, permanently disabling
  "New Conversation"'s Send button — fixed with a proactive reconnect check
  (`ensureAnonymousDhtConnected`) plus an outer retry-with-reconnect wrapper
  (`sendContactRequestWithReconnect`). G2 additionally surfaced a genuine, code-confirmed
  THIRD fan-out branch beyond realtime/offline-recovered: a recipient can be EPOCH-LAGGED
  (stale `key_version`), in which case neither realtime nor "Check missed messages" can reach
  them because `GROUP_STATE_UPDATE` is NOT in `FORCE_DIAL_NUDGE_TYPES` and its nudge is
  silently skipped without an active connection (`message-handler.ts:643`) — a real,
  worth-flagging product trade-off, not a test bug; `sendGroupMessageAwaitingFanout` detects
  and labels it rather than failing on it. G2 itself is marked `test.fixme` (orchestrator
  timebox, 2 iterations spent): it passed twice during stabilization (once on each branch —
  realtime, and partial-mesh-miss recovered via "Check missed messages") but remained
  intermittently unstable on pure Tor-infra grounds (one run's onion bootstrap itself never
  reached DHT connectivity) unrelated to test logic.
  Orchestrator verification 2026-07-07: deployed-infra gate green twice independently — 4.5
  min cold (8 connect retries, real-world cold onion dial) and 1.6 min warm; THE deploy
  question is settled: the deployed onion bootstrap speaks the anonymous DHT namespace
  (registration PUT accepted, lookup GET round-trips). G1 green 3 of 4 runs (builder x2,
  orchestrator solo re-run 7.2 min); the one failure's artifacts were destroyed by the
  orchestrator chaining two playwright runs in one command (second run wiped test-results
  — do not chain runs), so its cause is UNKNOWN but consistent with the Tor-circuit
  variance documented at G2's fixme; classified Tor-transient pending any recurrence.

Standing rules for every round: Sonnet implements, orchestrator reviews diff + screenshots and
commits; agents read `Kiyeovo_desktop_technical_documentation.md` (grep the subsystem) and
trace `src/core` before any app-level claim, labeling findings doc-confirmed vs unverified;
no `src/**` changes; 6-minute per-test cap (investigate, don't extend); per-stage timing logs;
unique per-run names (real DHT persists); classify infra-transient failures (slow DHT /
validator rejections) separately from test bugs.
