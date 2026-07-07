/**
 * Predefined Kiyeovo nodes — offering + sunset.
 *
 * This file is the SINGLE source of truth for the "connect to Kiyeovo's trusted
 * bootstrap / relay / STUN / TURN servers" offering and its scheduled shutdown
 * ("sunset"). Both the Electron main process and the renderer import from here,
 * and all matching/timing logic below is a set of PURE, unit-tested functions
 * (see predefined-nodes.test.ts).
 *
 * Kiyeovo 1.0.0 intentionally ships with this offer disabled: there are no
 * project-hosted public nodes configured in the binary. When those nodes exist,
 * flip PREDEFINED_NODES_ENABLED, set a real sunset timestamp, document the
 * values in README.md#servers, and populate PREDEFINED_NODES with exactly the
 * values users would save locally.
 */

export type PredefinedNodeKind = 'bootstrap' | 'relay' | 'stun' | 'turn';

export interface PredefinedNode {
  kind: PredefinedNodeKind;
  /**
   * The identifying value users would have SAVED:
   *  - bootstrap/relay: a libp2p multiaddr string
   *  - stun/turn:       the ICE server `url` (e.g. "stun:host:3478",
   *                     "turn:host:3478?transport=udp") — NO credentials here,
   *                     credentials live in separate username/credential fields.
   */
  value: string;
}

export const PREDEFINED_NODES_ENABLED = false;

// Represented as epoch milliseconds so comparison is a trivial number compare.
// Infinity keeps the sunset inactive while the predefined-node offer is disabled.
export const PREDEFINED_NODES_SUNSET_TS: number = Number.POSITIVE_INFINITY;

// IMPORTANT: this same string must ALSO appear in the external-URL allowlist so
// the app is permitted to open it — it is already wired there by importing this
// constant into src/electron/constants.ts (ALLOWED_EXTERNAL_URLS).
export const PREDEFINED_NODES_README_URL =
  'https://github.com/Realman78/Kiyeovo/blob/main/README.md#servers';

// These are used only for post-sunset matching, not as an in-app picker source.
export const PREDEFINED_NODES: readonly PredefinedNode[] = [] as const;

// ---------------------------------------------------------------------------
// Copy (kept as constants so wording is editable in one place).
// ---------------------------------------------------------------------------
// Per-surface offering copy: each setup page advertises only its own kind.
export const PREDEFINED_NODES_OFFERING_LABELS = {
  bootstrap: "Connect to one of Kiyeovo's trusted bootstrap servers",
  relay: "Connect to one of Kiyeovo's trusted relay servers",
  ice: "Connect to one of Kiyeovo's trusted STUN/TURN servers",
} as const;

// Anonymous mode: shown in a confirmation dialog before leaving the app —
// anonymous users may not want to open an external website.
export const PREDEFINED_NODES_EXTERNAL_CONFIRM_TITLE = 'Open external website?';
export const PREDEFINED_NODES_EXTERNAL_CONFIRM_BODY =
  'This opens the Kiyeovo README on github.com in your regular browser, outside the app and outside Tor.';
export const PREDEFINED_NODES_EXTERNAL_CONFIRM_OPEN_LABEL = 'Open in browser';
export const PREDEFINED_NODES_EXTERNAL_CONFIRM_CANCEL_LABEL = 'Cancel';

export const PREDEFINED_NODES_SUNSET_TITLE = 'Kiyeovo predefined servers have shut down';
export const PREDEFINED_NODES_SUNSET_BODY =
  "Kiyeovo's predefined servers have shut down. Add your own or a community bootstrap / relay to stay connected — see the README.";
export const PREDEFINED_NODES_SUNSET_CTA_LABEL = 'Open README';
export const PREDEFINED_NODES_SUNSET_DISMISS_LABEL = 'Dismiss';

// ===========================================================================
// Pure logic (unit-tested)
// ===========================================================================

/**
 * Sunset gate. `now` is injected (epoch ms) so tests stay deterministic and the
 * caller controls the clock (renderer passes Date.now()).
 * Returns false when the sunset timestamp is not a finite number (misconfigured
 * placeholder), so a broken constant never triggers the shutdown notice early.
 */
export function isSunsetActive(now: number): boolean {
  if (!Number.isFinite(PREDEFINED_NODES_SUNSET_TS)) {
    return false;
  }
  return now >= PREDEFINED_NODES_SUNSET_TS;
}

/**
 * Whether the offering link should be shown. The offering is time-gated (before
 * sunset only); fast-vs-anonymous gating is applied by the caller.
 */
export function isOfferingActive(now: number): boolean {
  return PREDEFINED_NODES_ENABLED && !isSunsetActive(now);
}

/**
 * Normalize a node value for robust equality matching.
 *
 *  - bootstrap / relay (multiaddr): trim and drop any trailing slash. Peer IDs
 *    are case-sensitive base58, so case is preserved; only whitespace/trailing
 *    slash noise is stripped.
 *  - stun / turn (ICE url): lowercase, drop the scheme (stun:/turn:/turns:),
 *    drop any userinfo ("user:pass@"), drop the query string ("?transport=…"),
 *    and drop a trailing slash. What remains is host[:port]. This makes matching
 *    ignore the shared TURN credential (which lives in separate fields anyway),
 *    the transport variant, and stun-vs-turn scheme differences on the same host.
 */
export function normalizePredefinedValue(kind: PredefinedNodeKind, value: string): string {
  const trimmed = value.trim();

  if (kind === 'bootstrap' || kind === 'relay') {
    return trimmed.replace(/\/+$/, '');
  }

  // stun / turn
  let v = trimmed.toLowerCase();
  v = v.replace(/^(stuns?|turns?):/, ''); // strip scheme
  v = v.replace(/^[^@/]*@/, '');           // strip userinfo if present
  v = v.replace(/[?#].*$/, '');            // strip query/fragment (e.g. ?transport=udp)
  v = v.replace(/\/+$/, '');               // strip trailing slash
  return v;
}

/**
 * True when a user's SAVED value matches one of the PREDEFINED_NODES of the same
 * kind, after normalization. `savedKind` accepts 'turns' as an alias of 'turn'
 * (TURN-over-TLS is still a TURN server for matching purposes).
 */
export function matchesPredefinedNode(
  savedValue: string,
  savedKind: PredefinedNodeKind | 'turns',
): boolean {
  const kind: PredefinedNodeKind = savedKind === 'turns' ? 'turn' : savedKind;
  const normalizedSaved = normalizePredefinedValue(kind, savedValue);
  if (!normalizedSaved) {
    return false;
  }

  return PREDEFINED_NODES.some(
    (node) =>
      node.kind === kind &&
      normalizePredefinedValue(node.kind, node.value) === normalizedSaved,
  );
}

/**
 * Convenience: given a flat list of the user's saved nodes, is at least one a
 * predefined Kiyeovo node? Used by the sunset notice to decide whether to show.
 */
export function hasSavedPredefinedNode(
  saved: ReadonlyArray<{ kind: PredefinedNodeKind | 'turns'; value: string }>,
): boolean {
  return saved.some((entry) => matchesPredefinedNode(entry.value, entry.kind));
}
