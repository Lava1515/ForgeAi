import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoTopicProvider } from '../episode/codebuilt/autoTopic.js';

async function capturePrompt({ profile = null, formats = [], picture = false }) {
  let prompt;
  const pick = createAutoTopicProvider({
    getChannel: () => profile ? { id: 'guidance', profile } : null,
    history: () => ({ videos: [], available: false }),
    askRoleFn: async (_role, value) => { prompt = value; throw new Error('capture only'); },
  });
  try { await pick({ ...(profile ? { channelId: 'guidance' } : {}), formats, picture }); } catch {}
  return prompt;
}

test('picture mode without journey asks for a continuous one to three scene picture', async () => {
  for (const profile of [null, { status: 'active', niche: 'science', language: 'en', avoid: [], formats: [] }]) {
    const prompt = await capturePrompt({ profile, picture: true });
    assert.match(prompt, /one continuous move (?:through|in) one to three scenes/i);
    assert.doesNotMatch(prompt, /7 to 9, visually different, at least 3 locations/i);
    assert.doesNotMatch(prompt, /7 to 9 visually different shots in at least 3 locations/i);
    if (!profile) assert.match(prompt, /"shots":\[\{[^\]]*1 to 3, one continuous scene/);
  }
});

test('journey format retains its existing continuous scene prompt guidance', async () => {
  const prompt = await capturePrompt({ formats: ['journey'] });
  assert.match(prompt, /1 to 3, one continuous scene/);
  assert.doesNotMatch(prompt, /7 to 9, visually different, at least 3 locations/);
});
