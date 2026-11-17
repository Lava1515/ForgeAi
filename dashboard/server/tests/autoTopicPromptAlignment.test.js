// M6p (2026-11-15): unprofiled auto-topic prompt carries the M6 topic guidance; it stays guidance, not a validator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoTopicProvider, sanitizeCandidates } from '../episode/codebuilt/autoTopic.js';

const TOPIC_BY_TYPE = { factual: 'Why does a pendulum swing?', whatif: 'What if the Moon vanished tonight?', history: 'Why did the Titanic sink in 1912?', teardown: 'How does the stealth jet hide radar?' };

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

test('unprofiled whatif, history and teardown prompts keep their own topic rules alongside the M6 guidance', async () => {
  const whatif = await capturePrompt('whatif');
  assert.match(whatif, /Every topic must be a "What if \.\.\.\?" question/);
  assert.match(whatif, /6 to 10 words \(guidance, not a limit\)/);
  const history = await capturePrompt('history');
  assert.match(history, /true historical question or claim/);
  assert.match(history, /6 to 10 words \(guidance, not a limit\)/);
  const teardown = await capturePrompt('teardown');
  assert.match(teardown, /specific part, subsystem, or design principle of the stealth jet/);
  assert.match(teardown, /illustrative, not a verified aircraft/i);
});

test('a teardown topic cannot be an automatically proposed What if', () => {
  const kept = sanitizeCandidates({ candidates: [
    { topic: 'What if the stealth jet disappeared?', answer: 'Hypothetical.', hook: 'What if?' },
    { topic: 'How does the stealth jet hide radar?', answer: 'Its shape redirects radar.', hook: 'Radar sees less.' },
  ] }, { type: 'teardown' });
  assert.deepEqual(kept.map((candidate) => candidate.topic), ['How does the stealth jet hide radar?']);
});

test('the 6 to 10 word rule is guidance: a short candidate topic is still accepted', () => {
  const kept = sanitizeCandidates({ candidates: [{ topic: 'Why bridges?', answer: 'Forces.', hook: 'Why?' }] }, { type: 'factual' });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].topic, 'Why bridges?');
});

test('journey profiles reject candidates without sourced landmarks and retain the next complete premise', async () => {
  const pick = createAutoTopicProvider({
    getChannel: () => ({ id: 'journey', profile: { status: 'active', niche: 'science journeys', formats: ['journey'], language: 'en', avoid: [] } }),
    history: () => ({ videos: [], available: false }),
    askRoleFn: async () => ({ candidates: [
      { topic: 'How far does a paper plane fly?', title: 'How far does a paper plane fly?', subject: 'paper plane', stake: 'A fold changes its flight.', answer: 'The flight ends at a measured distance.', hook: 'Watch the flight distance.', payoff: 'A short runway dwarfs the plane.', thing: 'paper plane', move: 'glide down a measured runway', landmarks: [], counter: { what: 'flight distance', unit: 'm' }, last_number: 0 },
      { topic: 'How far does a toy car roll?', title: 'How far does a toy car roll?', subject: 'toy car', stake: 'A small push travels farther.', answer: 'A toy car rolls across a measured floor.', hook: 'Follow the rolling car.', payoff: 'The final distance dwarfs the car.', story_question: 'How far can a small push send a toy car?', ending_answer: 'It rolls five metres.', turn: 'Then it stops short.', who: 'A child', want: 'measure the roll', thing: 'toy car', move: 'roll along a measured floor', landmarks: [
        { name: 'tile', number: 0.3, source: 'https://example.org/tile' }, { name: 'door', number: 2, source: 'https://example.org/door' }, { name: 'room', number: 5, source: 'https://example.org/room' },
      ], counter: { what: 'distance rolled', unit: 'm' }, last_number: 5 },
    ] }),
  });
  const result = await pick({ channelId: 'journey', type: 'factual' });
  assert.equal(result.topic, 'How far does a toy car roll?');
  assert.deepEqual(result.premise.formats, ['journey']);
  assert.equal(result.premise.thing, 'toy car');
  assert.equal(result.premise.landmarks.length, 3);
  assert.equal(result.premise.story_question, 'How far can a small push send a toy car?');
  assert.equal(result.premise.want, 'measure the roll');
});

