import test from 'node:test';
import assert from 'node:assert/strict';
import { planCodebuiltScript } from '../episode/codebuilt/planner.js';
import { resolveStepTier, lightChain, AGY_FORBIDDEN_STEPS } from '../routes/stepTiers.js';

test('script ending resolves to Haiku and cannot enter the agy light chain', () => {
  const pick = resolveStepTier('script_ending');
  assert.equal(pick.tier, 'haiku');
  assert.throws(() => lightChain(pick), /Not a light step/);
  assert.equal(AGY_FORBIDDEN_STEPS.has('script_ending'), true);
});

const script = (ending) => {
  const sentences = [
    'Paper sinks, yet this boat keeps sailing.',
    'Can a paper boat reach the far shore?',
    'Child wants it home.',
    'Then the wind shifts.',
    'Rain darkens the sail as waves carry the hull past the harbor wall.',
    'Gulls circle rough water.',
    'Harbor lights vanish behind the boat.',
    'At dawn, a pale island appears through the mist.',
    'The child watches as a gull follows the sail out to sea.',
    'Not yet.',
    'Now the boat reaches land.',
    ending,
  ];
  return sentences.join(' ');
};
const shotsFor = (text) => text.split(/(?<=[.!?])\s+/).map((narration) => ({ narration, subject: 'paper boat', action: 'drifts across the harbor', feel: 'curious' }));
const reply = (text) => { const shots = shotsFor(text); shots[0].feel = 'intrigued'; shots.at(-1).feel = 'amazed'; return JSON.stringify({ script: text, shots, brief: 'A paper boat travels from a harbor toward an island. The visuals follow its journey.' }); };

test('a flat banned final line triggers one focused ending check and rewrite', async () => {
  const calls = [];
  const original = script('Its paper hull still stays soft.');
  const replacement = 'The gull carries the paper boat safely ashore.';
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

test('checker failure keeps original script and records degraded evidence', async () => {
  const original = script('Its paper hull still stays soft.');
  const result = await planCodebuiltScript({ topic: 'paper boats', duration: 30 }, {
    askFn: async () => reply(original),
    askRoleFn: async () => { throw new Error('unavailable'); },
  });
  assert.equal(result.script, original);
  assert.equal(result.endingCheck.status, 'degraded');
  assert.match(result.endingCheck.reason, /checker failed/);
});

test('passing ending checks make no rewrite call', async () => {
  const original = script('The gull carries that paper boat safely ashore.');
  let count = 0;
  const result = await planCodebuiltScript({ topic: 'paper boats', duration: 30 }, {
    askFn: async () => reply(original),
    askRoleFn: async () => { count += 1; return { ok: true }; },
  });
  assert.equal(count, 1);
  assert.equal(result.script, original);
  assert.equal(result.endingCheck.status, 'approved');
});

test('invalid checker verdicts retain the original without an unjudged rewrite', async () => {
  const original = script('Its paper hull still stays soft.');
  for (const verdict of [null, 'ok', {}, { ok: 'yes' }, { ok: false }]) {
    let count = 0;
    const result = await planCodebuiltScript({ topic: 'paper boats', duration: 30 }, {
      askFn: async () => reply(original),
      askRoleFn: async () => { count += 1; return verdict; },
    });
    assert.equal(result.script, original);
    assert.equal(result.endingCheck.status, 'degraded');
    assert.equal(count, 1);
  }
});

test('ending rewrites preserve literal dollars, decimals and abbreviations', async () => {
  const original = script('Its paper hull still stays soft.');
  for (const ending of ['The gull carries $& across 3.5 meters of ocean.', 'The gull carries the tiny sail into the U.S. Navy.']) {
    let count = 0;
    const result = await planCodebuiltScript({ topic: 'paper boats', duration: 30 }, {
      askFn: async () => reply(original),
      askRoleFn: async () => ++count === 1 ? { ok: false, reasons: ['flat'] } : { ending },
    });
    assert.equal(result.endingCheck.status, 'rewritten');
    assert.equal(result.script.endsWith(ending), true);
    assert.equal(result.shots.at(-1).narration, ending);
  }
});

test('invalid rewrite text is retained as degraded evidence', async () => {
  const original = script('Its paper hull still stays soft.');
  for (const ending of [null, 42, 'First sentence. Second sentence. Third sentence.', 'No final punctuation']) {
    let count = 0;
    const result = await planCodebuiltScript({ topic: 'paper boats', duration: 30 }, {
      askFn: async () => reply(original),
      askRoleFn: async () => ++count === 1 ? { ok: false, reasons: ['flat'] } : { ending },
    });
    assert.equal(result.script, original);
    assert.equal(result.endingCheck.status, 'degraded');
  }
});
