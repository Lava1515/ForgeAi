// M6p (2026-11-15): unprofiled auto-topic prompt carries the M6 topic guidance; it stays guidance, not a validator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoTopicProvider, sanitizeCandidates } from '../episode/codebuilt/autoTopic.js';

const TOPIC_BY_TYPE = { factual: 'Why does a pendulum swing?', whatif: 'What if the Moon vanished tonight?', history: 'Why did the Titanic sink in 1912?' };

const capturePrompt = async (type) => {
  let prompt;
  const pick = createAutoTopicProvider({
    getChannel: () => ({ id: 'plain', genre: 'general' }),
    history: () => ({ videos: [], available: false }),
    askRoleFn: async (_role, text) => { prompt = text; return { candidates: [{ topic: TOPIC_BY_TYPE[type], answer: 'Gravity restores it.', hook: 'Why does it swing?' }] }; },
  });
  await pick({ channelId: 'plain', type });
  return prompt;
};

test('unprofiled factual prompt asks for a concrete subject, stake, payoff, 6 to 10 words and no hashtags or lists', async () => {
  const prompt = await capturePrompt('factual');
  assert.match(prompt, /Propose 6 different topics/);
  assert.match(prompt, /6 to 10 words \(guidance, not a limit\)/);
  assert.match(prompt, /names one concrete subject and the stake for it/);
  assert.match(prompt, /visible payoff/);
  assert.match(prompt, /no hashtags, no lists/);
  assert.match(prompt, /Never a "What if \.\.\.\?" question/);
  assert.match(prompt, /hook": string \(names the subject and one concrete stake/);
});

test('unprofiled whatif and history prompts keep their own topic rules alongside the M6 guidance', async () => {
  const whatif = await capturePrompt('whatif');
  assert.match(whatif, /Every topic must be a "What if \.\.\.\?" question/);
  assert.match(whatif, /6 to 10 words \(guidance, not a limit\)/);
  const history = await capturePrompt('history');
  assert.match(history, /true historical question or claim/);
  assert.match(history, /6 to 10 words \(guidance, not a limit\)/);
});

test('the 6 to 10 word rule is guidance: a short candidate topic is still accepted', () => {
  const kept = sanitizeCandidates({ candidates: [{ topic: 'Why bridges?', answer: 'Forces.', hook: 'Why?' }] }, { type: 'factual' });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].topic, 'Why bridges?');
});
