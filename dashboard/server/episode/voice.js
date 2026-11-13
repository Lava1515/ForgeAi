// KAN-830: the Episode voice stage.
// Two ways to get a narration track, one timing file:
//  - local voice: the factory's /api/tts-timed with one allow-listed Qwen3 speaker id (never a Fish Speech or any "<engine>:<name>" id),
//  - owner recording: a WAV taken as-is (never a clone/reference voice), then the factory's /api/align gives the word timings.
// Both write voice.wav and timing.json into the Episode folder (same timing.json shape) after every check has passed:
//  - the folder is a real direct child of the episodes root (episode/artifacts.js; a symlink or junction is refused),
//  - files are temp + rename, one chain per folder (a second run waits for the first),
//  - timing words are what episode/cues.js expects: { text, start, end }, finite, ordered, one per script word.
// The state machine (KAN-824) has no voice stage yet; createVoiceEngine() is the adapter a later ticket can register.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { postFactory } from '../routes/factoryClient.js';
import { resolveEpisodeDir, atomicWrite, episodeRoot, EpisodeError } from './artifacts.js';

export const VOICE_VERSION = 'episode-voice-v1';
// The nine built-in Qwen3-TTS speakers, copied from QWEN_SPEAKERS in narrative_factory/tts_engine.py (a test keeps the two lists equal).
// KAN-801 (docs/model-licences.md): Qwen3-TTS is Apache-2.0 and allowed; Fish Speech is CC-BY-NC-SA and never reachable from here.
export const QWEN_SPEAKERS = Object.freeze(['aiden', 'dylan', 'eric', 'ono_anna', 'ryan', 'serena', 'sohee', 'uncle_fu', 'vivian']);
export const LIMITS = Object.freeze({
  wavBytes: 100 * 1024 * 1024,
  wavSeconds: 600,
  voiceIdChars: 32,
  scriptChars: 200000,
  scriptLines: 200,
  words: 200000, // the cues.js MAX_TOTAL_WORDS
  timingSlackSeconds: 0.5, // the aligner itself allows this much past the end
});

const SPEAKERS = new Set(QWEN_SPEAKERS);
const SHA = /^[0-9a-f]{64}$/;
const chains = new Map(); // one promise chain per real Episode folder

export class VoiceError extends Error {
  constructor(message) { super(`voice: ${message}`); this.name = 'VoiceError'; }
}
const fail = (message) => { throw new VoiceError(message); };
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const token = (value) => value.replace(/[^\p{L}\p{N}]/gu, '').toLocaleLowerCase('en'); // the same comparison cues.js makes
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const within = (root, target) => { const rel = path.relative(root, target); return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };

// ---- voice id: closed list, checked before any request ----
export function assertAllowedVoice(voice) {
  if (typeof voice !== 'string' || voice.length === 0 || voice.length > LIMITS.voiceIdChars) fail('voice id is not allowed');
  if (voice.includes(':') || voice.toLowerCase().startsWith('fish')) fail('voice id is not allowed');
  if (!/^[a-z0-9_]+$/.test(voice) || !SPEAKERS.has(voice)) fail('voice id is not allowed'); // exact, lower-case ASCII only
  return voice;
}

// ---- script ----
export function normaliseScript(script) {
  const lines = typeof script === 'string' ? [script] : script;
  if (!Array.isArray(lines) || !lines.length || lines.length > LIMITS.scriptLines) fail('script must be text or a list of lines');
  let chars = 0;
  for (const line of lines) {
    if (typeof line !== 'string' || !line.trim()) fail('script lines must be non-blank text');
    chars += line.length;
  }
  if (chars > LIMITS.scriptChars) fail('script is too long');
  const scenes = lines.map((line) => line.trim());
  const text = scenes.join(' ');
  const words = text.split(/\s+/);
  if (words.length > LIMITS.words) fail('script has too many words');
  return { scenes, text, words };
}

