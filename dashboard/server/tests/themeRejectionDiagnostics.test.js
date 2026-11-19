// codex · gpt-6.1-sol · 2026-11-16 10:36 +02:00: regression for lost all-rejected diagnostics.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAutoTopicProvider, AutoTopicError } from '../episode/codebuilt/autoTopic.js';
import { createCodebuiltRunCoordinator } from '../episode/codebuilt/runCoordinator.js';

const profile = { niche: 'map explainers about people, places and routes', language: 'en', avoid: [] };
const channel = { id: 'diagnostic-map', video_types: ['factual'], profile };
const good = {
  story_question:'Where does your route go?',ending_answer:'It bends around the mountains.',turn:'Then the road ends',who:'A traveler',want:'To reach the coast',
  topic: 'Why does Chile split your route?', title: 'Why does Chile split your route?', subject: 'Chile',
  stake: 'You face a long detour.', answer: 'The Andes divide the country.',
  payoff: 'A map route bends around the mountains.', hook: 'Why does your route split?',
};
// Each fixture reaches the real hard gates, rather than injecting a scorer result.
const variants = [
  [{ subject: '' }, 'premise:subject'],
  [{ stake: '' }, 'premise:stake'],
  [{ answer: '' }, 'premise:answer'],
  [{ payoff: '' }, 'premise:payoff'],
  [{ title: 'Why Chile?' }, 'premise:title_length'],
  [{ title: 'Why Chile stretches 4300 km?' }, 'premise:title_units'],
  [{ title: 'Why does Chile split your route? #map' }, 'premise:hashtag'],
  [{ title: 'Top 5 things that Chile gives you' }, 'premise:list'],
  [{ title: 'The Chile route and its strange shape' }, 'premise:sentence'],
  [{ title: 'Why does Chile stretch so far?', stake: 'The terrain divides the land.' }, 'premise:person_or_you'],
  [{ topic: 'Why does Chile surprise you today?', title: 'Why does Chile surprise you today?', stake: 'You face an unexpected change.', payoff: 'The result appears at the end.' }, 'premise:familiar_place'],
  [{ answer: 'Current wars interrupt the route.' }, 'fact_safety:current_wars'],
];
const rejectedCandidates = variants.map(([patch]) => ({ ...good, ...patch }));
const makePick = (candidates = rejectedCandidates) => createAutoTopicProvider({
  getChannel: () => channel,
  history: () => ({ videos: [], available: false }),
  askRoleFn: async () => ({ candidates, raw_private_response: 'never persist this' }),
});
const checkDiagnostics = (diagnostics) => {
  assert.ok(diagnostics, 'all-rejected error must retain scorer diagnostics');
  assert.equal(diagnostics.candidates.length, 12);
  assert.equal(diagnostics.rejected.length, 12);
  for (let i = 0; i < variants.length; i++) {
    const id = `c${i + 1}`;
    assert.deepEqual(diagnostics.candidates[i], { id, topic: rejectedCandidates[i].topic });
    assert.equal(diagnostics.rejected[i].id, id);
    assert.equal(diagnostics.rejected[i].topic, rejectedCandidates[i].topic);
    assert.ok(diagnostics.rejected[i].reasons.includes(variants[i][1]), `${id}: ${variants[i][1]}`);
  }
  assert.deepEqual(diagnostics.rejected[0].reasons, ['premise:subject']);
  assert.deepEqual(diagnostics.rejected[11].reasons, ['fact_safety:current_wars']);
  assert.doesNotMatch(JSON.stringify(diagnostics), /raw_private_response|never persist this|Andes|facts|shots/);
};

test('real Auto provider keeps candidate identities and exact hard-gate reasons on all rejection', async () => {
  await assert.rejects(makePick()({ channelId: channel.id }), (error) => {
    assert.ok(error instanceof AutoTopicError);
    assert.equal(error.code, 'theme_all_rejected');
    assert.equal(error.message, 'theme_all_rejected');
    checkDiagnostics(error.diagnostics);
    return true;
  });
});

test('real Auto provider still selects a passing sibling beside rejected premises', async () => {
  const result = await makePick([...rejectedCandidates, good])({ channelId: channel.id });
  assert.equal(result.topic, good.topic);
  assert.equal(result.candidate_id, 'c13');
  assert.equal(result.ranked, 1);
  assert.equal(result.rejected.length, 12);
  assert.deepEqual(result.rejected[0], { id: 'c1', reasons: ['premise:subject'] });
  assert.deepEqual(result.rejected[11], { id: 'c12', reasons: ['fact_safety:current_wars'] });
});

