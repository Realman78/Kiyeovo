import { log } from '../../shared/logger.js';
import type { NetworkMode } from '../types.js';
import type { DhtStatusCheckSource } from './network-health.js';

const DHT_RECONNECT_FAILURE_THRESHOLD = 3;
const DHT_RECONNECT_COOLDOWN_MS = 120_000;
const POST_RETRY_VERIFY_DELAY_FAST_MS = 3_000;
const POST_RETRY_VERIFY_DELAY_ANONYMOUS_MS = 7_000;

export function createReconnectController() {
  let consecutiveProbeFailures = 0;
  let reconnectInProgress = false;
  let bootstrapRetryInProgress = false;
  let lastReconnectAt = 0;
  let postRetryVerifyTimeout: ReturnType<typeof setTimeout> | null = null;

  const getPostRetryVerifyDelayMs = (mode: NetworkMode): number => (
    mode === 'anonymous' ? POST_RETRY_VERIFY_DELAY_ANONYMOUS_MS : POST_RETRY_VERIFY_DELAY_FAST_MS
  );

  const clearPostRetryVerifyTimeout = () => {
    if (postRetryVerifyTimeout === null) {
      return;
    }

    clearTimeout(postRetryVerifyTimeout);
    postRetryVerifyTimeout = null;
  };

  const schedulePostRetryVerify = (mode: NetworkMode, callback: () => void) => {
    clearPostRetryVerifyTimeout();

    const delayMs = getPostRetryVerifyDelayMs(mode);
    log(
      `[DHT-STATUS][CORE][VERIFY][SCHEDULE] source=post_retry_verify mode=${mode} delayMs=${delayMs}`,
    );

    postRetryVerifyTimeout = setTimeout(() => {
      postRetryVerifyTimeout = null;
      callback();
    }, delayMs);
  };

  const shouldSuppressNegativeStatusDuringBootstrapRetry = (source: DhtStatusCheckSource): boolean => (
    bootstrapRetryInProgress && (source === 'timer_5s' || source === 'timer_30s')
  );

  const recordHealthStatus = (status: boolean | null): boolean => {
    if (status === true) {
      consecutiveProbeFailures = 0;
      return false;
    }

    if (status === null) {
      return false;
    }

    consecutiveProbeFailures += 1;
    return true;
  };

  const resetProbeFailures = () => {
    consecutiveProbeFailures = 0;
  };

  const tryBeginReconnect = (): boolean => {
    const gateMessage = `[DHT-STATUS][CORE][RECONNECT][GATE] probeFailures=${consecutiveProbeFailures}/${DHT_RECONNECT_FAILURE_THRESHOLD}`;
    if (consecutiveProbeFailures < DHT_RECONNECT_FAILURE_THRESHOLD) {
      log(gateMessage);
      return false;
    }

    console.warn(gateMessage);

    const now = Date.now();
    const sinceLastReconnect = now - lastReconnectAt;
    if (lastReconnectAt > 0 && sinceLastReconnect < DHT_RECONNECT_COOLDOWN_MS) {
      log(
        `[DHT-STATUS][CORE][RECONNECT][SKIP] reason=cooldown probeFailures=${consecutiveProbeFailures} ` +
        `waitMs=${DHT_RECONNECT_COOLDOWN_MS - sinceLastReconnect}`,
      );
      return false;
    }

    if (reconnectInProgress) {
      log('[Core] Reconnect already in progress, skipping duplicate reconnect attempt');
      return false;
    }

    lastReconnectAt = now;
    reconnectInProgress = true;
    return true;
  };

  return {
    beginBootstrapRetry() {
      clearPostRetryVerifyTimeout();
      bootstrapRetryInProgress = true;
    },
    clearPostRetryVerifyTimeout,
    endBootstrapRetry() {
      bootstrapRetryInProgress = false;
    },
    finishReconnect() {
      reconnectInProgress = false;
    },
    isReconnectInProgress() {
      return reconnectInProgress;
    },
    recordHealthStatus,
    resetProbeFailures,
    schedulePostRetryVerify,
    shouldSuppressNegativeStatusDuringBootstrapRetry,
    tryBeginReconnect,
  };
}