// ---- WAV: RIFF/WAVE, PCM, bounded; returns what the stage needs to know ----
export function inspectWav(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > LIMITS.wavBytes) fail('audio is not a valid WAV');
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') fail('audio is not a valid WAV');
  let fmt = null;
  let dataSize = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) fail('audio is not a valid WAV');
      fmt = { tag: bytes.readUInt16LE(body), channels: bytes.readUInt16LE(body + 2), rate: bytes.readUInt32LE(body + 4), byteRate: bytes.readUInt32LE(body + 8), align: bytes.readUInt16LE(body + 12), bits: bytes.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      dataSize = size;
      break; // PCM data is last for our purposes; anything after it is ignored
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || dataSize === null) fail('audio is not a valid WAV');
  const okFormat = fmt.tag === 1 && fmt.channels >= 1 && fmt.channels <= 8 && [8, 16, 24, 32].includes(fmt.bits)
    && fmt.rate >= 8000 && fmt.rate <= 192000 && fmt.align === fmt.channels * (fmt.bits / 8) && fmt.byteRate === fmt.rate * fmt.align;
  if (!okFormat) fail('audio is not a valid WAV');
  if (dataSize === 0 || offset + 8 + dataSize > bytes.length) fail('audio is not a valid WAV'); // empty or truncated
  const seconds = dataSize / fmt.byteRate;
  if (!Number.isFinite(seconds) || seconds <= 0) fail('audio is not a valid WAV');
  if (seconds > LIMITS.wavSeconds) fail('audio is too long');
  return { rate: fmt.rate, channels: fmt.channels, bits: fmt.bits, seconds };
}

// ---- timing words: the shape and checks episode/cues.js relies on ----
export function validateTimingWords(words, expectedWords, durationSeconds) {
  if (!Array.isArray(words) || words.length !== expectedWords.length) fail('timing words do not match the script');
  const out = [];
  let prevStart = 0;
  let prevEnd = 0;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (!isPlainObject(word) || typeof word.text !== 'string' || !word.text.trim()) fail('timing words do not match the script');
    const { start, end } = word;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) fail('timing words are not finite numbers');
    if (start < 0 || end < start || start < prevStart || end < prevEnd) fail('timing words are out of order');
    if (end > durationSeconds + LIMITS.timingSlackSeconds) fail('timing words run past the audio');
    if (token(word.text) !== token(expectedWords[i])) fail('timing words do not match the script');
    out.push({ text: word.text, start, end });
    prevStart = start;
    prevEnd = end;
  }
  return out;
}

// ---- Episode folder ----
function resolveFolder(episodeDir, root) {
  if (typeof episodeDir !== 'string' || !episodeDir || episodeDir.includes('\0')) fail('invalid Episode folder');
  const absolute = path.isAbsolute(episodeDir);
  const id = absolute ? path.basename(path.resolve(episodeDir)) : episodeDir;
  let real;
  try { real = resolveEpisodeDir(root, id); } catch (error) { if (error instanceof EpisodeError) fail('invalid Episode folder'); throw error; }
  let rootReal;
  try {
    rootReal = fs.realpathSync(root);
    if (absolute && fs.realpathSync(episodeDir) !== real) fail('invalid Episode folder'); // an absolute path must be that very folder
  } catch (error) { if (error instanceof VoiceError) throw error; fail('invalid Episode folder'); }
  if (!within(rootReal, real)) fail('invalid Episode folder');
  return real;
}

function writeInto(dir, name, data, fsApi) {
  const target = path.join(dir, name);
  let stat = null;
  try { stat = fs.lstatSync(target); } catch { /* not there yet */ }
  if (stat && !stat.isFile()) fail('an output file is blocked'); // never write through a link or over a folder
  atomicWrite(dir, name, data, fsApi);
}

