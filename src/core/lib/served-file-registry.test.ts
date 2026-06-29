import assert from 'node:assert/strict';
import test from 'node:test';
import { ServedFileRegistry, type FinalizeServedFile } from './served-file-registry.js';

function finalizeData(overrides: Partial<FinalizeServedFile> = {}): FinalizeServedFile {
  return {
    fileId: 'file_1',
    filePath: '/tmp/report.pdf',
    size: 10,
    checksum: 'a'.repeat(64),
    authorizedPullers: new Map([['recipient_peer', 'recipient_key']]),
    isGroup: false,
    ...overrides,
  };
}

test('enforces the five-per-chat cap and never evicts', () => {
  const registry = new ServedFileRegistry(5);
  for (let i = 0; i < 5; i++) {
    assert.equal(registry.reserve(`offer_${i}`, 1), true);
  }
  assert.equal(registry.countForChat(1), 5);
  assert.equal(registry.reserve('offer_6', 1), false);
  // The sixth being rejected must not have disturbed the existing five.
  assert.equal(registry.countForChat(1), 5);
  assert.equal(registry.has('offer_0'), true);
  assert.equal(registry.has('offer_6'), false);
});

test('caps are independent per chat', () => {
  const registry = new ServedFileRegistry(5);
  for (let i = 0; i < 5; i++) {
    assert.equal(registry.reserve(`a_${i}`, 1), true);
  }
  assert.equal(registry.reserve('a_5', 1), false);
  // A different chat still has its own five slots.
  assert.equal(registry.reserve('b_0', 2), true);
  assert.equal(registry.countForChat(2), 1);
});

test('synchronous reservation lets exactly one of two racing sends take the last slot', () => {
  const registry = new ServedFileRegistry(5);
  for (let i = 0; i < 4; i++) {
    registry.reserve(`offer_${i}`, 1);
  }
  // Two sends reach the 5th slot in the same synchronous tick.
  const first = registry.reserve('race_a', 1);
  const second = registry.reserve('race_b', 1);
  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(registry.countForChat(1), 5);
  assert.equal(registry.size(), 5);
});

test('a reserved offer occupies a slot until finalized or released', () => {
  const registry = new ServedFileRegistry(5);
  registry.reserve('offer_1', 1);
  // Reserved-but-not-finalized: counts against the cap but is not yet pullable.
  assert.equal(registry.countForChat(1), 1);
  assert.equal(registry.getMeta('offer_1'), undefined);
  assert.equal(registry.getAuthorizedKey('offer_1', 'recipient_peer'), undefined);

  registry.finalize('offer_1', finalizeData());
  const meta = registry.getMeta('offer_1');
  assert.ok(meta);
  assert.equal(meta.chatId, 1);
  assert.equal(meta.checksum, 'a'.repeat(64));
  assert.equal(registry.getAuthorizedKey('offer_1', 'recipient_peer'), 'recipient_key');
  assert.equal(registry.getAuthorizedKey('offer_1', 'stranger'), undefined);
});

test('finalize throws when the offer was never reserved', () => {
  const registry = new ServedFileRegistry(5);
  assert.throws(() => registry.finalize('ghost', finalizeData()), /was not reserved/);
});

test('finalize is single-shot and cannot overwrite an existing authority', () => {
  const registry = new ServedFileRegistry(5);
  registry.reserve('offer_1', 1);
  registry.finalize('offer_1', finalizeData());
  assert.throws(() => registry.finalize('offer_1', finalizeData({
    authorizedPullers: new Map([['attacker', 'attacker_key']]),
  })), /already finalized/);
  assert.equal(registry.getAuthorizedKey('offer_1', 'attacker'), undefined);
  assert.equal(registry.getAuthorizedKey('offer_1', 'recipient_peer'), 'recipient_key');
});

test('the authorization snapshot is immune to later mutation of the caller map', () => {
  const registry = new ServedFileRegistry(5);
  const callerMap = new Map([['recipient_peer', 'recipient_key']]);
  registry.reserve('offer_1', 1);
  registry.finalize('offer_1', finalizeData({ authorizedPullers: callerMap }));
  // Caller mutates its own map after finalize — the registry snapshot must not change.
  callerMap.set('smuggled_peer', 'smuggled_key');
  callerMap.delete('recipient_peer');
  assert.equal(registry.getAuthorizedKey('offer_1', 'smuggled_peer'), undefined);
  assert.equal(registry.getAuthorizedKey('offer_1', 'recipient_peer'), 'recipient_key');
});

test('release frees the slot for both rolled-back and finalized entries', () => {
  const registry = new ServedFileRegistry(5);
  // Rollback of a bare reservation.
  registry.reserve('rolled_back', 1);
  assert.equal(registry.release('rolled_back'), true);
  assert.equal(registry.countForChat(1), 0);

  // Release of a finalized entry (withdrawal / terminal NACK / consumption).
  registry.reserve('finalized', 1);
  registry.finalize('finalized', finalizeData());
  assert.equal(registry.release('finalized'), true);
  assert.equal(registry.has('finalized'), false);
  // Releasing again is a no-op.
  assert.equal(registry.release('finalized'), false);

  // Freed slots are reusable.
  for (let i = 0; i < 5; i++) {
    assert.equal(registry.reserve(`fresh_${i}`, 1), true);
  }
});

test('group entry releases only after every authorized puller is gone', () => {
  const registry = new ServedFileRegistry(5);
  registry.reserve('group_offer', 7);
  registry.finalize('group_offer', finalizeData({
    isGroup: true,
    authorizedPullers: new Map([['alice', 'alice_key'], ['bob', 'bob_key']]),
  }));

  // First member pulls/declines: slot stays for the rest.
  let result = registry.removePuller('group_offer', 'alice');
  assert.deepEqual(result, { removed: true, emptied: false });
  assert.equal(registry.has('group_offer'), true);

  // Last member: entry is dropped.
  result = registry.removePuller('group_offer', 'bob');
  assert.deepEqual(result, { removed: true, emptied: true });
  assert.equal(registry.has('group_offer'), false);

  // Unknown offer / puller is a no-op.
  assert.deepEqual(registry.removePuller('group_offer', 'bob'), { removed: false, emptied: false });
});

test('clear drops every entry (process-exit / shutdown semantics)', () => {
  const registry = new ServedFileRegistry(5);
  registry.reserve('a', 1);
  registry.reserve('b', 2);
  registry.clear();
  assert.equal(registry.size(), 0);
  assert.equal(registry.has('a'), false);
});
