import assert from 'node:assert/strict';
import test from 'node:test';
import {
  shouldTriggerJoinCompletionCatchup,
  type GroupMembershipSnapshot,
} from './group-offline-triggers.js';

const snap = (groupStatus: string | null, keyVersion: number): GroupMembershipSnapshot => ({
  groupStatus,
  keyVersion,
});

test('join-completion trigger: fresh join (invited_pending@0 -> active@1) triggers', () => {
  assert.equal(
    shouldTriggerJoinCompletionCatchup(snap('invited_pending', 0), snap('active', 1)),
    true,
  );
});

test('join-completion trigger: awaiting_activation@0 -> active@3 triggers', () => {
  assert.equal(
    shouldTriggerJoinCompletionCatchup(snap('awaiting_activation', 0), snap('active', 3)),
    true,
  );
});

test('join-completion trigger: duplicate welcome (already active, same epoch) does NOT trigger', () => {
  assert.equal(
    shouldTriggerJoinCompletionCatchup(snap('active', 4), snap('active', 4)),
    false,
  );
});

test('join-completion trigger: already-active member whose epoch advanced still triggers', () => {
  // A welcome that also carries a newer epoch than the one we held.
  assert.equal(
    shouldTriggerJoinCompletionCatchup(snap('active', 2), snap('active', 5)),
    true,
  );
});

test('join-completion trigger: no-op when the welcome did not activate (still pending)', () => {
  assert.equal(
    shouldTriggerJoinCompletionCatchup(snap('invited_pending', 0), snap('invited_pending', 0)),
    false,
  );
});

test('join-completion trigger: active but epoch 0 is never triggered (no real epoch key)', () => {
  assert.equal(
    shouldTriggerJoinCompletionCatchup(snap('invited_pending', 0), snap('active', 0)),
    false,
  );
});

test('join-completion trigger: transition to a terminal status does not trigger', () => {
  for (const terminal of ['removed', 'left', 'disbanded', 'invite_expired']) {
    assert.equal(
      shouldTriggerJoinCompletionCatchup(snap('active', 2), snap(terminal, 3)),
      false,
      `terminal status ${terminal} must not trigger a join-completion catch-up`,
    );
  }
});

test('join-completion trigger: null before-status (unknown chat) still triggers on active apply', () => {
  assert.equal(
    shouldTriggerJoinCompletionCatchup(snap(null, 0), snap('active', 1)),
    true,
  );
});
