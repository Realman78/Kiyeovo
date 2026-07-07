# End-to-end tests

Playwright drives the real Electron app via its [Electron driver](https://playwright.dev/docs/api/class-electron) — no browser downloads needed; it launches the `electron` binary already in `node_modules`.

## Running

The suite launches the **built** app, so build first:

```bash
npm run transpile:electron && npm run build
npm run test:e2e            # on a desktop session (windows appear on screen)
npm run test:e2e:headless   # under Xvfb (requires xvfb-run, e.g. apt install xvfb)
```

Failure artifacts and screenshots land in `test-results/`; an HTML report in `playwright-report/` (both git-ignored).

## Parallelism

`playwright.config.ts` keeps `fullyParallel: false` — tests *within* one spec
file always run sequentially in a single worker (several hardcode fixed
ports/state that only make sense one-at-a-time within a file). Distinct spec
**files**, however, each own a disjoint `KIYEOVO_P2P_PORT` / local-bootstrap
port range (see the "PORT RANGES" table in `e2e/config.ts`), so they can run
concurrently across multiple workers without colliding.

The default worker count (`DEFAULT_WORKERS` in `playwright.config.ts`) is
sized for a 4 vCPU / ~7.7GB box; override it per-machine with:

```bash
KIYEOVO_E2E_WORKERS=1 npm run test:e2e:headless   # serialize back to one worker
KIYEOVO_E2E_WORKERS=4 npm run test:e2e:headless   # more aggressive, if the box can take it
```

Adding a new spec file? Give it its own port block in the `e2e/config.ts`
table (and an explicit local-bootstrap port if it calls `startBootstrapNode()`
with no argument) rather than reusing another file's range.

## Isolation

`e2e/electron.ts` launches each app instance with `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME` pointed at a fresh temp dir (isolates Electron's own userData — session, cookies, single-instance lock) **and** `HOME` pointed at a fresh temp dir too. The `HOME` override matters more than it looks: `ensureAppDataDir()` (`src/core/utils/miscellaneous.ts`) computes the app's real data directory (chat.db, encrypted identity, window-bounds.json) from `os.homedir()` directly — it does not consult Electron's userData path or the XDG env vars at all, and always resolves to `~/.config/kiyeovo` on Linux. Without the `HOME` override, every `launchApp()` call (and every test run) would read/write that single fixed directory, so two peers launched in the same test would silently share one identity/database, and successive test runs would find "someone else's" identity still sitting there from the last run. This also allows launching multiple instances in one test (e.g. two peers messaging each other) by calling `launchApp()` twice.

**Not isolated:** keytar still talks to the real session keychain (libsecret). Tests must not create or delete keychain-backed credentials. Headless environments without a Secret Service daemon may need `gnome-keyring` (or the app's non-keychain fallback path) for flows that touch credentials.
