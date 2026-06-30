# Testing Findings

This file captures suspicious or unresolved behavior noticed while adding the risk-based test phases. Items here are intentionally not fixed unless a later phase explicitly takes them on.

## Phase 3: Security-Sensitive IPC

- `GET_FILE_METADATA` still accepts a renderer-supplied filesystem path and stats it in main. The normal UI path gets that value from an OS file picker, but the IPC boundary itself does not bind the path to a prior dialog result.
- Backup and restore IPC paths also rely on renderer-provided values after native dialogs. That may be acceptable for a desktop app, but it is worth deciding whether these should become explicit main-process capabilities instead of raw paths.

## Phase 4: Recovery And Lifecycle

- The new coverage is deliberately at the reconnect-controller level. It does not prove the full Electron power-resume path from `powerMonitor` through core reconnect, renderer banner state, and recent-chat offline sync settlement.
- `NOTIFY_NETWORK_RECONNECTED` is fire-and-forget: the renderer asks core to reconnect and the health timer remains the backstop, but the IPC call itself does not report whether reconnect actually started or settled.
