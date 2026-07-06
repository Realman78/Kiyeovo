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
- [ ] **3. Network edge cases / resilience (Fast mode)** — deliberately adverse conditions,
  all local-infra simulable: multiple bootstraps (5-6) with some dead → onboarding must fail
  over to a live one; ALL bootstraps dead → sane error UX, no hang; bootstrap killed
  mid-session → reconnect + offline fallback engage; wrong unlock password then correct one.
  **Scripted reproduction target from Marin (do not pre-analyze; reproduce first):** with a
  shutdown bootstrap configured, ADDING a new bootstrap afterwards does not connect — suspected
  real bug, network-dependent, occurs in Fast mode. Also test the MANY-HEALTHY case, not just
  dead ones: e.g. 8 local bootstraps ALL healthy (Marin suspects "too many healthy" could
  itself misbehave; he'll separately re-test against his real 7-8 server deployment later).
  Starts on Marin's go-ahead after he reads the round-2 report. NOT coverable on this host: the relay DATA
  path (needs NAT-isolated peers — requires a second machine or privileged netns; parked).
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
