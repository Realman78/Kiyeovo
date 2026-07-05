import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebContents } from 'electron';
import { applyWebRTCIPHandlingPolicy } from './session-security.js';

type WebRTCPolicyWebContents = Pick<WebContents, 'setWebRTCIPHandlingPolicy'>;
type WebRTCIPHandlingPolicy = Parameters<WebRTCPolicyWebContents['setWebRTCIPHandlingPolicy']>[0];

test('applyWebRTCIPHandlingPolicy restricts WebRTC candidate gathering in anonymous mode', () => {
  const policies: WebRTCIPHandlingPolicy[] = [];
  const mockWebContents = {
    setWebRTCIPHandlingPolicy(policy) {
      policies.push(policy);
    },
  } satisfies WebRTCPolicyWebContents;

  applyWebRTCIPHandlingPolicy(mockWebContents, 'anonymous');

  assert.deepEqual(policies, ['disable_non_proxied_udp']);
});

test('applyWebRTCIPHandlingPolicy leaves fast mode at Electron default', () => {
  let wasCalled = false;
  const mockWebContents = {
    setWebRTCIPHandlingPolicy() {
      wasCalled = true;
    },
  } satisfies WebRTCPolicyWebContents;

  applyWebRTCIPHandlingPolicy(mockWebContents, 'fast');

  assert.equal(wasCalled, false);
});
