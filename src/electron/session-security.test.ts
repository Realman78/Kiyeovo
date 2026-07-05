import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session } from 'electron';
import { applyWebRTCIPHandlingPolicy } from './session-security.js';

type WebRTCPolicySession = Pick<Session, 'setWebRTCIPHandlingPolicy'>;
type WebRTCIPHandlingPolicy = Parameters<WebRTCPolicySession['setWebRTCIPHandlingPolicy']>[0];

test('applyWebRTCIPHandlingPolicy restricts WebRTC candidate gathering in anonymous mode', () => {
  const policies: WebRTCIPHandlingPolicy[] = [];
  const mockSession = {
    setWebRTCIPHandlingPolicy(policy) {
      policies.push(policy);
    },
  } satisfies WebRTCPolicySession;

  applyWebRTCIPHandlingPolicy(mockSession, 'anonymous');

  assert.deepEqual(policies, ['disable_non_proxied_udp']);
});

test('applyWebRTCIPHandlingPolicy leaves fast mode at Electron default', () => {
  let wasCalled = false;
  const mockSession = {
    setWebRTCIPHandlingPolicy() {
      wasCalled = true;
    },
  } satisfies WebRTCPolicySession;

  applyWebRTCIPHandlingPolicy(mockSession, 'fast');

  assert.equal(wasCalled, false);
});
