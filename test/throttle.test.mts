import { test } from 'node:test';
import assert from 'node:assert/strict';
import { throttlePause } from '../src/throttle.js';

test('throttlePause maps load % to a duty-cycle idle time', () => {
  // 100% (or out of range / non-finite) → no pause.
  assert.equal(throttlePause(1000, 100), 0);
  assert.equal(throttlePause(1000, 150), 0);
  assert.equal(throttlePause(1000, 0), 0);
  assert.equal(throttlePause(1000, NaN), 0);
  // No work → no pause.
  assert.equal(throttlePause(0, 50), 0);
  // 50% → idle ≈ work time (≈half duty cycle).
  assert.equal(throttlePause(1000, 50), 1000);
  // 25% → idle ≈ 3× work time (≈quarter duty cycle).
  assert.equal(throttlePause(1000, 25), 3000);
  // Lower load → longer pause (monotonic).
  assert.ok(throttlePause(1000, 20) > throttlePause(1000, 40));
  // Capped so one slow unit can't stall the loop for minutes.
  assert.equal(throttlePause(10_000, 5, 30_000), 30_000);
});
