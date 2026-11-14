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
