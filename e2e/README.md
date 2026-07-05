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

## Isolation

`e2e/electron.ts` launches each app instance with `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME` pointed at a fresh temp dir, so tests never read or write the real `~/.config/Kiyeovo` profile, and the single-instance lock doesn't collide with a dev instance you have open. This also allows launching multiple instances in one test (e.g. two peers messaging each other) by calling `launchApp()` twice.

**Not isolated:** keytar still talks to the real session keychain (libsecret). Tests must not create or delete keychain-backed credentials. Headless environments without a Secret Service daemon may need `gnome-keyring` (or the app's non-keychain fallback path) for flows that touch credentials.
