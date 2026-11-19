import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordWindow, planCodebuiltScript } from '../episode/codebuilt/planner.js';

// L1 (2026-11-15): raw aiden drafts at 30 s ran about 4 s long, so that one voice/duration is planned shorter.
test('aiden at 30 s plans 74 target / 78 max words; other voices and durations are unchanged', () => {
  const a = wordWindow(30, 'aiden');
  assert.deepEqual(a, { target: 74, min: 71, max: 78 });
  assert.deepEqual(wordWindow(45, 'aiden'), { target: 119, min: 114, max: 127 });
  assert.deepEqual(wordWindow(30, 'ryan'), { target: 71, min: 68, max: 76 });
  assert.deepEqual(wordWindow(30, 'aiden', 2.4), { target: 66, min: 64, max: 70 }); // a pace measured on the job's own recording still wins
});

// codex · gpt-6.1-sol · 2026-11-19 14:30 +02:00: the author must retain the measured video-length guard.
test('authored narration refuses excess words before voice and keeps its own sourced script', async () => {
  const sentences = ['Can this boat cross?', 'Wind rises.', 'Waves break.', ...Array.from({ length: 3 }, () => `${Array(25).fill('water').join(' ')}.`)];
  const shots = sentences.map(narration => ({ narration, subject: 'boat', action: 'crosses water', feel: 'curious' }));
  const factTable = [{ claim: 'Waves break.', sources: ['https://oceanservice.noaa.gov/facts/wavesinocean.html'] }];
  const value = { script: sentences.join(' '), shots, brief: 'A boat crosses the bay in rising wind. Follow its journey from shore to shore.', factTable };
  const calls = [];
  const result = await planCodebuiltScript({ topic: 'boat', duration: 30, route: 'authored' }, {
    askFn: () => assert.fail('separate script writer'),
    askRoleFn: () => assert.fail('separate ending writer'),
    askAuthor: async (prompt, images, options) => {
      calls.push(options.model);
      assert.match(prompt, /factTable/);
      return { text: JSON.stringify(calls.length === 1 ? { ...value, script: `${value.script} ${Array(40).fill('extra').join(' ')}` } : value), usage: { input_tokens: 10, output_tokens: 20 } };
    },
  });
  assert.deepEqual(calls, ['sonnet', 'opus']);
  assert.equal(result.script, value.script);
  assert.deepEqual(result.factTable, factTable);
  assert.match(result.brief, /unverified source leads/);
  assert.equal(result.calls[0].status, 'error');
  assert.equal(result.calls[1].step, 'author_script');
});
