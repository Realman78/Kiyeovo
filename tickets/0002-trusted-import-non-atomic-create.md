# Trusted profile import is non-atomic: createUser + createChat without rollback

- **Area:** Core / Identity + DB
- **Severity:** Medium
- **Source:** Test phase 5 review (surfaced while tracing `importTrustedUser`)
- **Status:** Open

## Summary

`ProfileManager.importTrustedUser` performs two separate persistence steps —
`database.createUser(...)` then `database.createChat(...)` — with no surrounding
transaction or rollback. If `createChat` throws after `createUser` has already
committed, the contact (user row) is left persisted with no associated chat. The
caller sees `{ success: false }`, but the partial user row remains.

A subsequent retry then hits the duplicate-user guard (`getUserByPeerId`) at
`:146-153` and fails with `"... already exists in your contacts"`, leaving the user
unable to complete the import without manual cleanup.

## Location

`src/core/identity/profile-manager.ts:165-185` (`createUser` then `createChat`).

## Expected behavior

Create the trusted contact user row and the direct chat as one atomic DB operation, so
a failure in chat creation rolls back the user insert and the import can be retried
cleanly.

Preferred shape: add a focused DB-level helper such as
`createTrustedDirectContact(...)` that owns the whole insert sequence in one
transaction. That keeps persistence ownership in the DB layer and avoids spreading
compensating cleanup logic into `ProfileManager`.

Avoid a naive outer `BEGIN` around the existing `createUser(...)` and `createChat(...)`
calls: `createChat` currently starts its own manual transaction, so a nested transaction
would need a refactor or a helper that inserts the chat using the caller's transaction.

## Notes

- `createChat` already inserts both the chat and its `chat_participants` rows inside its
  own transaction; the missing boundary is the larger `createUser + createChat` unit.
- **`createChat` has no rollback of its own.** It runs `this.db.exec('BEGIN TRANSACTION')`
  → inserts → `COMMIT` (`database.ts:1484-1514`) with no `try`/`catch`/`ROLLBACK`. So any
  insert failure between `BEGIN` and `COMMIT` (e.g. a duplicate-participant PK, as in the
  self-import case of [[0001-trusted-import-self-import-guard]]) throws with the
  connection **left inside an open transaction** — which then breaks the next operation
  (a subsequent `BEGIN` errors with "cannot start a transaction within a transaction").
  This is why the preferred fix is a focused DB helper that owns the whole
  trusted-contact creation via `better-sqlite3` transaction ownership (`db.transaction(...)`,
  which auto-rolls-back on throw), rather than compensating cleanup in `ProfileManager`.
- The duplicate-user guard means partial state is *sticky* (retries fail), which raises
  the practical impact above a simple "orphan row" cosmetic issue.

## Test coverage

Not currently covered. Add a case that injects a `createChat` failure and asserts no
user row remains afterward (clean retry possible).
