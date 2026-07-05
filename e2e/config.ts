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
