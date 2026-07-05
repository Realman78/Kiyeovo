# Call/WebRTC anonymity rests on a single mode-gate with no WebRTC-layer defense-in-depth

- **Area:** Electron / UI (WebRTC calls) + Core signaling — anonymity/deanonymization
- **Severity:** Medium (latent; catastrophic impact if triggered — full real-IP disclosure through/around Tor)
- **Source:** Security scan — call signaling / WebRTC (malicious-peer + anonymity threat model)
- **Status:** Open

## Threat model

The product markets a Tor-routed "anonymous" mode. For an anonymity tool, disclosing
the user's real IP address is the highest-impact failure class — worse than a content
leak, because it deanonymizes the person. WebRTC is the classic vector: ICE gathers
host (real LAN/public IP) and STUN-reflected (srflx) candidates from the OS interfaces
and sends media peer-to-peer directly, which cannot be routed through a SOCKS proxy /
Tor.

## Current state (what's correct today)

Calls are **hard-gated to Fast mode** at the signaling layer, on both the send and the
receive paths, so today there is **no active leak**:

- `ensureFastModeForCalls()` (`message-handler.ts:1049-1054`) throws unless
  `getSessionNetworkMode() === 'fast'`.
- Receive path: `verifyIncomingCallSignal` calls it **first** (`:1373`), so in anonymous
  mode inbound call offers are rejected before the state machine or UI — the callee's
  `RTCPeerConnection` (created only in `acceptIncomingCall`) is never constructed.
- Send path: `startCall` (`:1586`) and `buildSignedCallSignal` (`:1172`) call it too.
- Group calls gate identically (`group-call-signaling.ts:471`,
  `group-call-orchestrator.ts:2972/3052`).

Call signaling is also well-authenticated (per-signal Ed25519, contact-bound, no
auto-answer, IP not gathered until manual accept), so a stranger cannot probe presence
or IP. That part is solid.

## The finding — no defense-in-depth at the WebRTC layer

The entire anonymity guarantee for calls depends on **one application-layer boolean
check** (`mode === 'fast'`). There is no layered protection at the Chromium/WebRTC
level:

- `RTCPeerConnection` is created with `iceTransportPolicy: 'all'`
  (`src/ui/lib/call/callService.ts:417`, `src/ui/lib/call/groupCallService.ts:509`) —
  full host + srflx candidate gathering, not relay-only.
- **No `webRTCIPHandlingPolicy` anywhere.** A repo-wide grep for
  `webRTCIPHandlingPolicy` / `setWebRTCIPHandlingPolicy` / `disable_non_proxied_udp` /
  `force-webrtc-ip-handling-policy` / `disable-webrtc` / `appendSwitch` returns zero
  hits. `main.ts` `webPreferences` (`:254-261`) sets none.

So if **any** code path ever constructs an `RTCPeerConnection` while in anonymous mode,
the renderer immediately gathers real-IP candidates and sends them to the peer,
bypassing Tor entirely. Regression vectors that would do this include: a new
call-adjacent feature that misses the gate; a group-call edge path; or a bug in
`getSessionNetworkMode()` or the gate. For a headline guarantee this important, a single
point of failure is not enough.

**Not a confirmed live path today:** switching network mode is a *pending-restart* flow
— `handleSwitchNetworkMode` saves the mode and the running mode only changes on app
restart (`SettingsPage.tsx:263,291,534`; "mode saved; restart required"), and a restart
tears down all calls. So a user cannot flip fast → anonymous mid-call in the running
process. The active-call-teardown recommendation below is therefore **lifecycle
hardening** for any *future* runtime mode-change path or a failed-restart edge that
leaves the process running in a stale mode with media alive — not a currently reachable
exploit.

## Location

- `src/ui/lib/call/callService.ts:414-418` (`createPeerConnection`, `iceTransportPolicy: 'all'`).
- `src/ui/lib/call/groupCallService.ts:501-509` (same).
- `src/electron/main.ts:254-261` (`webPreferences` — no WebRTC IP policy).
- `src/core/lib/message-handler.ts:1049-1054` (the sole gate), `:1373` (receive-path use).

## Expected behavior

Even if a call somehow starts in anonymous mode, the WebRTC stack should **fail closed**
(no connection) rather than **fail open** (leak the real IP). Anonymity should not rest
on a single signaling-layer check.

## Suggested fix (defense-in-depth)

1. Set a restrictive WebRTC IP-handling policy on the Electron session, at least while
   in anonymous mode:
   `mainWindow.webContents.session.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`
   (or `'disable_non_proxied_udp'` unconditionally, re-evaluated on mode change). Since
   there is no TURN-over-Tor path, this makes WebRTC unable to connect in anonymous mode
   — i.e. fail-closed — instead of leaking host candidates.
2. Lifecycle hardening (not a current exploit — see above): if a runtime mode-change
   path is ever added, or on a failed restart that leaves the process in a stale mode,
   tear down any active `RTCPeerConnection`s and refuse to create new ones in anonymous
   mode, so no direct media path can outlive a mode change.
3. Keep the existing signaling-layer gate as the primary control; the above are the
   backstops that turn "leak" into "no-op" on any regression.

## Related (lower priority, note — not separate tickets)

- **Fast-mode calls always expose the real IP to the (authenticated) contact** via
  host/srflx candidates, and the only user-facing ICE messaging frames it as a
  connectivity feature ("add STUN/TURN to enable calls",
  `src/ui/components/sidebar/setup/IceSetup.tsx`), never disclosing the IP exposure, and
  there is no `iceTransportPolicy: 'relay'` option for users who want to hide their IP
  from a contact even in Fast mode. Fast mode is the non-anonymous mode, so this is a
  transparency/consent note rather than a vuln — worth a one-line UX disclosure and,
  optionally, a relay-only toggle.
- **Inbound ICE candidates are unfiltered** (`callService.ts:630-647` →
  `pc.addIceCandidate` with no target sanitization). Low, since the peer is an
  authenticated contact and calls are Fast-mode only; consider dropping unexpected
  mDNS/link-local/redirect targets as hardening.

## Test coverage

Not currently covered. Add:
- With mode = anonymous, no code path constructs an `RTCPeerConnection` (assert the
  signaling gate on send and receive, direct and group).
- The Electron session has a restrictive `webRTCIPHandlingPolicy` set (at least in
  anonymous mode).
- Switching to anonymous mode during an active call tears down the peer connection.
