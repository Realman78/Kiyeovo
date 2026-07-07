/**
 * Predefined Kiyeovo nodes — offering + sunset.
 *
 * This file is the SINGLE source of truth for the "connect to Kiyeovo's trusted
 * bootstrap / relay / STUN / TURN servers" offering and its scheduled shutdown
 * ("sunset"). Both the Electron main process and the renderer import from here,
 * and all matching/timing logic below is a set of PURE, unit-tested functions
 * (see predefined-nodes.test.ts).
 *
 * ============================================================================
 * TODO(marin): BEFORE RELEASE, populate every placeholder below. Nothing here
 * is inlined anywhere else — edit only this file (plus one allowlist line, see
 * note on PREDEFINED_NODES_README_URL). The exact list you must fill in:
 *
 *   1. PREDEFINED_NODES_SUNSET_TS   — the real shutdown instant.
 *   2. PREDEFINED_NODES_README_URL  — the real README URL (see allowlist note).
 *   3. PREDEFINED_NODES             — the real multiaddrs / ICE URLs you host,
 *                                     used ONLY to detect (post-sunset) whether
 *                                     a user still has one of them saved.
 *   4. (optional) PREDEFINED_NODES_OFFERING_LABELS / *_SUNSET_* /
 *      *_EXTERNAL_CONFIRM_* copy strings.
 * ============================================================================
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

// ---------------------------------------------------------------------------
// TODO(marin): set the real sunset instant. Placeholder currently 2026-07-25.
// Represented as epoch milliseconds so comparison is a trivial number compare.
// Use Date.parse of an ISO string (parsed once, at module load) to keep it
// human-readable in source.
// ---------------------------------------------------------------------------
export const PREDEFINED_NODES_SUNSET_TS: number = Date.parse('2026-07-25T00:00:00Z');

// ---------------------------------------------------------------------------
// TODO(marin): real README URL (ideally the "#servers" anchor).
// IMPORTANT: this same string must ALSO appear in the external-URL allowlist so
// the app is permitted to open it — it is already wired there by importing this
// constant into src/electron/constants.ts (ALLOWED_EXTERNAL_URLS). Enter the
// CANONICAL form: https, lowercase host, no trailing slash. The fragment
// (#servers) is preserved by the open path.
// ---------------------------------------------------------------------------
export const PREDEFINED_NODES_README_URL =
  'https://github.com/Realman78/Kiyeovo/blob/main/README.md#servers';

// ---------------------------------------------------------------------------
// TODO(marin): replace these clearly-fake placeholders with the REAL servers
// you host. These are used ONLY for post-sunset matching (detecting whether a
// user still has one of your servers saved) — they are NOT shown in a picker.
// Keep the shape; add/remove entries freely.
// ---------------------------------------------------------------------------
export const PREDEFINED_NODES: readonly PredefinedNode[] = [
  // Bootstrap (libp2p multiaddr)
  { kind: 'bootstrap', value: '/dns4/bootstrap.placeholder.kiyeovo/tcp/4001/p2p/12D3KooWPLACEHOLDERbootstrap0000000000000000000000000000' },
  // Relay (libp2p multiaddr)
  { kind: 'relay', value: '/dns4/relay.placeholder.kiyeovo/tcp/4002/p2p/12D3KooWPLACEHOLDERrelay000000000000000000000000000000000' },
  // STUN (ICE url, no credentials)
  { kind: 'stun', value: 'stun:stun.placeholder.kiyeovo:3478' },
  // TURN (ICE url, no credentials — saved entries carry creds in separate fields)
  { kind: 'turn', value: 'turn:turn.placeholder.kiyeovo:3478' },
  // Anonymous-mode bootstrap (onion multiaddr). The deployed onion bootstrap
  // shuts down at the sunset too, so anonymous users must also get the notice.
  { kind: 'bootstrap', value: '/onion3/placeholderplaceholderplaceholderplaceholderplacehold:9000/p2p/12D3KooWPLACEHOLDERonionbootstrap00000000000000000000000' },
] as const;

// ---------------------------------------------------------------------------
// Copy (kept as constants so wording is editable in one place).
// TODO(marin): reword freely.
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
  return !isSunsetActive(now);
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
