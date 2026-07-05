# Database backup is unencrypted and restore is unauthenticated (raw DB replacement)

- **Area:** Core / DB + Electron IPC (backup/restore) — data-at-rest + integrity
- **Severity:** Medium
- **Source:** Security scan — backup/restore (data-at-rest + malicious-file threat model)
- **Status:** Open

## Threat model

A backup artifact is, by design, meant to leave the machine (USB, cloud sync,
another device), so "rely on OS full-disk encryption" does not protect it. And a
restore file may be attacker-supplied and socially engineered onto a victim ("here's
your backup, import it to migrate"). Both the confidentiality of an exported backup
and the integrity/authenticity of a restored one are in scope.

Note: this is the **database** backup (`BACKUP_DATABASE` / `RESTORE_DATABASE` /
`RESTORE_DATABASE_FROM_FILE`), NOT the profile/contact export (`ProfileManager`,
`.kiyeovo`), which *is* properly scrypt + AES-256-GCM encrypted and ed25519-signed.
The gap is specific to the DB backup path.

## Consequence 1 — backup is plaintext (confidentiality at rest)

`ChatDatabase.backup` (`src/core/db/database.ts:4597-4599`) is a raw SQLite file copy:

```ts
async backup(backupPath: string): Promise<void> {
  await this.db.backup(backupPath);   // plain .db, no cipher
}
```

The database stores message content in cleartext by design — schema comment at
`database.ts:~452`: `content TEXT NOT NULL, -- Decrypted content stored in plaintext
(relies on OS disk encryption for at-rest protection)`. So the exported `.db`
contains **all messages and contacts in plaintext**. Only the identity keys
(`encrypted_user_identities`) are individually encrypted. If the backup file is
stolen or synced off a full-disk-encrypted context, the entire message/contact
history is readable. The backup layer applies no password, KDF, or cipher, and the
file inherits the process umask (typically world-readable on Linux).

## Consequence 2 — restore is an unauthenticated raw DB swap (integrity / trust)

`ChatDatabase.restore` (`database.ts:4601-4618`) and the IPC handlers
(`ipc-handlers.ts:3287-3357`) copy an attacker-controllable file verbatim over the
live database and then open and fully trust it:

```ts
async restore(backupPath: string): Promise<void> {
  this.close();
  await fs.copyFile(backupPath, this.dbPath);   // no auth, no integrity, no format check
  this.db = new Database(this.dbPath);
  ...
}
```

There is **no MAC, no signature, no password, no magic/version/schema validation** —
nothing to verify the file is a genuine backup of *this* account. A crafted `.db`
therefore fully replaces the victim's database, letting an attacker:

- Plant arbitrary **contacts, trusted-user rows, and signing keys** — i.e. seed the
  trust store the rest of the app relies on (the local analogue of, and a bypass for,
  the TOFU/identity checks reviewed in
  [[0006-dht-username-record-missing-peerid-libp2p-binding]] /
  [[0007-tofu-signing-key-change-no-alert]]).
- Plant a forged **message/conversation history**.
- Swap or downgrade the **identity** (`encrypted_user_identities` rows the attacker
  crafted), plus cooldown/login-attempt/rate-limit state.
- Seed attacker-controlled **`messages.file_path`** rows. Media read-back
  (`resolveCompletedImageMedia`) does not pin the path inside the downloads dir — it
  relied on the write path being the sole writer of `file_path` (noted during the
  file-transfer review). Restore breaks that invariant, making the read-back's
  symlink/is-file/image-mime checks the only remaining guard.

### Sub-issues

- **Pre-login reachability:** `RESTORE_DATABASE_FROM_FILE` (`ipc-handlers.ts:3313-3357`)
  is invoked from `PasswordPrompt.tsx` *before* authentication, so the DB (and identity)
  can be replaced before the user logs in.
- **Destroys existing DB before validating:** that handler `unlink`s `chat.db`,
  `chat.db-wal`, `chat.db-shm` (`:3323-3339`) and *then* `copyFile`s the new file
  (`:3342`), with only a `stat` existence check (`:3346`). A failed or malicious restore
  therefore also destroys the user's existing database — data loss even on a benign
  error, with no pre-restore safety copy.
- **Two inconsistent restore implementations + stale-WAL risk:** the logged-in
  `RESTORE_DATABASE` path delegates to `ChatDatabase.restore` (`database.ts:4601-4618`),
  which copies the file over `chat.db` but does **not** remove/replace the `chat.db-wal`
  / `chat.db-shm` sidecars — whereas the pre-login path deletes them first. Copying a new
  `chat.db` while leaving the *old* WAL in place risks SQLite applying a stale WAL to the
  new database on reopen (corruption/inconsistency). The two paths handling sidecars
  differently is itself a bug; a correct fix should be a **single** restore helper (see
  below).

## Location

- `src/core/db/database.ts:4597-4599` (`backup`), `:4601-4618` (`restore`).
- `src/electron/ipc-handlers.ts:3269-3285` (`BACKUP_DATABASE`), `:3287-3311`
  (`RESTORE_DATABASE`), `:3313-3357` (`RESTORE_DATABASE_FROM_FILE`, pre-login).
- Raw renderer-supplied restore paths overlap with
  [[0003-get-file-metadata-and-backup-raw-renderer-paths]].

## Expected behavior

- An exported backup should be confidential without relying on where it lands.
- A restore should verify the file is an authentic, intact backup of this account
  before replacing any live state, and should never destroy the existing DB unless the
  replacement is validated.

## Suggested fix

Use **authenticated encryption for the backup artifact** — this closes both
consequences at once (the machinery already exists in `ProfileManager` /
`EncryptedUserIdentity`: scrypt + AES-256-GCM):

1. On backup, serialize/copy the DB, then encrypt it under a user password (scrypt,
   random salt) with AES-256-GCM (or bind to the account identity and sign it). Write a
   small header with a magic + format version. Set restrictive file permissions
   (0600).
2. On restore, require the password / verify the signature and the GCM tag / format
   header **before** touching the live DB. Reject anything that doesn't authenticate.
3. Use **one** restore helper for both the logged-in and pre-login paths (eliminating
   the two divergent implementations): restore to a temp location, validate/authenticate
   it, checkpoint/close the current DB, then atomically swap `chat.db` **plus its `-wal`
   / `-shm` sidecars** together, keeping the previous DB+sidecars as a rollback until the
   new one opens cleanly (fixes both the pre-copy `unlink` data-loss window and the
   stale-WAL inconsistency).
4. Reconsider the pre-login restore path — at minimum apply the same
   authenticate-before-replace rule there.

### Boundary with 0003 (keep separate)

This ticket owns **backup-artifact confidentiality** and **restore
authenticity/integrity + validate-before-replace**.
[[0003-get-file-metadata-and-backup-raw-renderer-paths]] owns **capability-binding the
renderer-supplied file paths** for backup/restore (and `GET_FILE_METADATA`). The final
implementation will likely share a main-process dialog/capability flow (0003) plus a
backup-artifact verifier (0013), but the two concerns should stay in separate tickets.

## Test coverage

Not currently covered. Add:
- Backup output does not contain plaintext message content (is encrypted).
- A malformed or unauthenticated restore file is rejected **before** any existing DB
  file or sidecar is removed/replaced.
- A failed logged-in restore leaves the original DB openable and unchanged.
- A failed pre-login restore leaves the original `chat.db`, `chat.db-wal`, and
  `chat.db-shm` intact.
- The restore helper handles sidecars consistently across the logged-in and pre-login
  flows.