test('all-rejected diagnostics bound and sanitize provider topics and discard raw fields', async () => {
  const bad = { ...good, topic: '  <private>\u0000\n' + 'x'.repeat(500), subject: '', id: '<raw-id>', private: 'not for storage' };
  await assert.rejects(makePick(Array(30).fill(bad))({ channelId: channel.id }), (error) => {
    assert.equal(error.code, 'theme_all_rejected');
    assert.equal(error.diagnostics.candidates.length, 14);
    assert.equal(error.diagnostics.rejected.length, 14);
    for (const [i, candidate] of error.diagnostics.candidates.entries()) {
      assert.deepEqual(candidate, { id: `c${i + 1}`, topic: 'private ' + 'x'.repeat(192) });
      assert.equal(error.diagnostics.rejected[i].topic, candidate.topic);
    }
    assert.doesNotMatch(JSON.stringify(error.diagnostics), /raw-id|not for storage|raw_private_response/);
    return true;
  });
});

test('coordinator persists and reloads actual Auto rejection diagnostics in public video error', async (t) => {
  const base = 'C:/code/ForgeAi/output/agent-jobs/theme-rejection-diagnostics';
  fs.mkdirSync(base, { recursive: true });
  const runsDir = fs.mkdtempSync(path.join(base, 'theme-rejection-'));
  t.after(() => fs.rmSync(runsDir, { recursive: true, force: true }));
  const coordinator = createCodebuiltRunCoordinator({
    runsDir, getChannel: () => channel, getChannels: () => [channel], pickTopic: makePick(),
    starter: { start() { assert.fail('a rejected theme must never start production'); } },
  });
  const run = coordinator.startRun({ count: 1, channelId: channel.id, type: 'factual', voice: 'aiden', duration: 30 });
  await coordinator.idle();
  const video = coordinator.getRun(run.id).videos[0];
  assert.equal(video.status, 'failed');
  assert.equal(video.jobId, null);
  assert.equal(video.error.code, 'theme_all_rejected');
  assert.equal(video.error.stage, 'theme');
  checkDiagnostics(video.error.diagnostics);
  const saved = JSON.parse(fs.readFileSync(path.join(runsDir, run.id, 'run.json'), 'utf8'));
  assert.deepEqual(saved.videos[0].error, video.error);
  const reloaded = createCodebuiltRunCoordinator({ runsDir }).getRun(run.id).videos[0];
  assert.deepEqual(reloaded.error, video.error);
  checkDiagnostics(reloaded.error.diagnostics);
});

test('coordinator keeps the planner call cause on theme_provider_failed, with paths and long tokens redacted', async (t) => {
  const base = 'C:/code/ForgeAi/output/agent-jobs/theme-rejection-diagnostics';
  fs.mkdirSync(base, { recursive: true });
  const runsDir = fs.mkdtempSync(path.join(base, 'theme-provider-'));
  t.after(() => fs.rmSync(runsDir, { recursive: true, force: true }));
  const pickTopic = createAutoTopicProvider({
    getChannel: () => channel, history: () => ({ videos: [], available: false }),
    askRoleFn: async () => { throw Object.assign(new Error('cannot write C:\\Users\\Someone\\.claude\\x.json then /home/u/y token abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'), { code: 'EACCES' }); },
  });
  const coordinator = createCodebuiltRunCoordinator({ runsDir, getChannel: () => channel, getChannels: () => [channel], pickTopic, starter: { start() { assert.fail('no production'); } } });
  const run = coordinator.startRun({ count: 1, channelId: channel.id, type: 'factual', voice: 'aiden', duration: 30 });
  await coordinator.idle();
  const video = coordinator.getRun(run.id).videos[0];
  assert.equal(video.error.code, 'theme_provider_failed');
  assert.equal(video.error.diagnostics.cause, 'EACCES: cannot write <path> then <path> token <redacted>');
  const saved = JSON.parse(fs.readFileSync(path.join(runsDir, run.id, 'run.json'), 'utf8'));
  assert.deepEqual(saved.videos[0].error, video.error);
});
