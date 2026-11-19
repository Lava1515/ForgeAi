import { authorOptions } from './helpers/authored.js';
// codex · gpt-6.1-sol · 2026-11-16 08:59 +02:00: S2 extends E1 delivery assertions to every beat.
// E1b (owner order 2026-11-15): the ending of a video is voiced with its own lift.
// Real damage guarded: the code-built voice call sent the whole script as ONE scene with no deliveries, so the factory could never
// give the last line its own tone, and voice.json said nothing about how any sentence was read. The factory is a fake here, but it answers
// in the shape narrative_factory/server.py really returns for /api/tts-timed (sentences: [{ text, start, end, tone, seed }]).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCodebuiltVoice } from '../episode/codebuilt/voice.js';
import { runVoiceStage } from '../episode/voice.js';
import { createCodebuiltStarter } from '../episode/codebuilt/start.js';
import { createEpisodeDir } from '../episode/artifacts.js';

const BEATS = [
  { narration: 'Two crews started digging from opposite sides.', subject: 'a', action: 'b', feel: 'curious' },
  { narration: 'One crew started near the north. The other started near the south.', subject: 'a', action: 'b', feel: 'building' },
  { narration: 'Giant machines chewed through the rock for years.', subject: 'a', action: 'b', feel: 'building' },
  { narration: 'They met in the middle with centimeters to spare. Nobody could believe it.', subject: 'a', action: 'b', feel: 'amazed' },
];
const SCRIPT = BEATS.map((b) => b.narration).join(' ');
const RATE = 16000;