function readOwnerWav(ownerWavPath) {
  if (typeof ownerWavPath !== 'string' || !ownerWavPath || ownerWavPath.includes('\0')) fail('owner audio path is invalid');
  let real;
  let fd;
  try {
    real = fs.realpathSync(ownerWavPath);
    const stat = fs.statSync(real);
    if (!stat.isFile()) fail('owner audio path is invalid');
    if (stat.size > LIMITS.wavBytes) fail('audio is too large'); // before anything is read
    fd = fs.openSync(real, 'r');
    const buffer = Buffer.alloc(stat.size);
    let done = 0;
    while (done < stat.size) {
      const n = fs.readSync(fd, buffer, done, stat.size - done, done);
      if (n === 0) break;
      done += n;
    }
    return buffer.subarray(0, done);
  } catch (error) {
    if (error instanceof VoiceError) throw error;
    return fail('owner audio could not be read');
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

function decodeAudio(b64) {
  const maxChars = 4 * Math.ceil(LIMITS.wavBytes / 3);
  if (typeof b64 !== 'string' || !b64 || b64.length > maxChars) fail('factory audio is missing or too large'); // before decoding
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > LIMITS.wavBytes) fail('factory audio is missing or too large');
  return bytes;
}

// ---- the stage ----
// Exactly one of `voice` (a Qwen3 speaker id) or `ownerWavPath`. Returns where the two files are.
export async function runVoiceStage({ episodeDir, episodesRoot = episodeRoot(), script, voice, ownerWavPath, postFactoryFn = postFactory, runId, fsApi = fs } = {}) {
  const hasVoice = voice !== undefined && voice !== null;
  const hasOwner = ownerWavPath !== undefined && ownerWavPath !== null;
  if (hasVoice === hasOwner) fail('give either a voice id or an owner recording');
  if (hasVoice) assertAllowedVoice(voice); // first: nothing else happens for a refused id
  if (typeof postFactoryFn !== 'function') fail('no factory client');
  const { scenes, text, words: expectedWords } = normaliseScript(script);
  const folder = resolveFolder(episodeDir, episodesRoot);

  const prior = chains.get(folder) || Promise.resolve();
  const run = prior.catch(() => {}).then(() => execute({ folder, scenes, text, expectedWords, voice: hasVoice ? voice : null, ownerWavPath: hasOwner ? ownerWavPath : null, postFactoryFn, runId, fsApi }));
  chains.set(folder, run);
  try { return await run; } finally { if (chains.get(folder) === run) chains.delete(folder); }
}

async function execute({ folder, scenes, text, expectedWords, voice, ownerWavPath, postFactoryFn, runId, fsApi }) {
  let audio;
  let answer;
  if (ownerWavPath !== null) {
    audio = readOwnerWav(ownerWavPath); // taken as-is: the bytes go to voice.wav untouched and are only ever aligned, never cloned
    inspectWav(audio);
    answer = await postFactoryFn('/api/align', { audio_b64: audio.toString('base64'), text, lang: 'en' });
  } else {
    answer = await postFactoryFn('/api/tts-timed', { run_id: runId || `episode_voice_${Date.now()}`, scenes, voice, timing_metadata: true, align_required: true });
    if (!isPlainObject(answer)) fail('factory answer is invalid');
    audio = decodeAudio(answer.audio_base64);
  }
  if (!isPlainObject(answer)) fail('factory answer is invalid');
  const info = inspectWav(audio);
  const audioSha = sha256(audio);
  if (answer.audio_sha256 !== undefined && answer.audio_sha256 !== audioSha) fail('factory timings belong to different audio');
  if (answer.word_timing_source !== 'aligned') fail('factory did not align the words');
  const words = validateTimingWords(answer.words, expectedWords, info.seconds);
  const timing = {
    version: 1,
    source: ownerWavPath !== null ? 'owner_wav' : 'local_tts',
    voice,
    word_timing_source: 'aligned',
    audio_file: 'voice.wav',
    audio_sha256: audioSha,
    timing_text_sha256: sha256(text),
    duration_s: Math.round(info.seconds * 1000) / 1000,
    words,
  };
  const timingText = `${JSON.stringify(timing, null, 2)}\n`;
  try { fs.unlinkSync(path.join(folder, 'timing.json')); } catch { /* none yet: a half-done run then shows no timing at all, never a stale one */ }
  writeInto(folder, 'voice.wav', audio, fsApi);
  writeInto(folder, 'timing.json', timingText, fsApi);
  return {
    voicePath: path.join(folder, 'voice.wav'), timingPath: path.join(folder, 'timing.json'),
    source: timing.source, voice, durationSeconds: timing.duration_s, wordCount: words.length, audioSha256: audioSha,
  };
}

// Adapter shaped like the other engines: async ({ stage, episode, inputs }) => { '<artifact>.json': value }.
// The script is the Shot Spec's lines; the voice choice is fixed when the engine is made. Not registered anywhere yet (the machine has no voice stage).
export function createVoiceEngine({ root, voice, ownerWavPath, postFactoryFn = postFactory } = {}) {
  const engine = async ({ episode, inputs }) => {
    const lines = inputs?.['spec.json']?.lines;
    if (!Array.isArray(lines)) fail('the Shot Spec has no lines');
    const result = await runVoiceStage({ episodeDir: episode.id, episodesRoot: root, script: lines.map((line) => line?.text), voice, ownerWavPath, postFactoryFn, runId: `episode_voice_${episode.id}` });
    return { 'voice.json': { audio: 'voice.wav', timing: 'timing.json', source: result.source, voice: result.voice, duration_s: result.durationSeconds, audio_sha256: result.audioSha256 } };
  };
  engine.version = VOICE_VERSION;
  return engine;
}
