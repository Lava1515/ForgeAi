// codex · gpt-6.1-sol · 2026-11-14: legacy compatibility and premise rejection regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoTopicProvider } from '../episode/codebuilt/autoTopic.js';
import { rulePremise } from '../episode/codebuilt/theme.js';

test('channel without profile retains the six-candidate topic contract', async () => {
  let prompt;
  const pick = createAutoTopicProvider({ getChannel: () => ({ id: 'legacy', genre: 'general' }), history: () => ({ videos: [], available: false }), askRoleFn: async (_role, text) => { prompt = text; return { candidates: [{ topic: 'Why does a pendulum swing?', answer: 'Gravity restores it.', hook: 'Why does it swing?' }] }; } });
  const result = await pick({ channelId: 'legacy' });
  assert.match(prompt, /Propose 6 different topics/);
  assert.deepEqual(result, { topic: 'Why does a pendulum swing?', candidate_id: 'c1', total: 0.708, ranked: 1, rejected: [], history_used: 0, history_available: false });
});

test('premise rejects lists, missing stakes/payoff, fragments, bad lengths and avoided phrases', () => {
  const good = { title: 'Why does the Tacoma bridge tear apart?', subject: 'Tacoma bridge', stake: 'The bridge collapses.', answer: 'Twisting motion tears the deck apart.', payoff: 'Show the deck twisting until it breaks.' };
  assert.equal(rulePremise(good, []).pass, true);
  for (const [patch, rule] of [[{ title: 'Top 5 things that bridges always do' }, 'list'], [{ subject: '' }, 'subject'], [{ stake: '' }, 'stake'], [{ payoff: '' }, 'payoff'], [{ answer: '' }, 'answer'], [{ title: 'The Tacoma bridge and its strange motion' }, 'sentence'], [{ title: 'Why bridges?' }, 'title_length'], [{ title: 'Why does the Tacoma bridge tear apart? #bridge' }, 'hashtag']]) {
    const out = rulePremise({ ...good, ...patch }, []);
    assert.equal(out.pass, false);
    assert.ok(out.reasons.some(r => r.detail === rule), rule);
  }
  assert.ok(rulePremise(good, ['TACOMA bridge']).reasons.some(r => r.detail === 'avoid:Tacoma bridge'.toLowerCase()));
});

// Review cases (claude-sonnet-5-5 review of lane B): word forms in the avoid list, list titles, other languages.
test('premise floor: avoid list by word stems, list titles, non-English questions', () => {
  const base = { subject: 'Chile', stake: 'A country 4,300 km long.', answer: 'The Andes and the ocean fence it in.', payoff: 'The map narrows to a ribbon.' };
  const run = (title, avoid = [], extra = {}, language = 'en') => rulePremise({ ...base, title, ...extra }, avoid, language);
  assert.equal(run('Why does Chile stretch 4,300 kilometres down the map?').pass, true);
  assert.equal(run('What if Java moved onto the middle of Europe?', [], { subject: 'Java' }).pass, true);
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
