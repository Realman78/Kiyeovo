# Relay reservation verification — 2026-07-05/06

Verification that the deployed circuit relay accepts reservations again after the
operator's server-side fix, and that the e2e suite now asserts this instead of
tolerating failure.

## What was broken

The deployed relay (`/ip4/143.198.137.240/tcp/4002/p2p/12D3KooWKx9xPFweD6isahRpjkNR6BxEtJKpbZvvfskb44E8q83x`)
refused **every** circuit-relay-v2 reservation with a protocol-level
`RESERVATION_REFUSED` (~300 ms after dial). Root cause: the relay ran with
js-libp2p's default `maxReservations=15`, and this repo's own e2e test peers had
exhausted all 15 slots — each run minted fresh short-lived peers whose
reservations outlived them. Consequences:

- Fast-mode users got no relay fallback (e2e messaging worked only because both
  peers could reach each other over direct TCP).
- The e2e onboarding relay step (`e2e/onboard.ts`) was deliberately written as
  best-effort: 2 short attempts, then warn-and-continue.

## What the operator changed (server side, 2026-07-05)

- `maxReservations=512` (was js-libp2p default 15)
- `reservationTtl=900000` ms (15 min, so dead test peers free their slots quickly)
- Service restarted (all stale slots cleared)

No app-source (`src/**`) changes were made or needed.

## Evidence reservations now succeed

Single-instance probe through the real setup wizard (main-process logs, DEBUG_MODE):

```
[23:31:54.133] [CONFIG][FAST] attempting deterministic relay reservations count=1 concurrency=1 source=db
[23:31:54.615] Connected to peer: 12D3KooWKx9xPFweD6isahRpjkNR6BxEtJKpbZvvfskb44E8q83x
[23:31:54.947] [CONFIG][FAST][RELAY] reserved /ip4/143.198.137.240/tcp/4002/p2p/12D3KooWKx9xPFweD6isahRpjkNR6BxEtJKpbZvvfskb44E8q83x via=/ip4/.../p2p-circuit
[23:31:54.947] [CONFIG][FAST][RELAY] reserved=1/1
[23:31:54.947] [CONFIG][FAST][RELAY] localCircuitAddrs=1 values=/ip4/143.198.137.240/tcp/4002/p2p/12D3KooW...q83x/p2p-circuit/p2p/<own peer id>
[23:31:55.030] [IPC] Relay retry complete connected=1/1
```

Dial-to-reserved took **~0.8 s** (previously a refusal in ~300 ms). The node also
publishes a `/p2p-circuit` listen address afterwards (`localCircuitAddrs=1`),
which is the reservation actually taking effect.

Incidental finding from the same probe: the old best-effort UI signal (the
"Connected to N of M relay servers" toast in `RelaySetup.tsx`) failed to be
observed by Playwright even while the IPC logged `connected=1/1` — i.e. the
toast check was unreliable on success, not just on failure. The new assertion
therefore polls the IPC (`kiyeovoAPI.retryRelays()`) instead of the toast.

## What the e2e suite now asserts

`completeRelayStep` in `e2e/onboard.ts` (runs for **each** peer, so the two-peer
spec covers two concurrent reservations per run):

- Adds the relay multiaddr via the real wizard UI as before.
- Then polls `window.kiyeovoAPI.retryRelays()` (the exact IPC behind the
  wizard's "Retry connection" button; idempotent once the reservation exists)
  and **fails the test** unless it reports `connected >= 1` within 30 s.

If the relay ever refuses again (e.g. slot exhaustion recurs), the suite fails
loudly with a message pointing back at this incident instead of shrugging.

Stale "relay is broken / best-effort" prose was removed from `e2e/onboard.ts`,
and REVIEW-NOTES.md's known-issues entry was moved to a "Fixed since review"
note.

## Suite results after the change

3 consecutive full runs of `npm run test:e2e:headless` (smoke + two-peer), all
passing with the new assertion:

| Run | Result       | Total suite | Two-peer test | Relay stage (peer A / peer B) |
|-----|--------------|-------------|---------------|-------------------------------|
| 1   | 2/2 passed   | 16.8 s      | 15.1 s        | 1.0 s / 1.0 s                 |
| 2   | 2/2 passed   | 16.8 s      | 15.2 s        | 1.0 s / 1.0 s                 |
| 3   | 2/2 passed   | 30.8 s      | 29.1 s        | 1.0 s / 1.0 s                 |

The relay onboarding stage previously spent ~4-10 s in doomed retries (3.7-3.8 s
per peer in the last pre-fix runs); it is now a steady 1.0 s per peer, and no
run printed the old "Relay server never confirmed a successful reservation"
warning (the code that emitted it is gone — a failure now fails the test).
Run 3's extra time was entirely a slow DHT username registration for one peer
(17.4 s vs the usual ~3 s) — the known transient validator issue, unrelated to
the relay.
