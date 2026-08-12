import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

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

/**
 * Round 5 (calls) secrets: e2e/e2e.env.local (gitignored via the repo's
 * "*.local" rule) carries KIYEOVO_E2E_STUN/KIYEOVO_E2E_TURN(_USERNAME|
 * _CREDENTIAL) so a real deployed TURN server's credentials never land in a
 * committed file. Loaded with dotenv's default "don't override existing env"
 * behavior, so a real CI env var still wins over the local file. Silently a
 * no-op if the file doesn't exist (e.g. a contributor without TURN access —
 * calls.spec.ts's STUN/TURN evidence scenario degrades gracefully, see its
 * file-level comment).
 */
const envLocalPath = path.join(
    path.resolve(fileURLToPath(new URL('.', import.meta.url))),
    'e2e.env.local',
);
if (existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath });
}

// San Francisco fleet member. These were repointed when the SFO box was
// rebuilt on a new IP: the previous 143.198.137.240 host no longer answers on
// any port (TCP 9000/4002 or STUN 3478), which stalled every spec that needs
// live infra. federation-live.spec.ts already carried the current addresses;
// only these defaults were left behind.
const DEFAULT_BOOTSTRAP_MULTIADDR =
    '/ip4/167.172.115.233/tcp/9000/p2p/12D3KooWKDrpSzWYyCaJ4gfNGY5XUjUYN9tVZe8t9biMMY9HxU8K';
const DEFAULT_RELAY_MULTIADDR =
    '/ip4/167.172.115.233/tcp/4002/p2p/12D3KooWDfn9gv6mQsb8CBCmXRPLbBzDaZrcZD8HiQ4a3rgNp4MM';
const DEFAULT_STUN_URL = 'stun:167.172.115.233:3478';

/** Real bootstrap address. Ignored when USE_LOCAL_BOOTSTRAP is set. */
export const BOOTSTRAP_MULTIADDR = process.env.KIYEOVO_E2E_BOOTSTRAP ?? DEFAULT_BOOTSTRAP_MULTIADDR;

/** Real relay address, configured through the app's Setup > Relay flow. */
export const RELAY_MULTIADDR = process.env.KIYEOVO_E2E_RELAY ?? DEFAULT_RELAY_MULTIADDR;

/** Real STUN server, configured through the app's Setup > Calls (ICE) flow. */
export const STUN_URL = process.env.KIYEOVO_E2E_STUN ?? DEFAULT_STUN_URL;

/**
 * Real deployed TURN server (round 5, calls.spec.ts's strategic goal: prove
 * the deployed TURN/STUN infra actually served a call). Undefined whenever
 * any of the three env vars is missing — callers must treat TURN as optional
 * and degrade gracefully (see calls.spec.ts's scenario C) rather than assume
 * it's always configured. Only variable NAMES are referenced here; values
 * come from e2e/e2e.env.local (gitignored) or a real env var, never from a
 * committed file.
 */
export const TURN_SERVER = (
    process.env.KIYEOVO_E2E_TURN
    && process.env.KIYEOVO_E2E_TURN_USERNAME
    && process.env.KIYEOVO_E2E_TURN_CREDENTIAL
)
    ? {
        // Inferred from the URL's own scheme (matches the app's IceSetup.tsx
        // Type picker / ipc-handlers.ts inferIceServerType prefix check) so a
        // future turns: swap in e2e.env.local doesn't need a code change here.
        type: (process.env.KIYEOVO_E2E_TURN.toLowerCase().startsWith('turns:') ? 'turns' : 'turn') as 'turn' | 'turns',
        url: process.env.KIYEOVO_E2E_TURN,
        username: process.env.KIYEOVO_E2E_TURN_USERNAME,
        credential: process.env.KIYEOVO_E2E_TURN_CREDENTIAL,
    }
    : undefined;

/** Escape hatch: spawn a throwaway local bootstrap node instead of dialing the real one. */
export const USE_LOCAL_BOOTSTRAP = process.env.KIYEOVO_E2E_LOCAL_BOOTSTRAP === '1';

/**
 * Round 9 (tor-deployed-infra.spec.ts, the deploy-verification gate): the
 * REAL, deployed anonymous-mode onion bootstrap's full client multiaddr
 * (`/onion3/<56-char-host>:9000/p2p/<peerId>` — same shape
 * e2e/tor.ts's startOnionFrontedBootstrap mints for the throwaway local one).
 * Carried only in e2e/e2e.env.local (gitignored via the repo's "*.local"
 * rule, loaded above) or a real env var — NEVER hardcoded here, unlike
 * BOOTSTRAP_MULTIADDR's fast-mode default above, because this address
 * identifies a specific operator-run anonymous-mode server rather than a
 * value safe to bake into a public repo. `undefined` when unset; callers
 * (tor-deployed-infra.spec.ts) must `test.skip()` rather than assume a
 * fallback — there is no throwaway-local substitute for "prove the real
 * deployed infra speaks the anonymous protocol namespace".
 */
