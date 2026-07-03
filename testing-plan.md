# Testing Plan

## Goal

Build a risk-based test suite for Kiyeovo. The goal is not to test every file or chase full coverage. The goal is to protect the parts of the app where regressions would affect security, privacy, persistence, recovery, protocol compatibility, or important user-visible behavior.

Each section below is a separate implementation phase.

## Phase 1: Protocol Boundaries

Protocol code should be tested wherever Kiyeovo accepts, emits, validates, signs, encrypts, decrypts, or dispatches structured messages.

Coverage should include typed envelopes, known/unknown message kinds, protocol versions, signature validation, domain separation, malformed payloads, size limits, replay-sensitive fields, and idempotent handling of duplicates or late control messages.

These tests should stay mostly deterministic and close to the protocol modules. They should avoid real networking unless the behavior cannot be verified without it.

Good targets:

- application message envelope parsing and dispatch
- file offer, pull, cancel, and NACK protocol frames
- group DHT validators and selectors
- offline message validators
- username and group record validation

## Phase 2: Persistence And State Transitions

Database behavior should be tested anywhere the app relies on explicit state ownership, compare-and-set transitions, terminal states, or restart reconciliation.

Coverage should focus on legal transitions, illegal transition rejection, first-terminal-wins behavior, idempotency, persistence across restart-like reopen flows, cleanup behavior, and row scoping by network mode, chat, peer, group, or message id.

These tests should use real database instances where practical, because many risks live in SQL constraints, transaction boundaries, and persistence details rather than pure TypeScript logic.

Good targets:

- message send/receive status transitions
- file offer state transitions
- group membership and key-version persistence
- offline queue state
- account deletion cleanup
- startup reconciliation for ephemeral runtime authority

## Phase 3: Security-Sensitive IPC

IPC tests should cover every important boundary where renderer-controlled input reaches Electron main or core code.

Coverage should verify that main/core remains authoritative even when renderer pre-checks exist. Tests should reject unsafe file paths, stale identifiers, wrong network mode, wrong message state, invalid filenames, excessive payloads, symlinks where forbidden, and unsupported operation states.

These tests can usually mock Electron shell/dialog/clipboard APIs and call handler-level functions directly. Full Electron UI automation should be reserved for a smaller later phase.

Good targets:

- trusted IPC channel validation
- file path operations and show-in-folder behavior
- media capability creation and serving
- copy-image validation
- pasted image and generated text upload creation
- account deletion and cleanup IPC

## Phase 4: Recovery And Lifecycle

Lifecycle tests should cover behavior that depends on startup, shutdown, reconnect, cancellation, drain, retry, or background recovery.

Coverage should focus on ownership of runtime-only state versus persisted state. Tests should make clear what survives restart, what is intentionally ephemeral, and what reconciliation runs when the app starts again.

These tests may need focused harnesses around lifecycle components rather than broad end-to-end flows. Prefer deterministic fake timers, fake network status changes, and mocked dial/send dependencies over real network timing.

Good targets:

- reconnect controller behavior
- network return handling
- offline fallback retry behavior
- group missed-message catch-up
- pending file reprocessing after capacity changes
- shutdown drain/cancel behavior
- startup setup-readiness decisions

## Phase 5: Core Privacy And Identity Logic

Identity, recovery, and trust flows should be tested because mistakes here can lock users out, leak sensitive material, or weaken trust assumptions.

Coverage should include recovery phrase validation, encrypted identity load/save behavior, password handling boundaries, key exchange state, trusted contact import, registration state, and group key-version transitions.

Tests should avoid asserting on secret material directly unless necessary. Prefer round-trip and rejection tests that prove the correct authority can recover or sign while the wrong input cannot.

Good targets:

- encrypted user identity creation, import, export, and unlock
- recovery phrase validation and error paths
- key exchange accept/reject/reconcile flows
- trusted user import validation
- group membership/key rotation persistence and validation

## Phase 6: Complex UI State

Renderer tests should be selective. Test UI state when it contains real product logic, not when it only renders static layout.

Coverage should focus on Redux slices, hooks, state machines, and components that coordinate user-visible transitions across async events. Avoid snapshot tests for presentational components and avoid testing CSS-only behavior.

These tests should generally run outside Electron where possible, with mocked `window.kiyeovo` APIs and deterministic timers.

Good targets:

- setup readiness and setup navigation state
- pending file inbox indicator behavior
- reconnect/connectivity guidance
- notification grouping
- chat message status rendering decisions
- reply/jump state ownership
- call and group-call UI state services

## Phase 7: Small Electron Smoke Tests

End-to-end Electron tests should be small, high-value, and intentionally limited. They should verify that the app can run through core user workflows across process boundaries, not duplicate all unit coverage.

Coverage should focus on a few representative flows that prove renderer, preload, IPC, main process, database, and core services are wired together correctly.

These tests are expected to be slower and more environment-sensitive, so they should be fewer than the unit tests and should avoid depending on real public network availability.

Good targets:

- launch app and create or import an identity
- open an existing database and render the main shell
- create a chat or load a seeded chat
- send a local/test-harness message through the IPC boundary
- accept/reject a seeded pending file offer
- restart and verify persisted state is still visible

## Phase 8: Think About Simulating Networking

After the lower-level protocol, persistence, IPC, lifecycle, identity, UI-state, and smoke-test layers are in better shape, revisit whether Kiyeovo needs a small networking simulation harness.

This phase should not be the default way to test protocol rules. Protocol-boundary tests should continue to feed raw keys, values, frames, envelopes, and signed payloads directly into validators and handlers wherever possible.

The purpose of a networking simulation phase would be to test interactions that cannot be proven at a single boundary, such as multi-peer message flow, DHT publish/fetch behavior, reconnect timing, stream interruption, relay assumptions, or offline catch-up ordering.

Before implementing this phase, decide whether to use lightweight mocked network objects, in-memory async streams, or real local libp2p nodes. Prefer the smallest harness that proves the behavior without depending on public network availability, external bootstrap nodes, timing-sensitive sleeps, or host-specific ports.

Good questions to answer first:

- which bugs would only be caught by a networking harness?
- can those bugs be covered with deterministic unit tests instead?
- should the harness use real libp2p nodes or only mocked DHT/dial/stream boundaries?
- how will tests avoid flakes from timing, ports, bootstrap, Tor, and relay behavior?
- should networking simulation run in the normal unit suite or as a separate slower command?

## Ongoing Rule

Every non-trivial change that touches protocol behavior, persistence, lifecycle ownership, recovery, security-sensitive boundaries, or important user-visible state should include a focused test.

Bug fixes should usually include a regression test that fails without the fix.

Do not add tests for static presentation, simple wrappers around third-party libraries, or broad flaky networking behavior unless there is a specific regression risk to protect.
