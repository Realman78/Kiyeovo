import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatDatabase } from './database.js';

// Regression coverage for the trusted-profile import invariant: chat-creation
// asserts the creator (`created_by`, always our own peer ID for self-owned
// chats) has a row in `users`. An UNREGISTERED identity used to have no
// self-row at all (only `persistRegisteredUser` inserted one, after username
// registration), so a first-ever trusted import — and, by the same root cause,
// accepting an inbound contact request — failed with a self-referential
// "User with peer_id '<own id>' not found in database" error.
//
// The fix seeds a minimal self-row at identity-ready time
// (UsernameRegistry.ensureSelfUserRow). These tests pin the DB-level mechanism
// that fix relies on: (1) the guard still fires without a self-row,
// (2) a minimal self-row makes the import succeed, and (3) a later
// registration (createUser upsert on the same self peer_id) upgrades the
// username in place without disturbing the imported chat.

const SELF_PEER_ID = '12D3KooSelfImporterPeerIdAAAAAAAAAAAAAAAAAAAA';
const CONTACT_PEER_ID = '12D3KooRemoteExporterPeerIdBBBBBBBBBBBBBBBBBB';

function importTrustedContact(database: ChatDatabase, customName = 'alice-from-file') {
    // Mirrors ProfileManager.importTrustedUser's createTrustedDirectContact call.
    return database.createTrustedDirectContact({
        peer_id: CONTACT_PEER_ID,
        username: customName,
        signing_public_key: 'contact_signing_key',
        offline_public_key: 'contact_offline_key',
        signature: 'contact_signature',
    }, {
        type: 'direct',
        name: CONTACT_PEER_ID,
        created_by: SELF_PEER_ID,
        participants: [SELF_PEER_ID, CONTACT_PEER_ID],
        offline_bucket_secret: 'default_inbox_key',
        notifications_bucket_key: 'notifications_key',
        offline_last_read_timestamp: 0,
        offline_last_ack_sent: 0,
        trusted_out_of_band: true,
        muted: false,
        key_version: 0,
        status: 'active',
        created_at: new Date(1_000),
    });
}

function seedSelfRow(database: ChatDatabase, username = `user_${SELF_PEER_ID.slice(-8)}`) {
    // Mirrors UsernameRegistry.ensureSelfUserRow's minimal placeholder self-row.
    return database.createUser({
        peer_id: SELF_PEER_ID,
        username,
        signing_public_key: 'self_signing_key',
        offline_public_key: 'self_offline_key',
        signature: '',
    });
}

test('trusted import fails without a self-row (documents the assertUserExists guard)', async (t) => {
    const database = new ChatDatabase(':memory:');
    t.after(() => database.close());

    await assert.rejects(
        () => importTrustedContact(database),
        /not found in database/,
        'createTrustedDirectContact must reject when the creator has no users row',
    );

    // The failed transaction must leave no partial state behind.
    assert.equal(database.getAllChats().length, 0);
    assert.equal(database.getUserByPeerId(CONTACT_PEER_ID), null);
});

test('trusted import succeeds once a minimal self-row exists', async (t) => {
    const database = new ChatDatabase(':memory:');
    t.after(() => database.close());

    await seedSelfRow(database);
    const chatId = await importTrustedContact(database);

    assert.ok(chatId > 0);
    const chat = database.getChatByPeerId(CONTACT_PEER_ID);
    assert.ok(chat, 'imported chat should exist');
    assert.equal(chat?.trusted_out_of_band, true);

    const contact = database.getUserByPeerId(CONTACT_PEER_ID);
    assert.equal(contact?.username, 'alice-from-file');
});

test('registering after an unregistered import upgrades the self username in place and preserves the chat', async (t) => {
    const database = new ChatDatabase(':memory:');
    t.after(() => database.close());

    // Unregistered: placeholder self-row, then a trusted import.
    await seedSelfRow(database);
    const chatId = await importTrustedContact(database);

    // Later registration (persistRegisteredUser -> createUser upsert) on the
    // same self peer_id must update the username in place, not create a
    // duplicate row or fail on the UNIQUE(network_mode, peer_id) constraint.
    await seedSelfRow(database, 'registered-alice');

    const self = database.getUserByPeerId(SELF_PEER_ID);
    assert.equal(self?.username, 'registered-alice');

    // Exactly one self-row (upsert, not insert).
    const selves = database.getAllUsers().filter((u) => u.peer_id === SELF_PEER_ID);
    assert.equal(selves.length, 1);

    // The imported chat and contact survive registration untouched.
    const chat = database.getChatByPeerId(CONTACT_PEER_ID);
    assert.equal(chat?.id, chatId);
    assert.equal(chat?.trusted_out_of_band, true);
    assert.equal(database.getUserByPeerId(CONTACT_PEER_ID)?.username, 'alice-from-file');
});
