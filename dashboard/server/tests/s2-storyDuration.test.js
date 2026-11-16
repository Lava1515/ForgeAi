// codex · gpt-6.1-sol · 2026-11-16 08:59 +02:00: duration damage and lost middle-beat regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planCodebuiltScript, wordWindow, scriptShotRange, AUTO_SCRIPT_DURATIONS } from '../episode/codebuilt/planner.js';
import { FEELS, planBeatDeliveries } from '../episode/codebuilt/voice.js';

function reply(duration, { count = wordWindow(duration).target, returnedDuration = duration, shots = scriptShotRange(duration).target } = {}) {
  const tokens = Array.from({ length: count }, (_, i) => `place${i}`);
  const beats = Array.from({ length: shots }, (_, i) => ({
    narration: tokens.slice(Math.floor(i * count / shots), Math.floor((i + 1) * count / shots)).join(' '),
    subject: 'you beside a familiar country', action: 'cross a blocked route', feel: FEELS[i % FEELS.length],
  }));
  beats.at(-1).feel = 'curious';
  return { duration: returnedDuration, script: tokens.join(' '), shots: beats, brief: 'Follow your journey across familiar countries. Each stop changes the route and raises the stakes.' };
}
const deps = (value, inspect = () => {}) => ({ askFn: async (prompt) => { inspect(prompt); return JSON.stringify(value); }, askRoleFn: async () => ({ ok: true }) });

test('Auto selects each supported length with matching prompt budgets, returned brief and spoken beats', async () => {
  for (const duration of AUTO_SCRIPT_DURATIONS) {
    const value = reply(duration);
    const result = await planCodebuiltScript({ topic: 'your journey', duration: 30, autoDuration: true }, deps(value, (prompt) => {
      assert.match(prompt, /"duration": number/);
      for (const d of AUTO_SCRIPT_DURATIONS) {
        const w = wordWindow(d); const s = scriptShotRange(d);
        assert.ok(prompt.includes(`${d} s: target ${w.target} words (at least ${w.min} and at most ${w.max}); about ${s.target} shots (at least ${s.min}, at most ${s.max})`));
      }
    }));
    assert.equal(result.duration, duration);
    assert.ok(result.brief.includes(`Target length: ${duration} s`));
    assert.deepEqual(planBeatDeliveries({ script: result.script, beats: result.shots }).deliveries, value.shots.map((b) => b.feel));
  }
});

test('manual durations preserve their budgets and ignore a reply trying to change duration', async () => {
  for (const duration of [30, 45, 60, 90]) {
    const result = await planCodebuiltScript({ topic: 'a route', duration }, deps(reply(duration, { returnedDuration: 60 }), (prompt) => {
      assert.ok(prompt.includes(`Fixed duration ${duration} s`));
      assert.ok(!prompt.includes('"duration": number'));
    }));
    assert.equal(result.duration, duration);
  }
});

test('Auto refuses missing, nonnumeric and unsupported lengths instead of defaulting to 30', async () => {
  for (const returnedDuration of [undefined, '45', 29, 61, 90, 40, null]) {
    const value = reply(30); value.duration = returnedDuration;
    await assert.rejects(planCodebuiltScript({ topic: 'route', autoDuration: true }, deps(value)), /Auto duration/);
  }
});

test('selected length enforces wordWindow and shotRange at both boundaries', async () => {
  for (const duration of AUTO_SCRIPT_DURATIONS) {
    const w = wordWindow(duration); const s = scriptShotRange(duration);
    for (const count of [w.min, w.max]) await planCodebuiltScript({ topic: 'route', autoDuration: true }, deps(reply(duration, { count })));
    for (const count of [w.min - 1, w.max + 1]) await assert.rejects(planCodebuiltScript({ topic: 'route', autoDuration: true }, deps(reply(duration, { count }))), /words/);
    for (const shots of [s.min, s.max]) await planCodebuiltScript({ topic: 'route', autoDuration: true }, deps(reply(duration, { shots })));
    for (const shots of [s.min - 1, s.max + 1]) await assert.rejects(planCodebuiltScript({ topic: 'route', autoDuration: true }, deps(reply(duration, { shots }))), /shots has/);
  }
});

test('dropped middle narration is rejected rather than silently disabling every beat delivery', async () => {
  const value = reply(45); value.shots[2].narration = 'Missing the original middle words.';
  await assert.rejects(planCodebuiltScript({ topic: 'route', duration: 45 }, deps(value)), /cover the entire script/);
});

test('all expanded feels survive planner and voice validation, including a viewer-question ending', async () => {
  for (const feel of FEELS) {
    const value = reply(60); value.shots[2].feel = feel;
    const result = await planCodebuiltScript({ topic: 'route', duration: 60 }, deps(value));
    assert.equal(planBeatDeliveries({ script: result.script, beats: result.shots }).deliveries[2], feel);
  }
});