export const ONION_BOOTSTRAP_MULTIADDR = process.env.KIYEOVO_E2E_ONION_BOOTSTRAP;

/**
 * Round 10 (federation-live.spec.ts): a SECOND real, deployed bootstrap node
 * — DIFFERENT from BOOTSTRAP_MULTIADDR ("bootstrap A") above — used to prove
 * cross-bootstrap DHT federation on the live fleet (BOOTSTRAP_PEERS
 * federation, commit 1396694 in src/core/bootstrap.ts) rather than
 * federation.spec.ts's already-covered "two throwaway LOCAL bootstraps"
 * shape. There is no safe default the way BOOTSTRAP_MULTIADDR has one:
 * picking an arbitrary second fleet member here would silently test
 * federation between two nodes the caller never chose, instead of the actual
 * pair (e.g. two different continents/providers) they want evidence for. So
 * this is required-only — `undefined` when unset — and
 * federation-live.spec.ts must `test.skip()` rather than assume a fallback,
 * matching ONION_BOOTSTRAP_MULTIADDR's precedent just above.
 */
export const BOOTSTRAP_MULTIADDR_B = process.env.KIYEOVO_E2E_BOOTSTRAP_B;

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
 * | group-join-catchup.spec.ts  | 9161-9163       | 19506 (only when USE_LOCAL_BOOTSTRAP=1) |
 * | calls.spec.ts               | 9171-9172       | 19507 (only when USE_LOCAL_BOOTSTRAP=1) |
 * | username-lookup.spec.ts     | 9181-9189       | 20411-20419 (explicit — scenarios D/E always spin up their own local bootstraps regardless of USE_LOCAL_BOOTSTRAP, to control DHT-record liveness precisely; only 20411-20413 currently used, room left in the block) |
 * | tor-mode.spec.ts            | 9191-9199 (anonymous-mode libp2p listen ports) | 20421-20429 (onion-fronted local bootstrap TCP ports — see e2e/tor.ts's startOnionFrontedBootstrap; only 20421-20422 currently used) — ALSO owns its own bundled-Tor-daemon SocksPort/ControlPort pairs, a range no other spec file touches: 9561/9562 (instance A) and 9563/9564 (instance B), plus the fronting tor itself (SocksPort 0 — binds nothing) |
 * | trusted-import.spec.ts      | 9201-9209 (S1/S2 fast-mode + S3 anonymous-mode libp2p listen ports, mixed in one file) | 20431-20439 (S3's onion-fronted local bootstrap TCP port; only 20431 currently used — following tor-mode.spec.ts's row as the example) — ALSO owns its own bundled-Tor-daemon SocksPort/ControlPort pairs, a range no other spec file touches: 9571/9572 (instance A) and 9573/9574 (instance B) |
 * | tor-groups.spec.ts          | 9211-9219 (anonymous-mode libp2p listen ports; G1 uses 9211-9213 for A/B/C, G2 uses 9214-9216 for its OWN A/B/C — see the file's G2 finding note: NewGroupDialog requires >=2 invitees, so G2 could not stay a leaner two-instance test as originally planned) | 20441-20449 (onion-fronted local bootstrap TCP ports; G1 uses 20441, G2 uses 20442) — ALSO owns its own bundled-Tor-daemon SocksPort/ControlPort pairs, a range no other spec file touches: 9575/9576 (instance A), 9577/9578 (instance B), 9579/9580 (instance C — G1 and G2 both reuse the same three pairs since tests within a file never run concurrently) |
 * | tor-deployed-infra.spec.ts  | 9221 (anonymous-mode libp2p listen port) | none — this file targets the real DEPLOYED onion bootstrap (KIYEOVO_E2E_ONION_BOOTSTRAP) and spins up no local bootstrap of its own, onion-fronted or otherwise | — ALSO owns its own bundled-Tor-daemon SocksPort/ControlPort pair, a range no other spec file touches: 9581/9582 |
 * | group-rotation-nudge.spec.ts | 9231-9239 (fast-mode + anonymous-mode libp2p listen ports, mixed in one file) | 20451-20459 (fast-mode tests R1/R2/R4 always spin up their own local throwaway bootstrap regardless of USE_LOCAL_BOOTSTRAP, to control connection liveness precisely — same rationale as network-edges.spec.ts; R3's onion-fronted local bootstrap uses 20452 within that block) | — R3 (Tor) ALSO owns its own bundled-Tor-daemon SocksPort/ControlPort pairs, a range no other spec file touches: 9585/9586, 9587/9588, 9589/9590 |
 * | federation-live.spec.ts     | 9241-9244       | none — targets TWO real DEPLOYED bootstraps (BOOTSTRAP_MULTIADDR "A" + BOOTSTRAP_MULTIADDR_B "B") and spins up no local bootstrap of its own, same rationale as tor-deployed-infra.spec.ts's row |
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
