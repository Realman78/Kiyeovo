import assert from 'node:assert/strict';
import test from 'node:test';
import { computeJitteredHeartbeatDelayMs } from './heartbeat-jitter.js';

test('computeJitteredHeartbeatDelayMs stays within [minMs, maxMs] across the random range', () => {
  const minMs = 60_000;
  const maxMs = 150_000;
  for (const sample of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999]) {
    const delay = computeJitteredHeartbeatDelayMs(minMs, maxMs, () => sample);
    assert.ok(delay >= minMs, `delay ${delay} >= minMs for sample ${sample}`);
    assert.ok(delay <= maxMs, `delay ${delay} <= maxMs for sample ${sample}`);
  }
});

test('computeJitteredHeartbeatDelayMs hits the exact bounds at random()=0 and random()=1', () => {
  assert.equal(computeJitteredHeartbeatDelayMs(60_000, 150_000, () => 0), 60_000);
  assert.equal(computeJitteredHeartbeatDelayMs(60_000, 150_000, () => 1), 150_000);
});

test('computeJitteredHeartbeatDelayMs redraws independently per call (not a fixed offset)', () => {
  const samples = [0, 0.2, 0.4, 0.6, 0.8];
  let i = 0;
  const random = () => samples[i++]!;
  const delays = samples.map(() => computeJitteredHeartbeatDelayMs(60_000, 150_000, random));
  const distinct = new Set(delays);
  assert.equal(distinct.size, samples.length, 'each tick should get its own delay, not one fixed metronome offset');
});

test('computeJitteredHeartbeatDelayMs falls back to minMs on degenerate bounds (maxMs < minMs)', () => {
  assert.equal(computeJitteredHeartbeatDelayMs(90_000, 10_000, () => 0.5), 90_000);
});

test('computeJitteredHeartbeatDelayMs throws on an invalid minMs', () => {
  assert.throws(() => computeJitteredHeartbeatDelayMs(-1, 100, () => 0));
});

test('computeJitteredHeartbeatDelayMs default random() (Math.random) stays in bounds', () => {
  for (let i = 0; i < 50; i++) {
    const delay = computeJitteredHeartbeatDelayMs(60_000, 150_000);
    assert.ok(delay >= 60_000 && delay <= 150_000);
  }
});