function wavOf(spans, seconds) { // sound only where the words are
  const frames = Math.round(seconds * RATE); const data = Buffer.alloc(frames * 2);
  for (const [s, e] of spans) for (let i = Math.round(s * RATE); i < Math.min(frames, Math.round(e * RATE)); i += 1) data.writeInt16LE(Math.round(Math.sin(i / 5) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** A fake of /api/tts-timed: each sentence carries its beat delivery, as story_tone.normalize_deliveries now decides. */
function fakeFactory({ withSentences = true, calls = [] } = {}) {
  return async (route, body) => {
    calls.push({ route, body });
    assert.equal(route, '/api/tts-timed');
    const tokens = body.scenes.join(' ').split(/\s+/);
    let cursor = 0.3;
    const words = tokens.map((text, i) => { const start = cursor; const end = start + 0.08 * text.length * (1 + (i % 3) * 0.3); cursor = end + 0.04; return { text, start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) }; });
    const sentences = [];
    let at = 0;
    body.scenes.forEach((scene, sceneIdx) => {
      for (const text of scene.split(/(?<=[.!?…])\s+/)) {
        const n = text.split(/\s+/).length;
        sentences.push({ text, start: words[at].start, end: words[at + n - 1].end, sceneIdx, seed: 7 });
        at += n;
      }
    });
    sentences.forEach((s, i) => {
      const told = body.deliveries?.[s.sceneIdx];
      s.tone = told ? `PLAIN, a touch of: ${told}` : 'PLAIN';
      delete s.sceneIdx;
    });
    const seconds = words.at(-1).end + 0.4;
    const wav = wavOf(words.map((w) => [w.start, w.end]), seconds);
    return { status: 'success', audio_base64: wav.toString('base64'), word_timing_source: 'aligned', words, ...(withSentences ? { sentences } : {}) };
  };
}

function scratch() {
  const root = fs.mkdtempSync(path.join('C:/code/ForgeAi/output/agent-jobs/c4-remove-classic', 'e1-voice-'));
  fs.mkdirSync(path.join(root, 'job'), { recursive: true });
  createEpisodeDir(path.join(root, 'episodes'), 'cb-e1');
  return { root, outDir: path.join(root, 'job'), episodesRoot: path.join(root, 'episodes') };
}
const voiceArgs = (s, extra) => ({ script: SCRIPT, voice: 'aiden', outDir: s.outDir, allowedRoot: s.root, episodeDir: 'cb-e1', episodesRoot: s.episodesRoot, ...extra });
const manifestOf = (s) => JSON.parse(fs.readFileSync(path.join(s.outDir, 'voice.json'), 'utf8'));

fs.mkdirSync('C:/code/ForgeAi/output/agent-jobs/c4-remove-classic', { recursive: true });

test('the voice gets one feel per beat, same order and count as the scenes, and voice.json keeps what the factory said it used per sentence', async () => {
  const s = scratch(); const calls = [];
  try {
    await runCodebuiltVoice(voiceArgs(s, { beats: BEATS, postFactoryFn: fakeFactory({ calls }) }));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.scenes, BEATS.map((b) => b.narration));
    assert.deepEqual(calls[0].body.deliveries, ['curious', 'building', 'building', 'amazed']);
    const delivery = manifestOf(s).delivery;
    assert.equal(delivery.mode, 'beats');
    assert.deepEqual(delivery.sent, ['curious', 'building', 'building', 'amazed']);
    assert.equal(delivery.sentences.length, 6);
    assert.equal(delivery.sentences[0].tone, 'PLAIN, a touch of: curious');
    assert.equal(delivery.sentences.at(-1).tone, 'PLAIN, a touch of: amazed');
    assert.equal(delivery.sentences.at(-1).text, 'Nobody could believe it.');
    assert.ok(delivery.sentences.slice(1, 4).every((x) => x.tone === 'PLAIN, a touch of: building'));
    assert.equal(delivery.sentences[4].tone, 'PLAIN, a touch of: amazed');
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('nothing is invented: a factory that reports no sentences leaves sentences null, and an unknown or missing last feel is sent empty', async () => {
  const s = scratch(); const calls = [];
  const beats = BEATS.map((b, i) => ({ ...b, feel: i === 0 ? 'Curious ' : i === 1 ? 'sad' : i === 3 ? undefined : b.feel }));
  try {
    await runCodebuiltVoice(voiceArgs(s, { beats, postFactoryFn: fakeFactory({ withSentences: false, calls }) }));
    assert.deepEqual(calls[0].body.deliveries, ['curious', '', 'building', '']);
    const delivery = manifestOf(s).delivery;
    assert.equal(delivery.sentences, null);
    assert.deepEqual(delivery.sent, ['curious', '', 'building', '']);
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('beats that do not reproduce the script, or carry no feel at all, are voiced as before: one scene and no deliveries', async () => {
  for (const [name, beats] of [
    ['other words', BEATS.map((b, i) => (i === 2 ? { ...b, narration: 'Giant machines chewed the rock.' } : b))],
    ['no feel', BEATS.map(({ feel, ...rest }) => rest)],
  ]) {
    const s = scratch(); const calls = [];
    try {
      await runCodebuiltVoice(voiceArgs(s, { beats, postFactoryFn: fakeFactory({ calls }) }));
      assert.deepEqual(calls[0].body.scenes, [SCRIPT], name);
      assert.equal('deliveries' in calls[0].body, false, name);
      assert.equal(manifestOf(s).delivery.mode, 'single_scene', name);
    } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
  }
});

test('a caller that passes no beats sends the same request body as before', async () => {
  const s = scratch(); const calls = [];
  try {
    await runCodebuiltVoice(voiceArgs(s, { postFactoryFn: fakeFactory({ calls }) }));
    assert.deepEqual(Object.keys(calls[0].body), ['run_id', 'scenes', 'voice', 'timing_metadata', 'align_required', 'pace_gate_v1']);
    assert.deepEqual(calls[0].body.scenes, [SCRIPT]);
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('the stage refuses deliveries that do not match the scenes, and sends none when every one is empty', async () => {
  const s = scratch(); const calls = [];
  try {
    const base = { episodeDir: 'cb-e1', episodesRoot: s.episodesRoot, script: BEATS.map((b) => b.narration), voice: 'aiden', postFactoryFn: fakeFactory({ calls }) };
    await assert.rejects(runVoiceStage({ ...base, deliveries: ['amazed'] }), /deliveries/);
    assert.equal(calls.length, 0);
    await runVoiceStage({ ...base, deliveries: ['', '', '', ''] });
    assert.equal('deliveries' in calls[0].body, false);
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('a job hands the script shots to the voice step', async () => {
  const s = scratch(); fs.rmSync(path.join(s.root, 'episodes'), { recursive: true, force: true });
  let seen = null;
  try {
    const starter = createCodebuiltStarter({
      authorLoop: authorOptions(s.root), jobsDir: s.root, episodesRoot: path.join(s.root, 'episodes'), draftsDir: path.join(s.root, 'drafts'),
      scriptStage: async () => ({ script: SCRIPT, brief: '# brief', shots: BEATS, endingCheck: { status: 'degraded', reason: 'checker unavailable' }, pathPack: { id: 'codebuilt', skills: [] }, calls: [] }),
      composeRunner: async () => ({ runner: { run: async () => ({}) } }), visualLoop: false, // false: no Claude CLI probe in a test
      voiceStage: async (input) => { seen = input; throw new Error('stop here'); },
    });
    starter.start({ topic: 'A tunnel under the sea', duration: 30, voice: 'aiden' });
    await starter.idle();
    assert.equal(seen.script, SCRIPT);
    assert.deepEqual(seen.beats.map((b) => [b.narration, b.feel]), BEATS.map((b) => [b.narration, b.feel]));
    const staged = JSON.parse(fs.readFileSync(path.join(seen.outDir, 'script-meta.json'), 'utf8'));
    assert.deepEqual(staged.endingCheck, { status: 'degraded', reason: 'checker unavailable' });
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});
