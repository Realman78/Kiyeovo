import { randomBytes } from 'node:crypto';

/**
 * Single source of truth for the network infrastructure the e2e suite points
 * at. Defaults to the real, publicly-deployed Kiyeovo infra (not a throwaway
 * local node) so the suite exercises the actual user path through the setup
 * wizard. Each address is independently overridable via env so CI or a
 * developer can point at different infra without editing test code.
 *
 * KIYEOVO_E2E_LOCAL_BOOTSTRAP=1 is an escape hatch back to the old behavior:
 * two-peer.spec.ts spawns a throwaway local bootstrap node (see
 * bootstrap-node.ts) instead of dialing the real one. Relay/STUN still come
 * from the real infra (or their own env overrides) in that mode too — only
 * the bootstrap source changes.
 */

const DEFAULT_BOOTSTRAP_MULTIADDR =
    '/ip4/143.198.137.240/tcp/9000/p2p/12D3KooWL9V168N9rzJ2HP5aWKdJMUDtbYWca5ojDtELWWggddVu';
const DEFAULT_RELAY_MULTIADDR =
    '/ip4/143.198.137.240/tcp/4002/p2p/12D3KooWKx9xPFweD6isahRpjkNR6BxEtJKpbZvvfskb44E8q83x';
const DEFAULT_STUN_URL = 'stun:143.198.137.240:3478';

/** Real bootstrap address. Ignored when USE_LOCAL_BOOTSTRAP is set. */
export const BOOTSTRAP_MULTIADDR = process.env.KIYEOVO_E2E_BOOTSTRAP ?? DEFAULT_BOOTSTRAP_MULTIADDR;

/** Real relay address, configured through the app's Setup > Relay flow. */
export const RELAY_MULTIADDR = process.env.KIYEOVO_E2E_RELAY ?? DEFAULT_RELAY_MULTIADDR;

/** Real STUN server, configured through the app's Setup > Calls (ICE) flow. */
export const STUN_URL = process.env.KIYEOVO_E2E_STUN ?? DEFAULT_STUN_URL;

/** Escape hatch: spawn a throwaway local bootstrap node instead of dialing the real one. */
export const USE_LOCAL_BOOTSTRAP = process.env.KIYEOVO_E2E_LOCAL_BOOTSTRAP === '1';

/**
 * Port-range registry (grep for "PORT RANGES" to find this again).
 *
 * playwright.config.ts keeps `fullyParallel: false`, so tests *within* one
 * spec file always run one-at-a-time in a single worker — but with
 * `workers > 1` (see KIYEOVO_E2E_WORKERS), distinct spec FILES can now run
 * concurrently in separate workers. Every `KIYEOVO_P2P_PORT` (libp2p listen
 * port, passed to launchApp({ p2pPort })) and every local throwaway
 * bootstrap-node port (bootstrap-node.ts's startBootstrapNode(), only spun up
 * when USE_LOCAL_BOOTSTRAP=1 or explicitly by network-edges.spec.ts) must
 * therefore be unique per FILE, not just per test, or two files racing in
 * parallel workers will EADDRINUSE / cross-connect. Static per-file ranges
 * (rather than a runtime allocator) are enough because fullyParallel stays
 * false: a file's own ports are never live concurrently with another test in
 * the *same* file, only with tests in other files.
 *
 * | Spec file                  | p2pPort range   | local-bootstrap port(s)        |
 * |-----------------------------|-----------------|---------------------------------|
 * | smoke.spec.ts               | 9001 (implicit default — launchApp() called with no p2pPort at all; never relaunches, so nothing else may claim 9001) | none |
 * | two-peer.spec.ts            | 9101-9102       | 19501 (only when USE_LOCAL_BOOTSTRAP=1) |
 * | group-chat.spec.ts          | 9141-9143       | 19502 (only when USE_LOCAL_BOOTSTRAP=1) |
 * | offline-delivery.spec.ts    | 9111-9112       | 19503 (only when USE_LOCAL_BOOTSTRAP=1) |
 * | file-transfer.spec.ts       | 9121-9123, 9124-9126 (two sequential setupThreePeerWorld() calls in the same file — see world.ts) | 19504 (only when USE_LOCAL_BOOTSTRAP=1; both calls share it, safe since they run sequentially within one file/worker) |
 * | network-edges.spec.ts       | 9131-9138       | 19611-19612, 19691-19694, 19791-19793, 19891, 19921-19922, 19951, 20011, 20111-20118, 20311-20313 (all explicit — this file always spins up its own local bootstraps regardless of USE_LOCAL_BOOTSTRAP, to control liveness precisely) |
 * | blocking.spec.ts            | 9151-9153       | 19505 (only when USE_LOCAL_BOOTSTRAP=1) |
 *
 * Adding a new spec file: pick an unused p2pPort block (leave a gap of at
 * least 10 for headroom) and, if it calls startBootstrapNode() with no
 * explicit port, pass one from the 195xx block above instead of relying on
 * the bare default (19501) — that default is only claimed by two-peer.spec.ts.
 */

/**
 * Usernames registered during onboard() are published to the DHT via
 * `BOOTSTRAP_MULTIADDR`. Against the real, persistent public infra those
 * registrations outlive a single test run, so a fixed per-testId name (as
 * used previously against the throwaway local node) would collide with a
 * prior run's registration. Mint a fresh random suffix every run instead —
 * Playwright test files are allowed to use Date.now()/randomness.
 */
export function uniqueRunSuffix(): string {
    return randomBytes(4).toString('hex');
}
