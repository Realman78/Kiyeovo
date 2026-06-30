# Testing Findings

This file captures suspicious or unresolved behavior noticed while adding the risk-based test phases. Items here are intentionally not fixed unless a later phase explicitly takes them on.

## Phase 3: Security-Sensitive IPC

- `GET_FILE_METADATA` still accepts a renderer-supplied filesystem path and stats it in main. The normal UI path gets that value from an OS file picker, but the IPC boundary itself does not bind the path to a prior dialog result.
- Backup and restore IPC paths also rely on renderer-provided values after native dialogs. That may be acceptable for a desktop app, but it is worth deciding whether these should become explicit main-process capabilities instead of raw paths.

## Phase 4: Recovery And Lifecycle

- The new coverage is deliberately at the reconnect-controller level. It does not prove the full Electron power-resume path from `powerMonitor` through core reconnect, renderer banner state, and recent-chat offline sync settlement.
- `NOTIFY_NETWORK_RECONNECTED` is fire-and-forget: the renderer asks core to reconnect and the health timer remains the backstop, but the IPC call itself does not report whether reconnect actually started or settled.

## Phase 5: Core Privacy And Identity Logic

- Key exchange remains mostly untested at the protocol-state level because the current implementation is tightly coupled to libp2p streams, DHT lookup, database writes, and UI callbacks. A later phase should extract or harness the pure authority decisions around accept/reject/resume/reset.
- Trusted profile import does not reject a profile whose `peerId` is the local user's own peer id. That may allow a self-contact/self-chat if the UI or caller supplies the user's own exported profile.
- Trusted profile import validates custom-name length but does not trim or normalize it in main/core. The UI passes the raw field value, so leading/trailing spaces can become part of the stored contact name.
