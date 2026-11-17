import test from 'node:test';
import assert from 'node:assert/strict';
import { planCodebuiltScript, wordWindow, scriptShotRange } from '../episode/codebuilt/planner.js';

const deps = (value) => ({ askFn: async () => JSON.stringify(value), askRoleFn: async () => ({ ok: true }) });

test('script planner rejects scripts without the required short lines and open question', async () => {
  const count = wordWindow(30).target;
  const script = Array.from({ length: count }, (_, i) => `word${i}`).join(' ');
  const shotCount = scriptShotRange(30).target;
  const tokens = script.split(' ');
  const shots = Array.from({ length: shotCount }, (_, i) => ({
    narration: tokens.slice(Math.floor(i * count / shotCount), Math.floor((i + 1) * count / shotCount)).join(' '),
    subject: 'the route', action: 'moves forward', feel: i ? 'amazed' : 'curious',
  }));
  await assert.rejects(
    planCodebuiltScript({ topic: 'a route', duration: 30 }, deps({ script, shots, brief: 'A route crosses the country. The traveler needs to reach the far shore.' })),
    /three sentences of five words or fewer|open question/,
  );
});
