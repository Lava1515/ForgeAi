// codex · gpt-6.1-sol · 2026-11-19 19:33 +02:00: proof-day what-if resolution regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAutoTopicProvider, sanitizeCandidates } from '../episode/codebuilt/autoTopic.js';
import { createCodebuiltRunCoordinator } from '../episode/codebuilt/runCoordinator.js';

const profile = { niche: 'science', language: 'en', avoid: [] };
const candidate = {
  topic: 'Moon disappearance', title: 'What if the Moon vanished tonight?', subject: 'Moon',
  stake: 'Coastal people face changing tides.', answer: 'Lunar tides would disappear.',
  hook: 'What if the Moon vanished?', payoff: 'The lunar tide disappears from the coast.',
  story_question: 'What happens to the coast without the Moon?', ending_answer: 'The lunar tidal component disappears.',
  turn: 'Then the lunar tide disappears', who: 'Coastal people', want: 'understand the changing coast',
  picture: { shape: 'whatif_chain', watch: 'the water at a familiar coast', change: 'the lunar tide disappears from the coast', number: null, last_image: 'the coast without its lunar tidal component' },
};

test('profiled what-if uses the explicit question title when topic is a subject label', async () => {
  let prompt;
  const pick = createAutoTopicProvider({ getChannel: () => ({ id: 'science', profile, video_types: ['whatif'] }), history: () => ({ videos: [] }),
    askRoleFn: async (_role, text) => { prompt = text; return { candidates: [candidate] }; } });
  const result = await pick({ channelId: 'science', type: 'whatif', picture: true });
  assert.equal(result.topic, candidate.title);
  assert.match(prompt, /topic.*start.*What if.*end.*\?/);
  assert.equal(sanitizeCandidates({ candidates: [{ ...candidate, title: 'Why does the Moon change tides?' }] }, { type: 'whatif', profile }).length, 0);
  assert.equal(sanitizeCandidates({ candidates: [{ ...candidate, topic: candidate.title }] }, { type: 'factual', profile }).length, 0);
});

test('empty and rejected answers survive A4 retry and successful topic selection in the run folder', async (t) => {
  const base = path.resolve('../../output/agent-jobs/f7-tests');
  fs.mkdirSync(base, { recursive: true });
  const runsDir = fs.mkdtempSync(path.join(base, 'runs-'));
  t.after(() => fs.rmSync(runsDir, { recursive: true, force: true }));
  let calls = 0;
  const rawAnswers = [null, { candidates: [{ ...candidate, title: 'Moon disappearance' }] }];
  const pickTopic = createAutoTopicProvider({ getChannel: () => ({ id: 'science', profile, video_types: ['whatif'] }), history: () => ({ videos: [] }),
    askRoleFn: async () => rawAnswers[calls++ % 2] });
  const coordinator = createCodebuiltRunCoordinator({ runsDir, pollMs: 1, getChannel: () => ({ id: 'science', profile, video_types: ['whatif'] }),
    pickTopic, autoInputs: () => ({ growth: { ideas: [{ topic: candidate.title }] } }),
    starter: { start: () => ({ id: 'fixture', status: 'done', draftId: 'fixture' }), get: () => ({ status: 'done', draftId: 'fixture' }) } });
  const run = coordinator.startRun({ type: 'whatif', channelId: 'science', duration: 30, voice: 'aiden' });
  await coordinator.idle();
  assert.equal(calls, 2);
  const saved = JSON.parse(fs.readFileSync(path.join(runsDir, run.id, 'run.json')));
  assert.equal(saved.videos[0].status, 'done');
  assert.equal(saved.videos[0].topic_rejections.length, 2);
  for (const [i, ref] of saved.videos[0].topic_rejections.entries()) {
    const record = JSON.parse(fs.readFileSync(path.join(runsDir, run.id, ref.file)));
    assert.deepEqual(record.answer, rawAnswers[i]);
    assert.equal(record.code, 'theme_no_candidates');
    assert.match(JSON.stringify(record.rejected), i === 0 ? /candidates_missing_or_empty/ : /topic_type_mismatch/);
  }
});

test('scorer refusals retain the unsanitized answer and gate reasons even beside a usable topic', async () => {
  for (const keepGood of [false, true]) {
    const answer = { candidates: [{ ...candidate, topic: candidate.title, subject: '' }, ...(keepGood ? [{ ...candidate, topic: candidate.title }] : [])] };
    const records = [];
    const pick = createAutoTopicProvider({ getChannel: () => ({ id: 'science', profile, video_types: ['whatif'] }), history: () => ({ videos: [] }), askRoleFn: async () => answer });
    const result = pick({ channelId: 'science', type: 'whatif', picture: true, onRejectedAnswer: (record) => records.push(record) });
    if (keepGood) assert.equal((await result).topic, candidate.title);
    else await assert.rejects(result, { code: 'theme_all_rejected' });
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].answer, answer);
    assert.equal(records[0].code, keepGood ? 'theme_partial_rejection' : 'theme_all_rejected');
    assert.ok(records[0].rejected[0].reasons.some((reason) => reason.rule === 'premise' && reason.detail === 'subject'));
  }
});
