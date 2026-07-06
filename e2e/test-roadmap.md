# E2e test roadmap (rounds run one by one, orchestrator-reviewed)

Status legend: [ ] queued · [~] in progress · [x] done

- [x] **1. Offline delivery & reconnect** — done (`offline-delivery.spec.ts`): direct messages
  sent while Bob is down arrive after he relaunches on the same profile via the returning-user
  unlock; sender-side `offline` label asserted; pickup measured at ~0.1-0.4s after unlock
  (renderer-driven on-connect fetch). Harness gained `profileDir` reuse + `keepProfile` close.
  Slow specs tagged `@slow`; `test:e2e:quick` added. **Group-offline deliberately deferred to
  round 2's offline-file work or a later addition** (cost/benefit call, documented in-spec).
- [ ] **2. File transfer** — send a file 1:1 and in a group, accept, verify received bytes.
  **Must ALSO cover offline file delivery** (recipient offline during the send, receives the
  file after relaunch) — explicitly requested by Marin; don't scope it to online-only.
- [ ] **3. Blocking + member removal** — blocked peer's messages stop arriving and re-requests
  are refused; a removed group member stops receiving group messages.
- [ ] **4. Calls (last)** — fake media devices (Chromium fake camera/mic flags) for headless
  call tests; strategic value: first coverage of the deployed TURN/STUN server.

Standing rules for every round: Sonnet implements, orchestrator reviews diff + screenshots and
commits; agents read `Kiyeovo_desktop_technical_documentation.md` (grep the subsystem) and
trace `src/core` before any app-level claim, labeling findings doc-confirmed vs unverified;
no `src/**` changes; 6-minute per-test cap (investigate, don't extend); per-stage timing logs;
unique per-run names (real DHT persists); classify infra-transient failures (slow DHT /
validator rejections) separately from test bugs.
