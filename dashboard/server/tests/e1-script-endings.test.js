import test from 'node:test';
import assert from 'node:assert/strict';
import { planCodebuiltScript } from '../episode/codebuilt/planner.js';

const script = (ending) => {
  const sentences = [
    'Could a paper boat cross an ocean?',
    'You fold one sheet beside a quiet harbor.',
    'The first wave lifts its pointed bow.',
    'Wind carries it beyond the breakwater.',
    'Salt water softens every folded edge.',
    'A gull follows the bright little sail.',
    'The boat drifts past the last fishing lights.',
    'Morning finds it near a distant island.',
    ending,
  ];
  while (sentences.join(' ').split(/\s+/).length < 74) sentences.splice(1, 0, 'Small ripples rock the paper boat beneath the open sky.');
  return sentences.join(' ');
};
const shotsFor = (text) => text.split(/(?<=[.!?])\s+/).map((narration) => ({ narration, subject: 'paper boat', action: 'drifts across the harbor', feel: 'curious' }));
const reply = (text) => { const shots = shotsFor(text); shots[0].feel = 'intrigued'; shots.at(-1).feel = 'amazed'; return JSON.stringify({ script: text, shots, brief: 'A paper boat travels from a harbor toward an island. The visuals follow its journey.' }); };

test('a flat banned final line triggers one focused ending check and rewrite', async () => {
  const calls = [];
  const original = script('Its paper hull still stays soft.');
  const replacement = 'The gull carries the tiny sail beyond the island.';
  const result = await planCodebuiltScript({ topic: 'paper boats', duration: 30 }, {
    askFn: async () => reply(original),
    askRoleFn: async (_role, prompt, options) => {
      calls.push({ prompt, options });
      if (calls.length === 1) return { ok: false, reasons: ['flat ending'] };
      return { ending: replacement };
    },
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0].prompt, /hook/i);
  assert.equal(result.script.endsWith(replacement), true);
  assert.equal(result.shots.map((shot) => shot.narration).join(' ').split(/\s+/).length, result.script.split(/\s+/).length);
  assert.equal(result.shots.at(-1).feel, 'amazed');
});
