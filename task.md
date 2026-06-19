# Setup Readiness Foundation

## Goal

Add the first four stages of the setup-readiness work without building the Setup page itself:

1. Define a mode-aware readiness model.
2. Determine bootstrap, relay, and ICE states.
3. Persist acknowledgement of the missing ICE warning.
4. Show the highest-severity warning dot on the Setup rail tab.

The purpose is to give users a persistent, accurate signal that required or recommended infrastructure is missing while keeping the status logic reusable for the future guided Setup page.

## Implemented Behavior

### Anonymous mode

- Bootstrap is the only relevant setup component.
- No configured bootstrap produces `blocked` readiness and a red Setup dot.
- Relay and ICE are marked not applicable.

### Fast mode

- No configured bootstrap produces `blocked` readiness and a red Setup dot.
- No configured relay produces `warning` readiness and an amber Setup dot.
- Missing ICE configuration produces `warning` readiness and an amber Setup dot.
- Configured ICE clears its warning.
- A persisted acknowledgement can suppress only the missing-ICE warning.
- Acknowledgement does not change ICE from unconfigured to configured.

The readiness result always uses the highest severity: `blocked`, then `warning`, then `ready`. Before the mount-time snapshot completes, readiness is `null` and the rail shows no dot.

## Status Sources

- Network mode: `getNetworkMode()`
- Configured bootstrap nodes: `getBootstrapNodes().nodes.length > 0`
- Configured relay nodes: `getRelayStatus().nodes.length > 0`
- ICE configuration: `getIceServers()`
- Missing-ICE acknowledgement: new settings IPC backed by the existing settings table

This indicator represents setup completeness only. It deliberately does not test or represent bootstrap, relay, STUN, or TURN server reachability.

Unreadable configuration is represented explicitly as `unknown` instead of being treated as configured. An unknown bootstrap state produces the red indicator; unknown relay or ICE state produces amber when bootstrap is known to be configured. If the initial mode read rejects, the hook falls back to a red indicator.

## Load Policy

`useSetupReadiness` reads configuration once when the sidebar mounts. It has no timer, liveness probe, DHT subscription, focus listener, or public refresh function. When the Setup page later gains configuration controls, successful changes will trigger a new read directly.

## Persistence

The acknowledgement is stored under:

`setup_missing_ice_warning_acknowledged_fast`

New renderer API methods:

- `getMissingIceWarningAcknowledged()`
- `setMissingIceWarningAcknowledged(acknowledged)`

The setter is intentionally available now for the future Setup page. No acknowledgement button was added in this task because the Setup page is still a placeholder.

## UI

The Setup rail item receives:

- red dot for `blocked`
- amber dot for `warning`
- no dot for `ready`

The dot remains visible in collapsed and hover-expanded rail states. Its accessible label also describes whether setup is blocked or needs attention.

## Main Files

- `src/ui/hooks/useSetupReadiness.ts`
- `src/ui/components/sidebar/Sidebar.tsx`
- `src/ui/components/sidebar/SidebarRail.tsx`
- `src/ui/components/sidebar/navigation.ts`
- `src/ui/components/sidebar/setup/SetupSidebar.tsx`
- `src/ui/pages/Main.tsx`
- `src/shared/ipc/channels.ts`
- `src/shared/kiyeovo-api.ts`
- `src/electron/preload.cts`
- `src/electron/ipc-handlers.ts`
- `src/core/constants.ts`
- `Kiyeovo_desktop_technical_documentation.md`

## Deliberately Not Included

- Setup page content or controls
- The `I do not plan to use calls` button
- Chat-page warning banners
- Contextual redirection from failed messaging or call actions
- STUN/TURN reachability testing
- Suppression options for bootstrap or relay warnings

## Navigation Foundation

The next layout foundation was added after the readiness work:

- `Main` owns the active rail section.
- `Main` owns the active Setup subsection: bootstrap, relay, or ICE.
- `Sidebar` receives controlled navigation props instead of owning rail selection.
- The Setup context sidebar shows Bootstrap, Relay, and STUN/TURN entries in Fast mode.
- Anonymous mode shows only Bootstrap.
- Selecting Setup replaces the chat content area with an empty subsection-specific placeholder.
- Help and Settings replace the main content with empty placeholders.
- The rail remains nested inside `Sidebar`; it was not physically extracted into a third top-level layout component.

The empty main panes are intentional. Bootstrap, relay, and ICE configuration functionality will be migrated separately.

`ChatWrapper` remains mounted when Setup, Help, or Settings is selected. Non-chat sections cover it with an opaque absolute layer while the retained chat layer becomes invisible, non-interactive, and hidden from accessibility APIs. This preserves component-local drafts, message scroll position, and other ephemeral chat state.

## Bootstrap Setup Migration

The first Setup content migration copies the Bootstrap functionality into a dedicated main-area page:

- configured nodes are loaded and their liveness is refreshed while the page is mounted
- users can add, remove, reorder, and copy bootstrap addresses
- users can explicitly retry the bootstrap connection
- successful add/remove actions use the Setup readiness provider's refresh action to update the rail indicator

The provider exposes separate state and action contexts. `SidebarRail` consumes readiness state, while Bootstrap Setup consumes only the stable refresh action. This avoids revision counters and prop drilling through `Main` and `Sidebar`, and readiness updates do not make `Main` a context consumer.

`ConnectionStatusDialog` remains unchanged and fully functional during this staged migration. The STUN/TURN Setup pane remains empty until its migration step. The status button still opens the existing dialog; it will be rerouted only after all three sections have been copied.

## Relay Setup Migration

The second Setup content migration copies Fast-mode Relay functionality into a dedicated main-area page:

- configured relay nodes are loaded and their liveness is refreshed while the page is mounted
- users can add, remove, reorder, and copy relay addresses
- users can explicitly retry relay reservations and see the connected/attempted result
- retries with zero successful reservations are shown as failures instead of success notifications
- successful add/remove actions refresh the rail's setup-completeness indicator through the provider
- polling pauses during retries and reordering so stale snapshots cannot repaint optimistic ordering

The Relay page remains hidden in anonymous mode through the existing mode-aware Setup sidebar. `ConnectionStatusDialog` remains unchanged, and the status button still opens it. STUN/TURN remains the only empty Setup pane.

The Bootstrap page now uses the same polling guard while reordering, shows action failures both inline and as toasts, and displays connected nodes as `connected/total` for consistency with Relay.

## Setup Navigation Polish

- Bootstrap, Relay, and the empty STUN/TURN pane share the selected Setup navigation background so the context pane and content read as one workspace.
- Setup navigation uses `RadioTower` for Bootstrap, `Route` for Relay, and `PhoneCall` for STUN/TURN.
- Collapsing the context pane keeps Setup navigation visible as icon-only actions with titles and accessible labels instead of falling back to the chat header/footer.
- The Setup navigation is always laid out at its final `w-96` width. Its parent clips that fixed layout while animating between collapsed and expanded widths, and labels use opacity/transform transitions instead of being reflowed on every width-animation frame.

## Verification

- `npm run build` completed successfully.
- TypeScript, preload API typing, Electron IPC handlers, and the renderer production bundle all compiled.
- Scoped ESLint was run. The new sidebar/navigation files pass; broader touched-file commands remain non-zero because `src/ui/pages/Main.tsx` and `src/electron/ipc-handlers.ts` already contain unrelated lint errors outside this task.
- Live visual and network-state testing was not performed as part of this task.
