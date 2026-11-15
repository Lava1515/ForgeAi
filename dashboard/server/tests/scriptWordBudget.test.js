import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordWindow } from '../episode/codebuilt/planner.js';

// L1 (2026-11-15): raw aiden drafts at 30 s ran about 4 s long, so that one voice/duration is planned shorter.
test('aiden at 30 s plans 74 target / 78 max words; other voices and durations are unchanged', () => {
  const a = wordWindow(30, 'aiden');
  assert.equal(a.target, 74);
  assert.equal(a.max, 78);
  assert.deepEqual(wordWindow(45, 'aiden'), { target: 119, min: 114, max: 127 });
  assert.deepEqual(wordWindow(30, 'ryan'), { target: 71, min: 68, max: 76 });
  assert.deepEqual(wordWindow(30, 'aiden', 2.4), { target: 66, min: 64, max: 70 }); // a pace measured on the job's own recording still wins
});
