# Trusted profile import allows importing your own profile (self-contact / self-chat)

- **Area:** Core / Identity
- **Severity:** Medium
- **Source:** Test phase 5 review (`testing-findings.md`), confirmed while tracing `ProfileManager.importTrustedUser`
- **Status:** Open

## Summary

`ProfileManager.importTrustedUser` has no explicit guard rejecting a profile whose
`peerId` equals the local user's own peer id. The current duplicate-user check may
block this accidentally when the local user already exists in the `users` table, but
that is incidental DB state rather than an identity-boundary rule.

A fully-formed `[myPeerId, myPeerId]` self-chat is not actually reachable — the
`chat_participants` table has `PRIMARY KEY (chat_id, peer_id)` (`database.ts:502`), so
`createChat` inserting the same `myPeerId` twice fails on the second participant insert.
The real failure modes are both still bad:
- **Local user row present (normal case):** the self-import is rejected only
  *incidentally*, by the duplicate-contact guard, and the user gets the **wrong error**
  ("already exists in your contacts") instead of a self-import error.
- **Local user row absent/inconsistent:** the duplicate guard doesn't fire, `createUser`
  runs and **commits**, then `createChat` throws on the duplicate-participant PK — leaving
  a **partial/dirty** state (an orphaned user row, and `createChat`'s manual transaction
  left open with no rollback — see [[0002-trusted-import-non-atomic-create]]).

## Location

`src/core/identity/profile-manager.ts:128-203` (`importTrustedUser`).

The duplicate guard at `:146-153` only checks `getUserByPeerId(profile.peerId)` for an
*existing contact*; it does not compare `profile.peerId` against `myPeerId`. `createChat`
at `:173` is then called with `participants: [myPeerId, profile.peerId]`.

The local user's own peer is normally inserted into the `users` table during username
registration (`src/core/username/username-registry.ts:514`, `createUser({ peer_id:
context.myPeerId, ... })`). That row is why the duplicate-contact guard *usually* blocks
a self-import incidentally — but it also means the user gets the wrong error ("already
exists in your contacts") instead of a self-import error, and the protection disappears
if that row is absent or inconsistent.

## Steps to reproduce

1. Export the local user's own trusted profile.
2. Re-import it via the trusted-profile import flow with the correct password.
3. Depending on whether the local peer already exists as a `users` row, import either:
   - Fails through the generic duplicate-contact path with the wrong error message, or
   - (local row absent) commits the `createUser` row, then fails in `createChat` on the
     duplicate-participant primary key — leaving an orphaned user row and an open
     transaction, and blocking clean retry.

## Expected behavior

Reject the import with a clear error (e.g. `"Cannot import your own profile"`) before
the duplicate-contact lookup and before `createUser` / `createChat` run, by comparing
`profile.peerId === myPeerId`.

## Suggested fix

Add an early check right after `importProfile` succeeds (before the existing-user lookup):

```ts
if (profile.peerId === myPeerId) {
  return { success: false, error: 'Cannot import your own profile' };
}
```

## Test coverage

Not currently covered. Add `profile-manager.test.ts` cases asserting that importing a
profile with `peerId === myPeerId` returns `{ success: false }` with the self-import
error and writes no contact/chat rows. Cover both with and without a pre-existing local
user row so the explicit guard does not depend on incidental DB state — and in the
absent-row case, assert **no orphaned user row is left behind** (the early guard must run
before `createUser`).
