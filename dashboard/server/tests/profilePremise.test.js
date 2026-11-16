// codex · gpt-6.1-sol · 2026-11-14: legacy compatibility and premise rejection regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutoTopicProvider, readChannelHistory } from '../episode/codebuilt/autoTopic.js';
import { rulePremise, scoreCandidates } from '../episode/codebuilt/theme.js';

test('channel without profile retains the six-candidate topic contract', async () => {
  let prompt;
  const pick = createAutoTopicProvider({ getChannel: () => ({ id: 'legacy', genre: 'general' }), history: () => ({ videos: [], available: false }), askRoleFn: async (_role, text) => { prompt = text; return { candidates: [{ topic: 'Why does a pendulum swing?', answer: 'Gravity restores it.', hook: 'Why does it swing?' }] }; } });
  const result = await pick({ channelId: 'legacy' });
  assert.match(prompt, /Propose 6 different topics/);
  assert.deepEqual(result, { topic: 'Why does a pendulum swing?', candidate_id: 'c1', total: 0.708, ranked: 1, rejected: [], history_used: 0, history_available: false });
});

test('premise rejects lists, missing stakes/payoff, fragments, bad lengths and avoided phrases', () => {
  const good = { title: 'Why does Tacoma threaten bridge travellers?', subject: 'Tacoma bridge', stake: 'Travellers could lose their route.', answer: 'Twisting motion tears the deck apart.', payoff: 'Show the deck twisting until it breaks.' };
  assert.equal(rulePremise(good, []).pass, true);
  for (const [patch, rule] of [[{ title: 'Top 5 things that bridges always do' }, 'list'], [{ subject: '' }, 'subject'], [{ stake: '' }, 'stake'], [{ payoff: '' }, 'payoff'], [{ answer: '' }, 'answer'], [{ title: 'The Tacoma bridge and its strange motion' }, 'sentence'], [{ title: 'Why bridges?' }, 'title_length'], [{ title: 'Why does the Tacoma bridge tear apart? #bridge' }, 'hashtag']]) {
    const out = rulePremise({ ...good, ...patch }, []);
    assert.equal(out.pass, false);
    assert.ok(out.reasons.some(r => r.detail === rule), rule);
  }
  assert.ok(rulePremise(good, ['TACOMA bridge']).reasons.some(r => r.detail === 'avoid:Tacoma bridge'.toLowerCase()));
});

test('profile titles require 4 to 8 plain words without units and reward a human stake in a familiar place', () => {
  const good = { title: 'Why does Chile split your route?', subject: 'Chile', stake: 'You face a long detour.', answer: 'The Andes divide the country.', payoff: 'A map route bends around the mountains.' };
  assert.equal(rulePremise(good, []).pass, true);
  for (const [title, detail, patch] of [['Why Chile stretches 4,300 kilometres down the map today?', 'title_length', {}], ['Why Chile stretches 4,300 km?', 'title_units', {}], ['Why is this so unusual?', 'person_or_you', { stake: 'Something important could change.' }], ['Why did this happen to you?', 'familiar_place', { payoff: 'The result appears at the end.' }]]) {
    assert.ok(rulePremise({ ...good, title, ...patch }, []).reasons.some(r => r.detail === detail), `${title}: ${detail}`);
  }
});

test('not_repeat checks a draft older than the former 20-video window', () => {
  const title = 'Why does Chile split your route?';
  const history = Array.from({ length: 25 }, (_, i) => ({ video_id: `v${i}`, title: `Unrelated subject ${i}`, theme: '', published_at: new Date(Date.UTC(2026, 0, 25 - i)).toISOString() }));
  history[24] = { ...history[24], title, subject: 'Chile', topic: title };
  const candidate = {
    id: 'new', topic: title, title, subject: 'Chile', stake: 'You face a long detour.', answer: 'The Andes divide the country.', payoff: 'A map route bends around the mountains.', hook: 'Why does your route split?', main_setting: 'Chile',
    facts: [1, 2, 3].map(value => ({ value, source: 'test source' })),
    shots: Array.from({ length: 7 }, (_, i) => ({ visual: `map view ${i}`, location: `place ${i % 3}` })),
  };
  const result = scoreCandidates({ candidates: [candidate], history, sets: [{ name: 'code_built', themes: [] }], options: { profile: { niche: 'map explainers', language: 'en', avoid: [] }, owner_wants_new_sets: true } });
  assert.equal(result.history_used, 25);
  assert.ok(result.rejected[0].reasons.some(reason => reason.rule === 'not_repeat'));
});

test('channel history includes all saved unpublished drafts for that channel', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeai-topic-history-'));
  const previous = process.env.FORGEAI_DRAFTS_DIR;
  try {
    process.env.FORGEAI_DRAFTS_DIR = root;
    for (let i = 0; i < 27; i++) {
      const folder = path.join(root, `draft-${i}`);
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, 'metadata.json'), JSON.stringify({
        channel_id: 'map-channel', created_at: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
        listing_copy: { title: i === 0 ? 'Why does Chile split your route?' : `Unrelated place topic ${i}` },
      }));
    }
    const loaded = readChannelHistory('map-channel');
    assert.equal(loaded.videos.length, 27);
    assert.ok(loaded.videos.some(video => video.title === 'Why does Chile split your route?'));
  } finally {
    if (previous === undefined) delete process.env.FORGEAI_DRAFTS_DIR;
    else process.env.FORGEAI_DRAFTS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Review cases (claude-sonnet-5-5 review of lane B): word forms in the avoid list, list titles, other languages.
test('premise floor: avoid list by word stems, list titles, non-English questions', () => {
  const base = { subject: 'Chile', stake: 'A country 4,300 km long.', answer: 'The Andes and the ocean fence it in.', payoff: 'The map narrows to a ribbon.' };
  const run = (title, avoid = [], extra = {}, language = 'en') => rulePremise({ ...base, title, ...extra }, avoid, language);
  assert.equal(run('Why Chile stretches 4,300 today?').pass, true);
  assert.equal(run('What if Java moves across Europe?', [], { subject: 'Java' }).pass, true);
  const avoid = ['disputed borders', 'current wars', 'war'];
  for (const title of ['Why Kashmir has a long border dispute today', 'Why this country is in a current war', 'Why Kashmir has Disputed Borders with its neighbours']) {
    assert.ok(run(title, avoid, { subject: 'Kashmir' }).reasons.some((r) => r.detail.startsWith('avoid:')), title);
  }
  assert.ok(!run('Why does Chile lean toward the Pacific Ocean?', ['war']).reasons.some((r) => r.detail.startsWith('avoid:')));
  for (const title of ['Ten countries that are shrinking quickly right now', 'Five surprising facts about Chile you should know']) {
    assert.ok(run(title).reasons.some((r) => r.detail === 'list'), title);
  }
  assert.equal(run('Warum ist Chile so lang und so dünn?', [], {}, 'de').pass, true);
  assert.ok(run('Why Chile is long', [], { subject: 'countries' }).reasons.some((r) => r.detail === 'subject'));
});
