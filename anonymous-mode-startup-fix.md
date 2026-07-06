# Anonymous mode: startup stall + failed bootstrap retry

## Symptoms (found in manual testing)

With a dead/wrong bootstrap node configured in anonymous mode:

1. Startup hung on "Creating libp2p node" for ~70 seconds.
2. After adding a correct bootstrap node (dead one still listed), the manual retry in Bootstrap Setup failed. It only worked after removing the dead node **and** restarting the app.

## Root causes

**Stall:** the Tor preflight (`validateTorConnectivity`) probed every configured bootstrap node through `createSocksConnection`, which retries 3× with a 30 s timeout each — up to ~90 s per dead target, serially, before the node was even created. The probe was redundant: the real bootstrap phase runs seconds later and reports reachability authoritatively.

**Failed retry:** the retry itself re-reads the DB correctly and did dial the new node. But the anonymous dial policy allowed only 12 s per address (15 s per batch), while a **cold** onion dial (descriptor fetch + circuit + rendezvous) routinely needs 10–20 s. Startup masked this: the preflight probe accidentally pre-warmed the Tor circuit with its ~90 s budget, letting the subsequent real dial fit in 12 s. A manual retry got no such warm-up, so the cold dial hit the timeout. The restart "fixed" it only because preflight re-warmed the (now only) good node.

Secondary UX bug: clicking retry while an auto-reconnect (or a still-running previous retry) was in flight returned `status: 'aborted'` with no attempt made — indistinguishable from a real failure in the UI.

## Changes

1. **Validation is local-only** (`src/core/transport/tor-transport.ts`): `validateTorConnectivity` now only checks that the local SOCKS port accepts connections (~instant). Removed the bootstrap probes and the `check.torproject.org` fallback — validation no longer generates any Tor network traffic, and (deliberately) no clearnet egress through an exit circuit on launch. Dead helper code removed (`probeBootstrapTargets`, `probeFallbackTarget`, `normalizeBootstrapTargets`, `extractTorBootstrapTargets`, `TorBootstrapTarget`). Fast mode untouched (preflight early-returns).
2. **Anonymous dial budget raised to 20 s** (`src/core/network/node-bootstrap.ts`): `ANONYMOUS_BOOTSTRAP_ADDRESS_TIMEOUT_MS` 12 s → 20 s, `ANONYMOUS_BOOTSTRAP_BATCH_TIMEOUT_MS` 15 s → 20 s, so a cold onion dial survives without the accidental preflight pre-warm. Batch dials run in parallel, so a dead node no longer delays a live one. Fast-mode constants unchanged. Worst-case manual-retry window is now 3 batches × 20 s + 5 s buffer = 65 s.
3. **Ignored retries are visible** (`src/core/index.ts`, `src/core/types.ts`, `src/ui/components/sidebar/setup/BootstrapSetup.tsx`): the concurrent-retry guard returns a new `retry_in_progress` status instead of `aborted`; the UI shows an info toast ("A reconnection attempt is already running") instead of an error.

## Verification

- `tsc` clean for the electron/core and UI projects; all 231 unit tests pass.
- Expected manual result: with a dead + live bootstrap configured, startup reaches "Peer started" almost immediately and connects to the live node within the first 20 s batch — no restart, no node removal needed.
