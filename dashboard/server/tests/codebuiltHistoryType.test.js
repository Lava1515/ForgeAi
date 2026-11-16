// M4: the history video type is accepted, never falls back to factual, and loads its skill only for that type (claude-pro · claude-sonnet-5-5, 2026-11-14).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRunRequest, createCodebuiltRunCoordinator } from '../episode/codebuilt/runCoordinator.js';
import { normalizeProductionChoices, scriptChoicesPrompt } from '../episode/codebuilt/productionChoices.js';
import { loadCodebuiltPathPack, loadCodebuiltGuides, guidesFor } from '../episode/codebuilt/planner.js';

test('a code-built run accepts 15 videos and rejects 16', () => {
  assert.equal(checkRunRequest({ count: 15 }).count, 15);
  assert.throws(() => checkRunRequest({ count: 16 }), { code: 'bad_request' });
});

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

test('teardown guidance is loaded once and invalid guidance is surfaced', () => {
  const pack = loadCodebuiltPathPack();
  const text = guidesFor(pack, 'build', 'stealth jet', 'teardown');
  assert.equal(text.split('### codebuilt-teardown\n').length - 1, 1);
  const invalid = { ...pack, rules: { ...pack.rules, typeSkills: { broken: { script: ['unapproved-skill'] } } } };
  assert.throws(() => guidesFor(invalid, 'script', '', 'broken'), /not approved/);
});

test('Auto cannot start on a channel assigned only to explicit teardown', () => {
  const channel = { id: 'teardown-only', video_types: ['teardown'] };
  const coordinator = createCodebuiltRunCoordinator({ getChannel: () => channel, getChannels: () => [channel] });
  assert.throws(() => coordinator.startRun({ channelId: channel.id }), { code: 'channel_type_mismatch' });
  assert.throws(() => coordinator.startRun({}), { code: 'channel_type_unassigned' });
});
