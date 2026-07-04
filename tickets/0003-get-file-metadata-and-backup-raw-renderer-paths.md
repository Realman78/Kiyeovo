# GET_FILE_METADATA (and backup/restore) still stat raw renderer-supplied paths

- **Area:** Electron / IPC security
- **Severity:** Medium
- **Source:** Test phase 3 review (`testing-findings.md`)
- **Status:** Open

## Summary

Phase 3 hardened `OPEN_FILE_LOCATION` so it only acts on DB-backed completed files or
app-owned uploads (see `resolveOpenFileLocationPath` in
`src/electron/ipc-handler-helpers.ts`). That same hardening was **not** extended to
other IPC handlers that consume renderer-supplied filesystem paths:

- `GET_FILE_METADATA` calls `stat(filePath)` directly on the renderer-provided path.
- Backup and restore flows rely on renderer-provided path values after native dialogs;
  the IPC boundary itself does not bind the path to a prior dialog result.

In the normal UI flow these values come from an OS file picker, but the IPC boundary
does not enforce that — a compromised or buggy renderer can pass an arbitrary path and
learn filesystem metadata (existence, size) for files outside any app-owned location.

## Location

- `src/electron/ipc-handlers.ts:1426-1444` (`GET_FILE_METADATA` → `stat(filePath)`).
- Backup/restore IPC handlers (native-dialog-then-path flows) in the same file.

## Expected behavior

Decide on the trust model for these paths and enforce it at the main-process boundary,
consistent with the `OPEN_FILE_LOCATION` change. Options:

1. For `GET_FILE_METADATA`, bind the path to a dialog result captured in main
   (renderer receives an opaque token, not a raw path), or otherwise constrain accepted
   paths to an explicit capability set. Reject symlinks / non-regular files where the
   metadata is only meant for regular upload/restore candidates.
2. For backup/restore, prefer a main-owned dialog/capability flow. Backup targets and
   restore sources legitimately live outside app-owned directories, so a blanket
   "app-owned / DB-backed only" rule would likely break normal backup behavior. The
   important boundary is that the renderer should not be able to invent a raw path after
   the dialog; main should remember the chosen path or token and consume that capability.

`GET_FILE_METADATA` is the lower-risk of the two (read-only metadata) but is the clearest
remaining instance of the pattern; backup/restore deserve an explicit decision since they
read/write whole files.

### Boundary with 0013 (keep separate)

This ticket owns **renderer-supplied path capability binding** for backup/restore and
`GET_FILE_METADATA` — the renderer must not be able to invent a raw path after a dialog.
[[0013-backup-restore-no-encryption-no-integrity]] owns **backup-artifact confidentiality
and validate-before-replace restore**. They compose (the final flow will likely be a
main-owned dialog/capability plus a backup-artifact verifier) but are distinct concerns;
neither subsumes the other, so they stay in separate tickets.

## Test coverage

Not currently covered. Once a policy is chosen, add helper-level tests mirroring
`ipc-handler-helpers.test.ts`:

- `GET_FILE_METADATA` accepts only dialog-bound/capability-bound regular files and
  rejects arbitrary paths, symlinks, and non-regular files.
- Backup/restore consumes only main-issued dialog/capability tokens and rejects raw
  renderer-invented paths.
