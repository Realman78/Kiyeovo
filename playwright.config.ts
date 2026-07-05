import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './e2e',
    outputDir: './test-results',
    timeout: 60_000,
    expect: { timeout: 10_000 },
    // Each test boots its own Electron instance (libp2p node, Tor, sqlite);
    // run them one at a time to keep resource usage and port use predictable.
    fullyParallel: false,
    workers: 1,
    reporter: [['list'], ['html', { open: 'never' }]],
});
