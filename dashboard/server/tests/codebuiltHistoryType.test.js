// M4: the history video type is accepted, never falls back to factual, and loads its skill only for that type (claude-pro · claude-sonnet-5-5, 2026-11-14).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRunRequest } from '../episode/codebuilt/runCoordinator.js';
import { normalizeProductionChoices, scriptChoicesPrompt } from '../episode/codebuilt/productionChoices.js';
import { loadCodebuiltPathPack, loadCodebuiltGuides, guidesFor } from '../episode/codebuilt/planner.js';

test('explicit history and teardown types are kept, bogus types are refused, What if topics cannot be history', () => {
  assert.equal(checkRunRequest({ type: 'history' }).type, 'history');
  assert.equal(checkRunRequest({ type: 'History', topic: 'How did Rome fall?' }).type, 'history');
  assert.throws(() => checkRunRequest({ type: 'histroy' }), { code: 'bad_request' });
  assert.throws(() => checkRunRequest({ type: 'history', topic: 'What if Rome never fell?' }), { code: 'type_mismatch' });
  assert.equal(normalizeProductionChoices({ type: 'history' }).type, 'history');
  assert.match(scriptChoicesPrompt({ type: 'history' }), /history/);
  assert.equal(checkRunRequest({ type: 'teardown' }).type, 'teardown');
  assert.equal(normalizeProductionChoices({ type: 'teardown' }).type, 'teardown');
  assert.match(scriptChoicesPrompt({ type: 'teardown' }), /illustrative procedural model/i);
});

test('the history skill loads for the history type only', () => {
  const pack = loadCodebuiltPathPack();
  const only = (names) => loadCodebuiltGuides({ pack: { ...pack, rules: { ...pack.rules, skillsByStep: { script: names }, topicSkills: [] } }, step: 'script' });
  assert.match(only(pack.rules.typeSkills.history.script), /Code-built history/);
  assert.doesNotMatch(loadCodebuiltGuides({ pack, step: 'script', topic: 'ancient Rome' }), /Code-built history/);
  assert.deepEqual(pack.rules.typeSkills.history.direction, ['codebuilt-history']);
  const teardown = (step) => guidesFor(pack, step, 'unrelated topic', 'teardown');
  assert.match(teardown('script'), /codebuilt-teardown/i);
  assert.match(teardown('direction'), /codebuilt-teardown/i);
  assert.match(teardown('build'), /codebuilt-teardown/i);
  assert.doesNotMatch(guidesFor(pack, 'build', 'unrelated topic', 'history'), /codebuilt-teardown/i);
});
