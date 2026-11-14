import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QWEN_SPEAKERS,
  DEFAULT_SPEAKER,
  SPEAKER_PROFILES,
  getVoiceList,
  findSampleFilePath,
  hasSampleFile,
} from '../routes/voices.js';
import { createApp } from '../app.js';

test('Qwen voices definitions cover all 9 built-in speakers and default speaker is ryan', () => {
  assert.equal(QWEN_SPEAKERS.length, 9);
  assert.ok(QWEN_SPEAKERS.includes('ryan'));
  assert.ok(QWEN_SPEAKERS.includes('aiden'));
  assert.ok(QWEN_SPEAKERS.includes('vivian'));
  assert.ok(QWEN_SPEAKERS.includes('serena'));
  assert.ok(QWEN_SPEAKERS.includes('uncle_fu'));
  assert.ok(QWEN_SPEAKERS.includes('dylan'));
  assert.ok(QWEN_SPEAKERS.includes('eric'));
  assert.ok(QWEN_SPEAKERS.includes('ono_anna'));
  assert.ok(QWEN_SPEAKERS.includes('sohee'));
  assert.equal(DEFAULT_SPEAKER, 'ryan');

  for (const id of QWEN_SPEAKERS) {
    const profile = SPEAKER_PROFILES[id];
    assert.ok(profile, `Profile missing for speaker ${id}`);
    assert.equal(profile.id, id);
    assert.ok(profile.name.length > 0);
    assert.ok(profile.accent.length > 0);
    assert.ok(Array.isArray(profile.traits));
    assert.ok(Array.isArray(profile.bestFor));
  }
});

test('getVoiceList returns all 9 speakers with samples and Apache-2.0 license metadata', () => {
  const result = getVoiceList();
  assert.equal(result.totalVoices, 9);
  assert.equal(result.licence, 'Apache-2.0');
  assert.match(result.model, /Qwen/i);
  assert.ok(result.script.length > 20);
  assert.equal(result.voices.length, 9);

  const ryan = result.voices.find((v) => v.id === 'ryan');
  assert.ok(ryan);
  assert.equal(ryan.isDefault, true);
  assert.equal(ryan.hasSample, true);
  assert.ok(ryan.seconds > 10);
  assert.equal(ryan.sampleRate, 24000);
});

test('findSampleFilePath rejects path traversal and unknown speakers', () => {
  assert.equal(findSampleFilePath('../secret'), null);
  assert.equal(findSampleFilePath('..\\windows\\system32'), null);
  assert.equal(findSampleFilePath('non_existent_voice'), null);
  assert.equal(findSampleFilePath(''), null);
  assert.equal(findSampleFilePath(null), null);

  for (const id of QWEN_SPEAKERS) {
    assert.equal(hasSampleFile(id), true);
    const wavPath = findSampleFilePath(id);
    assert.ok(wavPath && wavPath.endsWith('.wav'));
  }
});

test('Express app serves /api/voices and /api/voices/:id/sample endpoints correctly', async () => {
  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. List voices
    const listRes = await fetch(`${baseUrl}/api/voices`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.totalVoices, 9);
    assert.equal(listData.voices.length, 9);

    // 2. Single voice
    const voiceRes = await fetch(`${baseUrl}/api/voices/ryan`);
    assert.equal(voiceRes.status, 200);
    const voiceData = await voiceRes.json();
    assert.equal(voiceData.id, 'ryan');
    assert.equal(voiceData.name, 'Ryan');

    // 3. Unknown voice 404
    const notFoundRes = await fetch(`${baseUrl}/api/voices/unknown_speaker`);
    assert.equal(notFoundRes.status, 404);

    // 4. Sample audio stream
    const sampleRes = await fetch(`${baseUrl}/api/voices/ryan/sample`);
    assert.equal(sampleRes.status, 200);
    assert.equal(sampleRes.headers.get('content-type'), 'audio/wav');
    const audioBuffer = await sampleRes.arrayBuffer();
    assert.ok(audioBuffer.byteLength > 100000);

    // 5. Audio Range request (partial content 206)
    const rangeRes = await fetch(`${baseUrl}/api/voices/ryan/sample`, {
      headers: { Range: 'bytes=0-1023' },
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get('content-range')?.startsWith('bytes 0-1023/'), true);
    const rangeBuffer = await rangeRes.arrayBuffer();
    assert.equal(rangeBuffer.byteLength, 1024);

    // 6. Release-log endpoint registered alongside existing routes
    const releaseLogRes = await fetch(`${baseUrl}/api/youtube/release-log`);
    assert.ok(releaseLogRes.status === 200 || releaseLogRes.status === 501);
  } finally {
    server.close();
  }
});
