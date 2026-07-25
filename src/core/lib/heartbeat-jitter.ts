/**
 * Pure helper for the "jittered gossipsub heartbeat" metadata mitigation (see
 * GROUP_GOSSIPSUB_HEARTBEAT_MIN_INTERVAL_MS / _MAX_INTERVAL_MS in
 * constants.ts).
 *
 * A fixed heartbeat period is a per-member liveness metronome an observer
 * can fingerprint - even a single fixed random OFFSET applied once would
 * still be a metronome (just phase-shifted). Instead, every tick redraws a
 * fresh delay uniformly within [minMs, maxMs] for the NEXT tick, so no two
 * consecutive gaps are predictable from one another.
 */
export function computeJitteredHeartbeatDelayMs(
  minMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  if (!Number.isFinite(minMs) || minMs < 0) {
    throw new Error(`Invalid heartbeat jitter minMs: ${minMs}`);
  }
  if (!Number.isFinite(maxMs) || maxMs < minMs) {
    // Degenerate bounds: fall back to the fixed lower bound rather than
    // throwing, so a misconfiguration can't take heartbeats down entirely.
    return Math.round(minMs);
  }
  return Math.round(minMs + random() * (maxMs - minMs));
}
