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
- [ ] **4. Blocking + member removal** — blocked peer's messages stop arriving and re-requests
  are refused; a removed group member stops receiving group messages.
- [ ] **5. Calls** — fake media devices (Chromium fake camera/mic flags) for headless call
  tests; strategic value: first coverage of the deployed TURN/STUN server.
- [ ] **6. Tor / anonymous mode (LAST — per Marin)** — Marin has pending work here, also
  related to bootstraps; do not start without his go-ahead. Whole second network stack,
  needs Tor binaries (scripts/download-tor.sh).

Standing rules for every round: Sonnet implements, orchestrator reviews diff + screenshots and
commits; agents read `Kiyeovo_desktop_technical_documentation.md` (grep the subsystem) and
trace `src/core` before any app-level claim, labeling findings doc-confirmed vs unverified;
no `src/**` changes; 6-minute per-test cap (investigate, don't extend); per-stage timing logs;
unique per-run names (real DHT persists); classify infra-transient failures (slow DHT /
validator rejections) separately from test bugs.