test('an explicitly requested journey format gates an unprofiled topic pick and returns its premise contract', async () => {
  let prompt;
  const pick = createAutoTopicProvider({
    getChannel: () => null,
    history: () => ({ videos: [], available: false }),
    askRoleFn: async (_role, text) => {
      prompt = text;
      return { candidates: [{
        topic: 'How far does a light pulse travel?', title: 'How far does a light pulse travel?', subject: 'light pulse', stake: 'Space is larger than it looks.', answer: 'A light pulse crosses huge distances.', hook: 'Follow one pulse.', payoff: 'The last distance changes the scale.', story_question: 'How far does one pulse travel?', ending_answer: 'It reaches Proxima in 4.24 light-years.', turn: 'Then the minutes become years.', who: 'NASA astronomers wanted to map nearby worlds.',
        thing: 'light pulse', move: 'travel outward from the Sun', want: 'map nearby worlds', landmarks: [
          { name: 'Earth', number: 1, source: 'https://science.nasa.gov/' }, { name: 'Jupiter', number: 5.2, source: 'https://science.nasa.gov/' }, { name: 'Neptune', number: 30, source: 'https://science.nasa.gov/' },
        ], counter: { what: 'distance from the Sun', unit: 'AU' }, last_number: 268000,
      }] };
    },
  });
  const result = await pick({ type: 'factual', formats: ['journey'] });
  assert.match(prompt, /one continuous move/);
  assert.deepEqual(result.premise.formats, ['journey']);
  assert.equal(result.premise.thing, 'light pulse');
  assert.equal(result.premise.turn, 'Then the minutes become years.');
  assert.equal(result.premise.want, 'map nearby worlds');
  assert.equal(result.premise.title, 'How far does a light pulse travel?');
  assert.equal(result.premise.hook, 'Follow one pulse.');
  assert.equal(result.premise.stake, 'Space is larger than it looks.');
  assert.equal(result.premise.answer, 'A light pulse crosses huge distances.');
  assert.equal(result.premise.payoff, 'The last distance changes the scale.');
  assert.equal(result.premise.subject, 'light pulse');
});

test('journey premise gate rejects a missing question, ending answer, short turn, actor, or goal', () => {
  const valid = {
    topic: 'How far does a light pulse travel?', title: 'How far does a light pulse travel?', subject: 'light pulse', stake: 'Space is larger than it looks.', answer: 'A light pulse crosses huge distances.', hook: 'Follow one pulse.', payoff: 'The last distance changes the scale.',
    story_question: 'How far does one pulse travel?', ending_answer: 'It reaches Proxima in 4.24 light-years.', turn: 'Then minutes become years.', who: 'NASA astronomers', want: 'map nearby worlds',
    thing: 'light pulse', move: 'travel outward from the Sun', landmarks: [
      { name: 'Earth', number: 1, source: 'https://science.nasa.gov/' }, { name: 'Jupiter', number: 5.2, source: 'https://science.nasa.gov/' }, { name: 'Neptune', number: 30, source: 'https://science.nasa.gov/' },
    ], counter: { what: 'distance from the Sun', unit: 'AU' }, last_number: 268000,
  };
  for (const field of ['story_question', 'ending_answer', 'turn', 'who', 'want']) {
    const candidate = { ...valid };
    delete candidate[field];
    assert.equal(sanitizeCandidates({ candidates: [candidate] }, { formats: ['journey'] }).length, 0, `${field} is required`);
  }
  assert.equal(sanitizeCandidates({ candidates: [{ ...valid, turn: 'An unexpected event suddenly stops everything at the worst possible moment.' }] }, { formats: ['journey'] }).length, 0);
  assert.equal(sanitizeCandidates({ candidates: [valid] }, { type: 'teardown', formats: ['journey'] }).length, 0);
  assert.equal(sanitizeCandidates({ candidates: [{ ...valid, topic: 'How does a stealth jet hide?' }] }, { type: 'teardown', profile: { formats: ['journey'] } }).length, 1);
  const flat = { ...valid, landmarks: valid.landmarks.map((point) => ({ ...point, number: 1 })) };
  assert.equal(sanitizeCandidates({ candidates: [flat] }, { formats: ['journey'] }).length, 0);
});
