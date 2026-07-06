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
- [ ] **6. Tor / anonymous mode (LAST — per Marin)** — Marin has pending work here, also
  related to bootstraps; do not start without his go-ahead. Whole second network stack,
  needs Tor binaries (scripts/download-tor.sh).

Standing rules for every round: Sonnet implements, orchestrator reviews diff + screenshots and
commits; agents read `Kiyeovo_desktop_technical_documentation.md` (grep the subsystem) and
trace `src/core` before any app-level claim, labeling findings doc-confirmed vs unverified;
no `src/**` changes; 6-minute per-test cap (investigate, don't extend); per-stage timing logs;
unique per-run names (real DHT persists); classify infra-transient failures (slow DHT /
validator rejections) separately from test bugs.
