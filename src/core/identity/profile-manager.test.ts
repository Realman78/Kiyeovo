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

type TrustedImportResult = Awaited<ReturnType<typeof ProfileManager.importTrustedUser>>;

async function importTrustedUserWithBlockedDatabaseWork(
  filename: string,
  password: string,
  myPeerId: string,
  database: ChatDatabase,
  customName?: string
): Promise<TrustedImportResult> {
  const originalGetUserByPeerId = database.getUserByPeerId.bind(database);
  const originalCreateUser = database.createUser.bind(database);
  const originalCreateChat = database.createChat.bind(database);

  database.getUserByPeerId = (() => {
    throw new Error('getUserByPeerId should not be called for self-import');
  }) as ChatDatabase['getUserByPeerId'];
  database.createUser = (async () => {
    throw new Error('createUser should not be called for self-import');
  }) as ChatDatabase['createUser'];
  database.createChat = (async () => {
    throw new Error('createChat should not be called for self-import');
  }) as ChatDatabase['createChat'];

  try {
    return await withoutConsoleNoise(() => ProfileManager.importTrustedUser(
      filename,
      password,
      myPeerId,
      database,
      customName,
    ));
  } finally {
    database.getUserByPeerId = originalGetUserByPeerId;
    database.createUser = originalCreateUser;
    database.createChat = originalCreateChat;
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

test('trusted profile import trims custom names and rejects whitespace-only custom names', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kiyeovo-trusted-import-name-test-'));
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

  const whitespaceOnly = await withoutConsoleNoise(() => ProfileManager.importTrustedUser(
    filePath,
    password,
    'local-peer',
    database,
    '   ',
  ));

  assert.equal(whitespaceOnly.success, false);
  assert.match(whitespaceOnly.error ?? '', /Username must be between 2 and 64 characters/);
  assert.equal(database.getUserByPeerId(identity.id), null);

  const imported = await withoutConsoleNoise(() => ProfileManager.importTrustedUser(
    filePath,
    password,
    'local-peer',
    database,
    '  Al  ',
  ));

  assert.equal(imported.success, true);
  assert.equal(imported.username, 'Al');
  assert.equal(database.getUserByPeerId(identity.id)?.username, 'Al');
});

test('trusted profile import rolls back contact user when chat creation fails and retry succeeds', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kiyeovo-trusted-import-atomic-test-'));
  const database = new ChatDatabase(join(dir, 'chat.sqlite'));
  t.after(async () => {
    database.close();
    await rm(dir, { recursive: true, force: true });
  });

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

  type CreateTrustedDirectContact = ChatDatabase['createTrustedDirectContact'];
  const originalCreateTrustedDirectContact: CreateTrustedDirectContact = database.createTrustedDirectContact.bind(database);
  let createAttempts = 0;
  database.createTrustedDirectContact = ((
    user: Parameters<CreateTrustedDirectContact>[0],
    chat: Parameters<CreateTrustedDirectContact>[1],
  ) => {
    createAttempts += 1;
    const chatWithInjectedFailure = createAttempts === 1
      ? { ...chat, participants: [chat.created_by, chat.created_by] }
      : chat;
    return originalCreateTrustedDirectContact(user, chatWithInjectedFailure);
  }) as CreateTrustedDirectContact;

  const failed = await withoutConsoleNoise(() => ProfileManager.importTrustedUser(
    filePath,
    password,
    'local-peer',
    database,
    'Alice Local',
  ));

  assert.equal(failed.success, false);
  assert.equal(database.getUserByPeerId(identity.id), null);
  assert.deepEqual(database.getAllChats(), []);

  const retried = await withoutConsoleNoise(() => ProfileManager.importTrustedUser(
    filePath,
    password,
    'local-peer',
    database,
    'Alice Local',
  ));

  assert.equal(retried.success, true);
  assert.equal(retried.username, 'Alice Local');
  assert.equal(retried.peerId, identity.id);
  assert.equal(typeof retried.chatId, 'number');
  assert.equal(createAttempts, 2);
  assert.equal(database.getUserByPeerId(identity.id)?.username, 'Alice Local');

  const chat = database.getChatByPeerId(identity.id);
  assert.equal(chat?.trusted_out_of_band, true);
  assert.equal(chat?.offline_bucket_secret, sharedSecret);
});

test('trusted profile import rejects self-import even when local user row already exists', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kiyeovo-self-import-existing-user-test-'));
  const database = new ChatDatabase(join(dir, 'chat.sqlite'));
  t.after(async () => {
    database.close();
    await rm(dir, { recursive: true, force: true });
  });

  const identity = await EncryptedUserIdentity.createEncrypted();
  const filePath = join(dir, 'self.kiyeovo');
  const password = 'Profile-password-123!';
  const sharedSecret = 'self-default-inbox-key';

  await database.createUser({
    peer_id: identity.id,
    username: 'Local User',
    signing_public_key: Buffer.from(identity.signingPublicKey).toString('base64'),
    offline_public_key: Buffer.from(identity.offlinePublicKey, 'utf8').toString('base64'),
    signature: 'local-signature',
  });

  const exportResult = await withoutConsoleNoise(() => ProfileManager.exportProfileDesktop(
    identity,
    'Local User',
    identity.id,
    filePath,
    password,
    sharedSecret,
  ));
  assert.equal(exportResult.success, true);

  const imported = await importTrustedUserWithBlockedDatabaseWork(
    filePath,
    password,
    identity.id,
    database,
  );

  assert.deepEqual(imported, {
    success: false,
    error: 'Cannot import your own profile',
  });
  assert.equal(database.getUserByPeerId(identity.id)?.username, 'Local User');
  assert.deepEqual(database.getAllChats(), []);
});

test('trusted profile import rejects self-import without creating orphaned rows', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kiyeovo-self-import-no-user-test-'));
  const database = new ChatDatabase(join(dir, 'chat.sqlite'));
  t.after(async () => {
    database.close();
    await rm(dir, { recursive: true, force: true });
  });

  const identity = await EncryptedUserIdentity.createEncrypted();
  const filePath = join(dir, 'self.kiyeovo');
  const password = 'Profile-password-123!';
  const sharedSecret = 'self-default-inbox-key';

  const exportResult = await withoutConsoleNoise(() => ProfileManager.exportProfileDesktop(
    identity,
    'Local User',
    identity.id,
    filePath,
    password,
    sharedSecret,
  ));
  assert.equal(exportResult.success, true);

  const imported = await importTrustedUserWithBlockedDatabaseWork(
    filePath,
    password,
    identity.id,
    database,
  );

  assert.deepEqual(imported, {
    success: false,
    error: 'Cannot import your own profile',
  });
  assert.equal(database.getUserByPeerId(identity.id), null);
  assert.deepEqual(database.getAllChats(), []);
});
