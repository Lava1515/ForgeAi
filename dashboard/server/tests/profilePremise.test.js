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
    assert.ok(rulePremise({ ...good, title, ...patch }, [], 'en', { maps: true }).reasons.some(r => r.detail === detail), `${title}: ${detail}`);
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

// codex · gpt-6.1-sol · 2026-11-16 09:14 +02:00: N1 profile, tour and safety regressions.
const mapProfile = { niche: 'map explainers about people, places and routes', language: 'en', avoid: [] };
const mapCandidate = (patch = {}) => ({
  id: 'map', topic: 'Why does Chile split your route?', title: 'Why does Chile split your route?', subject: 'Chile',
  stake: 'You face a long detour.', answer: 'The Andes divide the country.', payoff: 'A map route bends around the mountains.',
  hook: 'Why does your route split?', facts: [], shots: [], tags: [], ...patch,
});
const scoreProfile = (candidate, profile = mapProfile) => scoreCandidates({ candidates: [candidate], history: [], sets: [{ name: 'code_built', themes: [] }], options: { profile, owner_wants_new_sets: true, safety_rules: { require_verified_claims: false } } });

// codex · gpt-6.1-sol · 2026-11-16: reviewer-reported non-map and teardown regressions.
test('map person/place gates preserve everyday-object and explicit teardown profiles', async () => {
  const zipper = mapCandidate({ title: 'Why does a zipper lock shut?', topic: 'Why does a zipper lock shut?', subject: 'zipper', stake: 'The teeth must stay interlocked.', payoff: 'The slider locks the teeth together.' });
  assert.ok(scoreProfile(zipper, { ...mapProfile, niche: 'everyday objects' }).chosen);
  const nozzle = mapCandidate({ title: 'How does the F-35 nozzle hide heat?', topic: 'How does the F-35 nozzle hide heat?', subject: 'nozzle', stake: 'The exhaust needs to hide heat.', payoff: 'The exhaust spreads into a wider plume.' });
  const scored = scoreCandidates({ candidates: [nozzle], history: [], sets: [{ name: 'code_built', themes: [] }], options: { profile: mapProfile, type: 'teardown', owner_wants_new_sets: true, safety_rules: { require_verified_claims: false } } });
  assert.ok(scored.chosen, JSON.stringify(scored.rejected));
  assert.ok(scoreProfile(zipper).rejected[0].reasons.some(r => r.detail === 'person_or_you'));
  const prompt = await profilePromptFor(mapProfile, 'teardown');
  assert.doesNotMatch(prompt, /map-explainer premises|Make the map central/);
  assert.match(prompt, /owner selected teardown explicitly/);
});
async function profilePromptFor(profile, type = 'factual') {
  let prompt;
  const pick = createAutoTopicProvider({ getChannel: () => ({ id: 'test', profile }), history: () => ({ videos: [], available: false }),
    askRoleFn: async (_role, value) => { prompt = value; return { candidates: [mapCandidate({ topic: type === 'whatif' ? 'What if Chile split your route?' : mapCandidate().topic })] }; },
    score: () => ({ chosen: { ...mapCandidate(), total: 1, rules: {} }, ranked: [], rejected: [], history_used: 0 }),
  });
  await pick({ channelId: 'test', type });
  return prompt;
}

test('map instructions follow the profile niche; science and history profiles retain their own niche', async () => {
  for (const niche of ['science experiments', 'true historical stories']) {
    const prompt = await profilePromptFor({ ...mapProfile, niche });
    assert.doesNotMatch(prompt, /map-explainer premises|map central|map payoff|familiar countries|current wars/);
    assert.match(prompt, /Propose 12 different premises/);
    assert.ok(prompt.includes(niche));
  }
  const prompt = await profilePromptFor(mapProfile);
  assert.match(prompt, /map-explainer premises/);
  assert.match(prompt, /4 or 5 places/);
  assert.match(prompt, /comparison/);
  assert.match(prompt, /journey/);
  assert.match(prompt, /mystery/);
  assert.match(prompt, /current wars/);
  assert.match(prompt, /disputed borders/);
  assert.doesNotMatch(prompt, /no measurement units, hashtags or lists/);
  assert.match(await profilePromptFor(mapProfile, 'whatif'), /what-if/);
});

test('map profiles allow bounded property tours while other profiles and vague lists keep their list gate', () => {
  for (const count of ['Four', '5']) {
    const tour = mapCandidate({ title: `${count} countries almost touch your route`, topic: `${count} countries almost touch your route`, subject: 'countries', answer: 'Narrow gaps separate the countries along your route.' });
    assert.ok(scoreProfile(tour).chosen, JSON.stringify(scoreProfile(tour).rejected));
    assert.ok(scoreProfile(tour, { ...mapProfile, niche: 'science' }).rejected[0].reasons.some(r => r.detail === 'list'));
  }
  for (const title of ['Five richest countries on your map', 'Ten countries almost touch your route', 'Five facts about Chile on your map']) {
    const result = scoreProfile(mapCandidate({ title, topic: title, subject: title.includes('Chile') ? 'Chile' : 'countries' }));
    assert.ok(result.rejected[0].reasons.some(r => r.detail === 'list'), title);
  }
});

test('Auto map fact_safety rejects current wars and disputed borders across candidate fields, without banning countries or historical wars', () => {
  for (const patch of [
    { topic: 'Why does an ongoing war block your route?' }, { answer: 'A current conflict closes the crossing.' },
    { payoff: 'Show the disputed border between the countries.' }, { shots: [{ visual: 'A territorial dispute changes the route.', location: 'map' }] },
    { tags: ['current_war'] }, { stake: 'People face fighting in an active armed conflict.' },
  ]) {
    const result = scoreProfile(mapCandidate(patch));
    assert.ok(result.rejected[0]?.reasons.some(r => r.rule === 'fact_safety'), JSON.stringify(patch));
  }
  for (const answer of ['Ukraine has rivers and mountain routes.', 'Russia and China have long railway routes.', 'A historical war in 1812 changed this road.', 'You travel toward the coast.']) {
    assert.ok(scoreProfile(mapCandidate({ answer })).chosen, answer);
  }
  assert.ok(scoreProfile(mapCandidate({ answer: 'A current conflict closes the crossing.' }), { ...mapProfile, niche: 'history stories' }).chosen);
});
