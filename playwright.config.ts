import { defineConfig } from '@playwright/test';

// Default worker count for the e2e suite. Each spec FILE now owns a disjoint
// KIYEOVO_P2P_PORT / local-bootstrap-port range (see e2e/config.ts's "PORT
// RANGES" table), so distinct files can safely run concurrently in separate
// workers even with fullyParallel:false (tests *within* one file still run
// sequentially in a single worker — only cross-file parallelism changed).
//
// Sizing rationale (audited on the dev box this suite normally runs on: 4
// vCPUs, ~7.7GB RAM): the heaviest spec files launch up to 3 Electron
// instances at once (group-chat.spec.ts, file-transfer.spec.ts;
// network-edges.spec.ts's 8-bootstrap scenario forks several lightweight tsx
// child processes alongside 1 Electron instance). At ~150-300MB per Electron
// instance, 3 workers' worst case (three heavy files landing on separate
// workers at once, ~9 Electron instances + bootstrap-node children) stays
// comfortably under 3GB, leaving headroom under 7.7GB total and one spare CPU
// core (of 4) for Xvfb/the OS. Override with KIYEOVO_E2E_WORKERS if a given
// box is smaller/larger.
// Revised 3 -> 2 after round 4 (blocking.spec.ts) added a THIRD heavy
// three-Electron-instance spec file: with 3 workers, three heavy files now
// regularly overlap (~9-10 concurrent instances mid-onboarding), which
// starves 4 vCPUs and produced roaming DHT-stage timeouts across otherwise
// healthy specs. Two workers cap the worst case at ~6 instances; measured
// cost is ~1 extra minute of wall time for a stable suite.
const DEFAULT_WORKERS = 2;

export default defineConfig({
    testDir: './e2e',
    outputDir: './test-results',
    timeout: 60_000,
    expect: { timeout: 10_000 },
    // Each test boots its own Electron instance (libp2p node, Tor, sqlite).
    // fullyParallel stays false so tests *within* one file never interleave
    // (they still share hardcoded ports/state within that file) — but with
    // workers > 1, distinct spec files (each with their own disjoint port
    // range) now run concurrently across workers. See KIYEOVO_E2E_WORKERS
    // above to override the default.
    fullyParallel: false,
    workers: Number(process.env.KIYEOVO_E2E_WORKERS) || DEFAULT_WORKERS,
    reporter: [['list'], ['html', { open: 'never' }]],
});
