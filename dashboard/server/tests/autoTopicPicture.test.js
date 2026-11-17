import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAutoTopicProvider, sanitizeCandidates } from '../episode/codebuilt/autoTopic.js';
import { scoreCandidates, THEME_RULES } from '../episode/codebuilt/theme.js';

const story = {
  story_question: 'How far can one paper plane travel?',
  ending_answer: 'It reaches the far wall after crossing the room.',
  turn: 'Then it hits the wall.',
  who: 'A student testing a folded plane',
  want: 'to see how far the fold can fly',
};
const picture = {
  shape: 'journey', watch: 'a paper plane gliding across a room',
  change: 'floor markers pass as the distance counter rises',
  number: { what: 'distance', unit: 'metres' },
  last_image: 'the tiny plane beside the full length of the room',
};
const basic = { topic: 'Why does a paper plane fly farther?', title: 'Why does a paper plane fly farther?', subject: 'paper plane', stake: 'A fold changes how far it flies.', payoff: 'The room becomes a runway.', answer: 'It crosses the room.', hook: 'How far can it fly?', main_setting: 'room', facts: [], shots: [] };

test('picture disabled preserves both classic prompt byte snapshots', async () => {
  const prompt = async (channelId) => {
    let text;
    const pick = createAutoTopicProvider({
      getChannel: () => channelId ? { id: channelId, profile: { status: 'active', niche: 'science', language: 'en', avoid: [], formats: [] } } : null,
      history: () => ({ videos: [], available: false }),
      askRoleFn: async (_role, value) => { text = value; return { candidates: [basic] }; },
    });
    await pick({ ...(channelId ? { channelId } : {}), picture: false });
    return createHash('sha256').update(text).digest('hex');
  };
  assert.equal(await prompt(null), 'e3674475736bcdf3d337940efbb596fcdd3629b91df6e7fa49eaf4ce620f46b9');
  assert.equal(await prompt('snapshot'), '64d8acc491d14a644e6281e89f541bbab9813ee9e5fa7e827c247cb6e13ef944');
});

test('picture-enabled prompt requests a viewer-clickable idea, visual follow, turn, five shapes and contract fields', async () => {
  const phrases = ['viewer would click', 'what the eye follows', 'line-up of sizes without a turn', 'journey, tour, comparison, mystery, or whatif_chain', '"picture"', '"story_question"', '"ending_answer"', '"turn"', '"who"', '"want"'];
  for (const profile of [null, { status: 'active', niche: 'science', language: 'en', avoid: [], formats: [] }]) {
    let prompt;
    const pick = createAutoTopicProvider({
      getChannel: () => profile ? { id: 'picture-profile', profile } : null,
      history: () => ({ videos: [], available: false }),
      askRoleFn: async (_role, value) => { prompt = value; return { candidates: [{ ...basic, ...story, picture }] }; },
    });
    await pick({ ...(profile ? { channelId: 'picture-profile' } : {}), picture: true });
    for (const phrase of phrases) assert.ok(prompt.includes(phrase), phrase);
  }
});

test('picture mode requires valid story fields and keeps candidates with invalid pictures using null', () => {
  const complete = { ...basic, ...story, picture };
  assert.equal(sanitizeCandidates({ candidates: [basic] }, { picture: true }).length, 0);
  for (const field of Object.keys(story)) {
    const invalidStory = { ...complete };
    delete invalidStory[field];
    assert.equal(sanitizeCandidates({ candidates: [invalidStory] }, { picture: true }).length, 0, field);
  }
  assert.equal(sanitizeCandidates({ candidates: [{ ...complete, story_question: 'Q'.repeat(301) }] }, { picture: true }).length, 0);
  const invalidPicture = sanitizeCandidates({ candidates: [{ ...complete, picture: { ...picture, shape: 'pan' } }] }, { picture: true });
  assert.equal(invalidPicture.length, 1);
  assert.equal(invalidPicture[0].picture, null);
  assert.equal(sanitizeCandidates({ candidates: [{ ...complete, picture: { ...picture, watch: 'x'.repeat(121) } }] }, { picture: true })[0].picture, null);
  const kept = sanitizeCandidates({ candidates: [complete] }, { picture: true });
  assert.deepEqual(kept[0].picture, picture);
  assert.deepEqual(Object.fromEntries(Object.keys(story).map((key) => [key, kept[0][key]])), story);
});

test('journey picture is derived from the existing journey fields', () => {
  const candidate = sanitizeCandidates({ candidates: [{
    ...basic, ...story, thing: 'paper plane', move: 'glide across a room',
    landmarks: [{ name: 'desk', number: 1, source: 'https://example.org/a' }, { name: 'door', number: 4, source: 'https://example.org/b' }, { name: 'wall', number: 8, source: 'https://example.org/c' }],
    counter: { what: 'distance', unit: 'metres' }, last_number: 8,
  }] }, { formats: ['journey'], picture: true })[0];
  assert.deepEqual(candidate.picture, { shape: 'journey', watch: 'paper plane', change: 'glide across a room', number: { what: 'distance', unit: 'metres' }, last_image: 'The journey ends at wall: 8.' });
});

test('picture scoring handles null and comparison without a story turn, with picture mode weights', () => {
  assert.ok(THEME_RULES.every((rule) => rule.key !== 'picture'));
  const candidates = [
    { ...basic, topic: 'Why does a paper plane fly farther?', ...story, picture },
    { ...basic, topic: 'Why does a folded plane turn?', ...story, turn: 'Then the engine failed.', picture: { ...picture, shape: 'comparison' } },
    { ...basic, topic: 'Why does a paper plane drift?', ...story, turn: 'The sizes differ.', picture: { ...picture, shape: 'comparison' } },
    { ...basic, topic: 'Why does a paper plane wobble?', ...story, turn: 'The sizes differ.', picture: null },
    { ...basic, topic: 'Why does a paper plane glide?', ...story, picture, shots: Array.from({ length: 9 }, (_, i) => ({ visual: `view ${i}`, location: `place ${i % 3}` })) },
  ];
  const result = scoreCandidates({ candidates, history: [], sets: [{ name: 'code_built', themes: [] }], options: { picture: true, safety_rules: { require_verified_claims: false } } });
  assert.equal(result.ranked[0].rules.picture.score, 1);
  assert.equal(result.ranked.find((c) => c.topic === candidates[1].topic)?.rules.picture.score, 1);
  assert.equal(result.ranked.find((c) => c.topic === candidates[2].topic)?.rules.picture.score, 0.5);
  assert.equal(result.ranked.find((c) => c.topic === candidates[3].topic)?.rules.picture.score, 0);
  assert.equal(result.ranked[0].rules.shots_locations.score, 0);
  assert.equal(result.ranked.find((c) => c.topic === candidates[0].topic).total, result.ranked.find((c) => c.topic === candidates[4].topic).total);
});

test('picture-enabled pick returns picture and five story fields in premise', async () => {
  const candidate = { ...basic, title: basic.topic, subject: 'paper plane', stake: 'A fold changes how far it flies.', payoff: 'The room becomes a runway.', facts: [], shots: [], ...story, picture };
  const pick = createAutoTopicProvider({ history: () => ({ videos: [], available: false }), askRoleFn: async () => ({ candidates: [candidate] }) });
  const result = await pick({ picture: true });
  assert.deepEqual(result.premise.picture, picture);
  for (const key of Object.keys(story)) assert.equal(result.premise[key], story[key]);
});
