import { join } from 'path';
import type { P2PCore } from '../core/index.js';
import { ChatDatabase } from '../core/db/database.js';
import { ensureAppDataDir } from '../core/utils/miscellaneous.js';

/**
 * Runs `run` against the app's settings-capable database.
 *
 * When the P2P core is already initialized (post-unlock) it reuses the live
 * database handle. Otherwise it opens the on-disk sqlite file directly and
 * closes it afterwards - the `settings` table holds plain (non-encrypted)
 * key/value pairs, so this works even before identity unlock (e.g. from the
 * lock/password screen), mirroring how `readPersistedNetworkMode()` in
 * main.ts detects the network mode before the P2P core exists.
 */
export function withSettingsDatabase<T>(
  getP2PCore: () => P2PCore | null,
  run: (db: ChatDatabase) => T,
): T {
  const p2pCore = getP2PCore();
  if (p2pCore) {
    return run(p2pCore.database);
  }

  const dbPath = join(ensureAppDataDir(), 'chat.db');
  const tempDb = new ChatDatabase(dbPath);
  try {
    return run(tempDb);
  } finally {
    tempDb.close();
  }
}
