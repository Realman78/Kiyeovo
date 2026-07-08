/**
 * Predefined Kiyeovo nodes — offering + sunset.
 *
 * This file is the SINGLE source of truth for the "connect to Kiyeovo's trusted
 * bootstrap / relay / STUN / TURN servers" offering and its scheduled shutdown
 * ("sunset"). Both the Electron main process and the renderer import from here,
 * and all matching/timing logic below is a set of PURE, unit-tested functions
 * (see predefined-nodes.test.ts).
 *
 * Values here are intentionally release-owned: the README link is the user-facing
 * source of truth, and PREDEFINED_NODES is the post-sunset matching list.
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
// Scheduled shutdown instant for the project-hosted predefined servers.
// Represented as epoch milliseconds so comparison is a trivial number compare.
// Date.parse keeps the source human-readable while parsing once at module load.
// ---------------------------------------------------------------------------
export const PREDEFINED_NODES_SUNSET_TS: number = Date.parse('2026-07-25T00:00:00Z');

// ---------------------------------------------------------------------------
// IMPORTANT: this same string must ALSO appear in the external-URL allowlist so
// the app is permitted to open it — it is already wired there by importing this
// constant into src/electron/constants.ts (ALLOWED_EXTERNAL_URLS). Enter the
// CANONICAL form: https, lowercase host, no trailing slash. The fragment
// (#servers) is preserved by the open path.
// ---------------------------------------------------------------------------
export const PREDEFINED_NODES_README_URL =
  'https://github.com/Realman78/Kiyeovo/blob/main/README.md#servers';

// ---------------------------------------------------------------------------
// The real Kiyeovo fleet (see README#servers). Used ONLY for post-sunset
// matching — detecting whether a user still has one of these saved so the
// sunset notice fires for them. NOT shown in a picker (the offering is a link
// to README#servers where users copy these manually). Must stay in sync with
// the README#servers list so every address a user could have copied matches.
// STUN is available on all 9 nodes; TURN only on the 5 fast-call nodes; every
// node also runs an onion bootstrap (onions are independent, not federated).
// ---------------------------------------------------------------------------
export const PREDEFINED_NODES: readonly PredefinedNode[] = [
  // --- Fast bootstraps (all 9 regions; federated into one DHT) ---
  { kind: 'bootstrap', value: '/ip4/167.172.115.233/tcp/9000/p2p/12D3KooWKDrpSzWYyCaJ4gfNGY5XUjUYN9tVZe8t9biMMY9HxU8K' }, // SFO
  { kind: 'bootstrap', value: '/ip4/134.122.41.208/tcp/9000/p2p/12D3KooWRUpuugGb7Wqwc6vaMQWJV8piHptQYi9p91s1dgE7ebQi' }, // Toronto
  { kind: 'bootstrap', value: '/ip4/170.64.154.208/tcp/9000/p2p/12D3KooWSoxfnJX2oMvY7y42jDLnnnCBHSku9BBhRUDnYaWqgiWp' }, // SYD
  { kind: 'bootstrap', value: '/ip4/157.245.149.195/tcp/9000/p2p/12D3KooWB1zQDckFKLGsDJY111prwCQpReo4pFK46C85WKQgP9sp' }, // SGP
  { kind: 'bootstrap', value: '/ip4/137.184.147.152/tcp/9000/p2p/12D3KooWHX1n6qVE93GbGzDN7dXjVa5Qi1L2WxZAENtma8YPJtsq' }, // NYC
  { kind: 'bootstrap', value: '/ip4/178.104.248.235/tcp/9000/p2p/12D3KooWM2gccLekXRBhtQFCLYQH3ceTDpDcxBp5uNPwMScETr74' }, // Nuremberg
  { kind: 'bootstrap', value: '/ip4/5.78.127.191/tcp/9000/p2p/12D3KooWChq5t2QFvkS4nDx6Uf5QmCaSycYvMggSbQF6x2pXsM1e' }, // Oregon
  { kind: 'bootstrap', value: '/ip4/157.180.85.63/tcp/9000/p2p/12D3KooWJhPVL3tXi7zUNx95z1dTE92zsCzLLW9TS3qjrFPfcDdd' }, // Helsinki
  { kind: 'bootstrap', value: '/ip4/178.156.221.255/tcp/9000/p2p/12D3KooW9vbJN4SWN1y2GcdwPNS9kFxboQ8P3f6AtnUNeMhuvB5M' }, // Ashburn
  // --- Relays (all 9 regions) ---
  { kind: 'relay', value: '/ip4/167.172.115.233/tcp/4002/p2p/12D3KooWDfn9gv6mQsb8CBCmXRPLbBzDaZrcZD8HiQ4a3rgNp4MM' }, // SFO
  { kind: 'relay', value: '/ip4/134.122.41.208/tcp/4002/p2p/12D3KooWEhCb4tfS3G78Xg5xuYqirHkvGnDgbA8PcQk4izki5eZc' }, // Toronto
  { kind: 'relay', value: '/ip4/170.64.154.208/tcp/4002/p2p/12D3KooWFpR8u5L1R4FUtBDGpBq5icAo8aXta697faKQBHC1QGXE' }, // SYD
  { kind: 'relay', value: '/ip4/157.245.149.195/tcp/4002/p2p/12D3KooWK9aN5VwYnMCfeyBiXpLT28zwjK3Jp5sDkcNvuxY7ZgWE' }, // SGP
  { kind: 'relay', value: '/ip4/137.184.147.152/tcp/4002/p2p/12D3KooWRbB1XRS9UFaEeconX5nQUStZGPnEhtgjkzP5RLBkYnBD' }, // NYC
  { kind: 'relay', value: '/ip4/178.104.248.235/tcp/4002/p2p/12D3KooWEKo9h8Rux6gRwoi9t7m1n2RnfoSAHGa2WZYw4LrTXSwH' }, // Nuremberg
  { kind: 'relay', value: '/ip4/5.78.127.191/tcp/4002/p2p/12D3KooWF9p5aoVpC9qYj3EiytwAHgxXs41iJvo5h7gSTfmZnRzW' }, // Oregon
  { kind: 'relay', value: '/ip4/157.180.85.63/tcp/4002/p2p/12D3KooWKdiNwZgvyMFoaLwBGhLKKgjQFUkGXMyuaNqKeFmfzmRV' }, // Helsinki
  { kind: 'relay', value: '/ip4/178.156.221.255/tcp/4002/p2p/12D3KooWByZTmAn7uqrY6e4Lv3XW7eTHY9yxPr4KdxoUK41p1ViB' }, // Ashburn
  // --- STUN (all 9 nodes answer STUN on 3478) ---
  { kind: 'stun', value: 'stun:167.172.115.233:3478' }, // SFO
  { kind: 'stun', value: 'stun:134.122.41.208:3478' }, // Toronto
  { kind: 'stun', value: 'stun:170.64.154.208:3478' }, // SYD
  { kind: 'stun', value: 'stun:157.245.149.195:3478' }, // SGP
  { kind: 'stun', value: 'stun:137.184.147.152:3478' }, // NYC
  { kind: 'stun', value: 'stun:178.104.248.235:3478' }, // Nuremberg
  { kind: 'stun', value: 'stun:5.78.127.191:3478' }, // Oregon
  { kind: 'stun', value: 'stun:157.180.85.63:3478' }, // Helsinki
  { kind: 'stun', value: 'stun:178.156.221.255:3478' }, // Ashburn
  // --- TURN (only the 5 fast-call nodes; creds in README, not here) ---
  { kind: 'turn', value: 'turn:167.172.115.233:3478' }, // SFO
  { kind: 'turn', value: 'turn:170.64.154.208:3478' }, // SYD
  { kind: 'turn', value: 'turn:157.245.149.195:3478' }, // SGP
  { kind: 'turn', value: 'turn:137.184.147.152:3478' }, // NYC
  { kind: 'turn', value: 'turn:178.104.248.235:3478' }, // Nuremberg
  // --- Anonymous-mode onion bootstraps (all 9; independent, not federated).
  // They shut down at the sunset too, so anonymous users must also match. ---
  { kind: 'bootstrap', value: '/onion3/26ls5ncglwcndci23ibeaz2nynivobs6armqonsnwag3gh5sn24rgmid:9000/p2p/12D3KooWApMAqAEWpWenYfXRZwWMUH8arQYjACu7xNhASBWm2st5' }, // SFO
  { kind: 'bootstrap', value: '/onion3/mlumqaf7yqvvewtwfjbzptubbhkforgnukpvrfmanuwt5fu5jpqcijid:9000/p2p/12D3KooWRx8PC5PFA8kkQ6fdyDyRmXibC7oVnrTEhqcb91j8VAB4' }, // Toronto
  { kind: 'bootstrap', value: '/onion3/flhf3mdjvs6zh3lqtrt2vd5gkag2ep6s572eg3dhgh3thisynn3le7ad:9000/p2p/12D3KooWDzpe3uinXk7eiCMH1yRD35Za8PxBeaUYMfkVa2jekq1E' }, // SYD
  { kind: 'bootstrap', value: '/onion3/f3h7acpkqvaz7gyzvahp3jwzw4hadmrwme74k6x2udj4uddhoplas2id:9000/p2p/12D3KooWBec9kfy3Kj1Zw69WrCy8eer8hXhfyPgsqdAQPTNdWuHU' }, // SGP
  { kind: 'bootstrap', value: '/onion3/zsv6t577obbz45yzhvio7crbrbeyslpsa6musmkbifa6iecq55itvfyd:9000/p2p/12D3KooWPgCTLYrNyP5GkHsUjREQcUQMRxCko3hzn7NWZH8ZhxUs' }, // NYC
  { kind: 'bootstrap', value: '/onion3/i6pnryrcixfivzbsz46isf3xvklnvtozdlxa66p2aicklgevh5yoz7ad:9000/p2p/12D3KooWD4q8PbvDUGTq6cJT4FtrcHKosEvH5uR54XZzKXnDZ173' }, // Nuremberg
  { kind: 'bootstrap', value: '/onion3/7sfi5ad4lyyr6vt353j4qlpd3cibesj6ngrqp5nie5odyl32mohngdad:9000/p2p/12D3KooWP3U59XyYP9gJc9Fzq5HS9CvyCgHBk7to8bw3cwZkBDFJ' }, // Oregon
  { kind: 'bootstrap', value: '/onion3/zlsr3koqqpiupr54dysziv6zszhmv5tvlebdngumykmjmrkipywl6gid:9000/p2p/12D3KooWRL1uwgPRggu6g1ejGAvKCn92RTUfYBkhJSqvc3gANJem' }, // Helsinki
  { kind: 'bootstrap', value: '/onion3/syuig6dmiwkqcztfyfb4fmh5367yj6uv2yirnbculpkb3ru4ieb7dcyd:9000/p2p/12D3KooWPUsNXPWapAQUsUdiWpphk1crywH3WRECDxEGLpB8ZeFR' }, // Ashburn
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
  'This opens the Kiyeovo README on github.com in your regular browser, outside the app and outside Tor. You can open the link youself: https://github.com/Realman78/Kiyeovo/blob/main/README.md#servers';
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
