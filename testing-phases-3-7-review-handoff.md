# Testing Phases 3-7 Reviewer Handoff

This file summarizes the test implementation work completed for phases 3 through 7 of `testing-plan.md`.

## Scope

The goal was to add focused, risk-based tests for behavior that looked stable, while documenting suspicious or ambiguous logic instead of fixing it. Unresolved issues and review notes were recorded in `testing-findings.md`.

Phases 3 through 7 were completed and committed separately. No `git push` was run.

## Commits

- `befbd07` - `Phase 3: Security-Sensitive IPC`
- `42b2d10` - `Phase 4: Recovery And Lifecycle`
- `7d8cce7` - `Phase 5: Core Privacy And Identity Logic`
- `3a3c172` - `Phase 6: Complex UI State`
- `076cd69` - `Phase 7: Small Electron Smoke Tests`

## Verification

Final full unit test command:

```bash
env LD_LIBRARY_PATH=/tmp/kiyeovo-electron-libs/root/usr/lib/x86_64-linux-gnu npm run test:unit
```

Final result:

- 163 tests passing
- 0 tests failing
- Worktree was clean after the phase commits

## Phase 3: Security-Sensitive IPC

Added tests and helper extraction around Electron IPC paths that handle privileged filesystem actions and upload metadata.

Main changes:

- Added `src/electron/ipc-handler-helpers.ts`.
- Added IPC/security tests:
  - `src/electron/ipc-handler-helpers.test.ts`
  - `src/electron/text-upload.test.ts`
  - `src/electron/trusted-ipc.test.ts`
- Updated `src/electron/ipc-handlers.ts` to route sensitive path validation through explicit helpers.
- Added DB helpers needed to validate completed file paths.
- Updated technical documentation for the show-in-folder trust model.

Important behavior covered:

- `OPEN_FILE_LOCATION` no longer trusts arbitrary renderer-provided paths.
- Completed file paths must resolve to DB-backed media rows or app-owned upload paths.
- Symlinks, directories, and non-regular files are rejected.
- Upload image filenames are validated before use.

Review notes left in `testing-findings.md`:

- `GET_FILE_METADATA` still stats renderer-supplied paths.
- Backup and restore flows still rely on renderer-provided paths after native dialogs.

## Phase 4: Recovery And Lifecycle

Added controller-level tests for reconnect and recovery behavior.

Main changes:

- Added `src/core/network/reconnect-controller.test.ts`.
- Registered the tests in `src/core/test-suite.ts`.
- Updated `testing-findings.md`.

Important behavior covered:

- Reconnect threshold and cooldown behavior.
- Immediate reconnect failure floor and cooldown handling.
- Bootstrap retry suppression and post-retry timer behavior.
- Catch-up flag consumption.
- Handler isolation when one reconnect listener fails.

Review notes left in `testing-findings.md`:

- Coverage is controller-level only; there is still no end-to-end power-monitor to reconnect to renderer-banner test.
- `NOTIFY_NETWORK_RECONNECTED` is fire-and-forget and does not report start/settle status to the renderer.

## Phase 5: Core Privacy And Identity Logic

Added tests for recovery phrase handling, encrypted identity behavior, profile export/import, and trusted profile import persistence.

Main changes:

- Added `src/core/identity/encrypted-user-identity.test.ts`.
- Added `src/core/identity/profile-manager.test.ts`.
- Registered the tests in `src/core/test-suite.ts`.
- Updated `testing-findings.md`.

Important behavior covered:

- Recovery phrase validation and mode-scoped derived recovery passwords.
- Identity signatures verify only for the exact signed payload and signing key.
- Password strength boundary behavior.
- Trusted profile export/import round trip for public contact data.
- Wrong-password rejection on trusted profile import.
- Trusted profile import creates an out-of-band direct chat, stores the peer user, and rejects duplicates.

Review notes left in `testing-findings.md`:

- Key exchange is still mostly untested at the protocol-state level because the current implementation is tightly coupled to libp2p, DHT, DB, and UI callbacks.
- Trusted profile import does not reject importing a profile whose `peerId` equals the local user.
- Trusted profile import validates custom-name length but does not trim or normalize it in main/core.

## Phase 6: Complex UI State

Added reducer/state tests for chat behavior and setup-node liveness behavior.

Main changes:

- Added `src/ui/state/slices/chatSlice.test.ts`.
- Added `src/ui/state/slices/setupNodesSlice.test.ts`.
- Registered the tests in `src/core/test-suite.ts`.
- Updated `testing-findings.md`.

Important behavior covered:

- `addMessage` unread count and inbound activity behavior for inactive inbound messages.
- Duplicate and self-message handling.
- `removeMessagesByIds` clears reply targets.
- Settled Redux previews are preserved over older DB previews.
- Unsent queued rows are ignored when recalculating previews.
- File transfer progress after terminal states is ignored.
- Completed file transfers finalize path and progress.
- `resolveMessageSendOutcome` clears retry state and avoids regressing newer previews.
- Setup-node liveness survives config refresh.
- Stale setup-node generations are ignored.
- Setup-node generation tracking is scoped by section.

Review notes left in `testing-findings.md`:

- `chatSlice.addMessage` can update preview metadata from duplicate or older payloads.
- `removeMessagesByIds` sets `lastMessage` to `SYSTEM: No messages yet` but leaves the previous `lastMessageTimestamp`.
- `removeChat` does not clear `replyTargetByChatId`.

## Phase 7: Small Electron Smoke Tests

Added small unit-level smoke tests for Electron-adjacent behavior that can run inside the existing unit test process.

Main changes:

- Added `src/electron/app-entry-url.ts`.
- Added `src/electron/external-url-policy.ts`.
- Added `src/electron/electron-security-smoke.test.ts`.
- Updated `src/electron/app-protocol.ts` to use the extracted packaged app URL helper.
- Updated `src/electron/window-security.ts` to use the extracted external URL policy helper.
- Registered the tests in `src/core/test-suite.ts`.
- Updated `testing-findings.md`.

Important behavior covered:

- Packaged app entry URL helper behavior.
- App URL trust policy.
- External URL normalization and HTTPS allowlist behavior.
- Static preload source smoke checks:
  - exposes frozen `kiyeovoAPI`
  - does not expose raw `ipcRenderer`
  - does not expose `window.electron`
- Network connectivity smoke behavior:
  - ignores virtual/link-local-only interfaces
  - accepts real non-internal interfaces through an `os.networkInterfaces` mock

Review notes left in `testing-findings.md`:

- These are unit-level smoke tests only; they do not launch a real `BrowserWindow`.
- Runtime preload bridge behavior is not yet smoke-tested.
- Custom protocol handlers are not registered in a shared unit process; isolated Electron smoke coverage is still needed for `kiyeovo://app/index.html` and `kiyeovo-media://media/<token>`.

## Reviewer Focus

The most useful follow-up review areas are:

- Confirm whether the Phase 3 IPC hardening matches intended product behavior.
- Review `testing-findings.md` and decide which findings should become implementation tickets.
- Decide whether Phase 7 should be expanded into a real launched-Electron smoke suite.
- Plan Phase 8 networking simulation separately; current work did not simulate real peer-to-peer networking.

## Coverage Caveat

The 163 passing tests are not intended to mean the app is comprehensively tested. This is a first risk-based layer around high-value security, persistence, recovery, identity, UI-state, and Electron-adjacent behavior. Remaining gaps include real Electron runtime launch coverage, preload runtime behavior, full renderer workflows, key-exchange protocol state, and simulated networking.
