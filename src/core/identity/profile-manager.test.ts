import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ChatDatabase } from '../db/database.js';
import { EncryptedUserIdentity } from './encrypted-user-identity.js';
import { ProfileManager } from './profile-manager.js';

async function withoutConsoleNoise<T>(run: () => Promise<T>): Promise<T> {
  const originalError = console.error;
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.error = () => undefined;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    return await run();
  } finally {
    console.error = originalError;
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

test('trusted profile export/import round-trips public contact data and rejects wrong passwords', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kiyeovo-profile-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const identity = await EncryptedUserIdentity.createEncrypted();
  const filePath = join(dir, 'alice.kiyeovo');
  const password = 'Profile-password-123!';
  const sharedSecret = 'alice-default-inbox-key';

  const exportResult = await withoutConsoleNoise(() => ProfileManager.exportProfileDesktop(
    identity,
    'Alice',
    identity.id,
    filePath,
    password,
    sharedSecret,
  ));

  assert.equal(exportResult.success, true);
  assert.equal(exportResult.filePath, filePath);
  assert.equal(typeof exportResult.fingerprint, 'string');

  const imported = await withoutConsoleNoise(() => ProfileManager.importProfile(filePath, password));
  assert.equal(imported.username, 'Alice');
  assert.equal(imported.peerId, identity.id);
  assert.equal(imported.defaultInboxKey, sharedSecret);
  assert.equal(imported.signingPublicKey, Buffer.from(identity.signingPublicKey).toString('base64'));
  assert.equal(ProfileManager.calculateFingerprint(imported), exportResult.fingerprint);
  assert.equal('signingPrivateKey' in imported, false);
  assert.equal('offlinePrivateKey' in imported, false);

  await assert.rejects(
    withoutConsoleNoise(() => ProfileManager.importProfile(filePath, 'wrong-password')),
    /Failed to decrypt profile/,
  );
});

test('trusted profile import creates an out-of-band direct chat and rejects duplicates', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kiyeovo-trusted-import-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());

  await database.createUser({
    peer_id: 'local-peer',
    username: 'Local User',
    signing_public_key: 'local-signing-public-key',
    offline_public_key: 'local-offline-public-key',
    signature: 'local-signature',
  });

  const identity = await EncryptedUserIdentity.createEncrypted();
  const filePath = join(dir, 'trusted.kiyeovo');
  const password = 'Profile-password-123!';
  const sharedSecret = 'trusted-default-inbox-key';

  const exportResult = await withoutConsoleNoise(() => ProfileManager.exportProfileDesktop(
    identity,
    'Trusted Alice',
    identity.id,
    filePath,
    password,
    sharedSecret,
  ));
  assert.equal(exportResult.success, true);

  const imported = await withoutConsoleNoise(() => ProfileManager.importTrustedUser(
    filePath,
    password,
    'local-peer',
    database,
    'Alice Local',
  ));

  assert.equal(imported.success, true);
  assert.equal(imported.username, 'Alice Local');
  assert.equal(imported.peerId, identity.id);
  assert.equal(typeof imported.chatId, 'number');

  const user = database.getUserByPeerId(identity.id);
  assert.equal(user?.username, 'Alice Local');
  assert.equal(user?.signing_public_key, Buffer.from(identity.signingPublicKey).toString('base64'));

  const chat = database.getChatByPeerId(identity.id);
  assert.equal(chat?.trusted_out_of_band, true);
  assert.equal(chat?.offline_bucket_secret, sharedSecret);
  assert.deepEqual(database.getChatParticipants(chat?.id ?? -1).map((participant) => participant.peer_id).sort(), [
    'local-peer',
    identity.id,
  ].sort());

  const duplicate = await withoutConsoleNoise(() => ProfileManager.importTrustedUser(
    filePath,
    password,
    'local-peer',
    database,
  ));
  assert.equal(duplicate.success, false);
  assert.match(duplicate.error ?? '', /already exists/);
});
