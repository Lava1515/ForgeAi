import test from 'node:test';
import assert from 'node:assert/strict';
import { startAutoReleaseLoop } from '../../../scripts/supervisor/start_codebuilt_dashboard.mjs';

test('the loop never overlaps ticks, survives a throwing tick, and stops', async () => {
  const timers = [];
  let active = 0; let maxActive = 0; let runs = 0;
  const stop = startAutoReleaseLoop({
    intervalMs: 5, log() {},
    setT: (fn) => { timers.push(fn); return {}; }, clearT() {},
    run: async () => { active++; maxActive = Math.max(maxActive, active); runs++; await Promise.resolve(); active--; if (runs === 1) throw new Error('boom'); },
  });
  assert.equal(timers.length, 1);
  await timers.shift()();
  assert.equal(timers.length, 1); // re-armed only after the tick finished, even though it threw
  await timers.shift()();
  assert.equal(maxActive, 1);
  stop();
  await timers.shift()?.();
  assert.equal(timers.length, 0);
});
