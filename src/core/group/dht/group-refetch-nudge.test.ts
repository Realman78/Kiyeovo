import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatDatabase } from '../../db/database.js';
import { GroupMessageType } from '../types.js';
import { nudgeGroupRefetchIfKnownGroup, type GroupRefetchNudgeOptions } from './group-refetch-nudge.js';

function makeDeps(known = true) {
  const calls: Array<{ peerId: string; groupId: string; options?: GroupRefetchNudgeOptions }> = [];
  const deps = {
    database: {
      getChatByGroupId: () => (known ? { id: 1 } : undefined),
    } as unknown as ChatDatabase,
    nudgeGroupRefetch: (peerId: string, groupId: string, options?: GroupRefetchNudgeOptions) => {
      calls.push({ peerId, groupId, options });
    },
  };
  return { deps, calls };
}

const FORCE_DIAL_TYPES = [
  GroupMessageType.GROUP_INVITE,
  GroupMessageType.GROUP_KICK,
  GroupMessageType.GROUP_INVITE_RESPONSE,
  // Epoch announcements force-dial too: with no periodic offline check in the
  // build, an online-but-disconnected member has no other prompt path, and an
  // epoch-lagged member's own sends are silently lost to healed peers past
  // the rotation grace window.
  GroupMessageType.GROUP_STATE_UPDATE,
] as const;

for (const type of FORCE_DIAL_TYPES) {
  test(`${type} nudges with allowDialWithoutConnection`, () => {
    const { deps, calls } = makeDeps();
    nudgeGroupRefetchIfKnownGroup(deps, 'peer-1', { groupId: 'g1', type });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.options, { allowDialWithoutConnection: true });
  });
}

test('other control types keep the piggyback-only nudge (no options)', () => {
  const { deps, calls } = makeDeps();
  nudgeGroupRefetchIfKnownGroup(deps, 'peer-1', { groupId: 'g1', type: GroupMessageType.GROUP_WELCOME });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.options, undefined);
});

test('unknown group produces no nudge at all', () => {
  const { deps, calls } = makeDeps(false);
  nudgeGroupRefetchIfKnownGroup(deps, 'peer-1', { groupId: 'g1', type: GroupMessageType.GROUP_STATE_UPDATE });
  assert.equal(calls.length, 0);
});
