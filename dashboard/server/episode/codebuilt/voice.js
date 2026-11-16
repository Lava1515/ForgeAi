// KAN-920 (CB11): voice for the code-built path.
// Turns the output of the ForgeAI Episode voice stage (KAN-830: voice.wav + timing.json) into the two files the engine kit reads:
//   vo.wav      the narration as the stage wrote it, except that silence after the last word beyond TAIL_KEEP_S is cut off (trimTailSilence; nothing else is re-encoded, trimmed or padded),
//   words.json  { "dur": seconds, "words": [ { "w", "s", "e", "punct"? } ] }  (blender_worker/codebuilt/timeline.py, post kit captions.py)
// plus voice.json, a manifest of what was checked (the kit ignores it).
//
// Word times are never made here. They come from the stage's aligner output (word_timing_source "aligned") and are then re-checked against the audio:
// the timing file must belong to this audio (sha256), this script (sha256 of the normalised text) and this duration, the times must be ordered and inside
// the audio, and the audio itself must carry sound where the words are (a timing that is merely spread over the script by letter count has no sound to match).
// Every failure throws CodebuiltVoiceError and nothing is written: fail closed.
//
// Lead and tail. The kit places vo.wav LEAD_S after the video start and holds TAIL_S after it ends (timeline.cue adds LEAD, timeline.frame_count adds LEAD + TAIL).
// So vo.wav itself must not add much silence of its own: the sound before the first word and after the last word is bounded (ONSET_MAX_S, TAIL_SILENCE_MAX_S),
// and a last word the aligner clipped short of the sound is extended (at most 1 s) to the audible end, and the TTS tail varies run to run, so trailing silence is trimmed to TAIL_KEEP_S after the last word before any check runs (the limits then apply to the trimmed audio),
// and voice.json records the resulting video length. A test keeps LEAD_S and TAIL_S equal to timeline.py.
//
// THE ONE SEAM for a different voice (CB0 voice choice is still open): VOICE_STAGES. A stage is
//   async ({ episodeDir, episodesRoot, script, voice, ownerWavPath, postFactoryFn, runId }) => { voicePath, timingPath }
// that leaves voice.wav and timing.json (same shape as episode/voice.js writes) in that Episode folder. A Kokoro option is added by registering a stage
// there; nothing else in this file changes. Only "episode" is registered now.
//
// E1b (endings that land): the script gives every shot a `feel`; given the shots as `beats`, the narrations become the scenes of the voice call and the
// feels their deliveries, same order and count (the factory keeps the hook's and the ending's, see narrative_factory/story_tone.py). voice.json then holds
// `delivery`: what was sent per beat and what the factory reported per sentence (its own words, never ours). Beats that do not reproduce the script
// word for word, or carry no feel, are voiced the old way (one scene, no deliveries) and say why.
//
// No process is started here. The factory client is injected (postFactoryFn); the default is the existing one, which reads TTS_TOKEN itself
// and is never given the token by this module. This module never prints or writes the token.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { postFactory } from '../../routes/factoryClient.js';
import { atomicWrite, sha256 } from '../artifacts.js';
import { runVoiceStage, inspectWav, normaliseScript, LIMITS as STAGE_LIMITS } from '../voice.js';

export const CODEBUILT_VOICE_VERSION = 'codebuilt-voice-v1';
// Mirror of LEAD and the default tail of frame_count in blender_worker/codebuilt/timeline.py (a test compares them).
export const LEAD_S = 0.35;
export const TAIL_S = 1.5;
export const LIMITS = Object.freeze({
  onsetMaxSeconds: 0.5, // silence inside vo.wav before the first word (video lead = LEAD_S + this at most)
  tailSilenceMaxSeconds: 1.0, // silence inside vo.wav after the last word
  endSlackSeconds: 0.02, // a word may not end later than the audio plus this
  audibleFloor: 0.01, // peak, as a fraction of full scale, that counts as sound (about -40 dBFS)
  audioToWordSlackSeconds: 0.25, // sound may start this much before the first word / end this much after the last
  minVoicedWordShare: 0.9, // share of words whose span holds sound
  estimateMinWords: 8,
  estimateSpread: 1.03, // all letters-per-second ratios within this factor of each other = timing spread by text length
  windowSeconds: 0.01,
  maxTextChars: 40,
  tailKeepSeconds: 0.3, // trailing silence kept after the last word when the tail is trimmed
  tailGuardSeconds: 0.1, // the trim never ends closer than this to the last audible sample
  firstWordExtendMaxSeconds: 0.5, // the aligner may have collapsed the first word: its start is moved back to the audible start by at most this much
  collapsedWordMaxSeconds: 0.06, // includes the diagnosed 60 ms first-word boundary
  leadSoundGapMaxSeconds: 0.1, // the sound before a collapsed first word must run up to it with no silent gap longer than this
  lastWordExtendMaxSeconds: 1.0, // the aligner may have clipped the last word: it is extended to the audible end by at most this much
  tailTrimMinSeconds: 0.1, // a tail is only cut when at least this much would go (a shorter tail is left byte for byte)
});
export const REASONS = Object.freeze(['invalid_input', 'bad_output_dir', 'voice_stage_failed', 'bad_voice_files', 'bad_timing_file', 'timing_not_measured', 'timing_mismatch', 'bad_word_times', 'estimated_timings', 'bad_lead', 'bad_tail', 'audio_not_matching', 'unknown_voice_option']);

export class CodebuiltVoiceError extends Error {
  constructor(reason, message, details = []) {
    super(`codebuilt-voice: ${String(message).slice(0, 400)}`);
    this.name = 'CodebuiltVoiceError';
    this.reason = reason;
    this.details = details;
  }
}
const reject = (reason, message, details) => { throw new CodebuiltVoiceError(reason, message, details); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round3 = (v) => Math.round(v * 1000) / 1000;
const token = (value) => String(value).replace(/[^\p{L}\p{N}]/gu, '').toLocaleLowerCase('en');

// ---- the script's feel per shot ----
// codex · gpt-6.1-sol · 2026-11-16 08:59 +02:00: S2 includes tension, fear, urgency, awe and humour.
export const FEELS = Object.freeze(['curious', 'intrigued', 'building', 'surprised', 'amazed', 'playful', 'satisfied', 'tense', 'worried', 'urgent', 'awed', 'funny']);
const feelOf = (value) => { const f = typeof value === 'string' ? value.trim().toLowerCase() : ''; return FEELS.includes(f) ? f : ''; };

/**
 * The scenes and deliveries for a voice call from the script's shots. { mode: 'beats', scenes, deliveries } when every beat has a narration, the
 * narrations joined are exactly the script, and at least one feel is a known word; otherwise { mode: 'single_scene', reason } and the caller voices the
 * script as before. A feel that is missing or unknown is sent as '' (the plain narrator): it is never replaced by a guess.
 */
export function planBeatDeliveries({ script, beats, ownerWavPath } = {}) {
  const single = (reason) => ({ mode: 'single_scene', reason });
  if (ownerWavPath !== undefined && ownerWavPath !== null) return single('owner_recording');
  if (!Array.isArray(beats) || !beats.length) return single('no_beats');
  if (!beats.every((b) => isObj(b) && typeof b.narration === 'string' && b.narration.trim())) return single('beat_without_narration');
  const scenes = beats.map((b) => b.narration.trim());
  try { if (normaliseScript(scenes).text !== normaliseScript(script).text) return single('beats_do_not_match_script'); } catch { return single('beats_do_not_match_script'); }
  const deliveries = beats.map((b) => feelOf(b.feel));
  if (!deliveries.some(Boolean)) return single('no_feel');
  return { mode: 'beats', scenes, deliveries };
}

// ---- the seam ----
export const VOICE_STAGES = Object.freeze({ episode: runVoiceStage });
export function selectVoiceStage(option = 'episode') {
  if (typeof option === 'function') return option;
  if (typeof option !== 'string' || !Object.hasOwn(VOICE_STAGES, option)) reject('unknown_voice_option', `voice option is not available: ${typeof option === 'string' ? option.slice(0, 32) : typeof option}`);
  return VOICE_STAGES[option];
}

// ---- words.json from the stage's timing words ----
const TRAIL = /[.,;:!?…—–\-)\]}"“”’']+$/u;
const LEAD_MARKS = /^[("“‘'\[{¿¡]+/u;
/** One script token as the stage timed it -> { w, punct } (trailing marks moved to punct, leading quotes dropped). A token with no letter or digit has no core. */
export function splitToken(text) {
  const raw = String(text).trim();
  if (!/[\p{L}\p{N}]/u.test(raw)) return { w: '', punct: raw };
  const stripped = raw.replace(LEAD_MARKS, '');
  const m = stripped.match(TRAIL);
  const w = (m ? stripped.slice(0, m.index) : stripped).trim();
  const punct = m ? m[0] : '';
  return { w, punct };
}

/** The kit's words list from timing words [{text,start,end}]. A mark-only token (for example a dash) joins the word before it and gets no time of its own. */
export function buildWordsList(timingWords) {
  const out = [];
  for (const t of timingWords) {
    const { w, punct } = splitToken(t.text);
    if (!w) {
      if (out.length && punct) out[out.length - 1].punct = (out[out.length - 1].punct || '') + punct;
      continue;
    }
    const entry = { w, s: round3(t.start), e: round3(t.end) };
    if (punct) entry.punct = punct;
    out.push(entry);
  }
  return out;
}

// ---- audio: what the file really holds ----
/** Where the PCM payload of a WAV that inspectWav accepted starts, and the size the header declares. */
function findData(bytes) {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'data') return { dataStart: offset + 8, dataSize: size };
    offset += 8 + size + (size % 2);
  }
  return reject('bad_voice_files', 'audio has no data');
}

/** Peak per 10 ms window as a fraction of full scale, over all channels. Needs a WAV that inspectWav accepted. */
export function windowPeaks(bytes, seconds = LIMITS.windowSeconds) {
  const info = inspectWav(bytes);
  const { dataStart, dataSize } = findData(bytes);
  const bytesPer = info.bits / 8;
  const frameBytes = bytesPer * info.channels;
  const frames = Math.floor(Math.min(dataSize, bytes.length - dataStart) / frameBytes);
  const perWindow = Math.max(1, Math.round(info.rate * seconds));
  const peaks = [];
  const sampleAt = (pos) => {
    if (info.bits === 8) return (bytes[pos] - 128) / 128;
    if (info.bits === 16) return bytes.readInt16LE(pos) / 32768;
    if (info.bits === 24) return bytes.readIntLE(pos, 3) / 8388608;
    return bytes.readInt32LE(pos) / 2147483648;
  };
  for (let f = 0; f < frames; f += perWindow) {
    let peak = 0;
    const end = Math.min(frames, f + perWindow);
    for (let i = f; i < end; i += 1) {
      for (let c = 0; c < info.channels; c += 1) {
        const v = Math.abs(sampleAt(dataStart + i * frameBytes + c * bytesPer));
        if (v > peak) peak = v;
      }
    }
    peaks.push(peak);
  }
  return { peaks, seconds, windowSeconds: perWindow / info.rate, info };
}

function audibleSpan(peaks, windowSeconds, floor) {
  let first = -1;
  let last = -1;
  for (let i = 0; i < peaks.length; i += 1) if (peaks[i] >= floor) { if (first < 0) first = i; last = i; }
  if (first < 0) return null;
  return { start: first * windowSeconds, end: (last + 1) * windowSeconds };
}

// ---- trimming the tail ----
/**
 * Cut the silence after the last word down to LIMITS.tailKeepSeconds. The TTS tail varies from run to run, and the kit already holds TAIL_S after the end, so dead air in
 * vo.wav only makes the finished video drag. Pure: takes the stage's wav + timing document, returns { wav, timing, trimmedSeconds }.
 *  - Only the end is cut. The kept part is every sample up to max(last word end + keep, last audible sample), so no word and no sound is cut, and the first sample stays the first sample.
 *  - A tail that is already short (less than tailTrimMinSeconds would go), a silent file, or timing that does not reach the audio is returned untouched (the same Buffer and the same object).
 *  - On a trim the header sizes are rewritten, and the timing document is a copy whose audio_sha256 and duration_s describe the trimmed audio. Words and the script hash are unchanged.
 * The caller has already checked that `timing` belongs to `wav`; the checks that decide pass or fail (bad_tail, bad_lead, audio_not_matching ...) run afterwards on the result.
 */
export function trimTailSilence({ wav, timing }) {
  if (!Buffer.isBuffer(wav) || !isObj(timing) || !Array.isArray(timing.words) || !timing.words.length) return { wav, timing, trimmedSeconds: 0 };
  let info;
  try { info = inspectWav(wav); } catch { return { wav, timing, trimmedSeconds: 0 }; }
  const lastEnd = Math.max(...timing.words.map((w) => (isObj(w) && isNum(w.end) ? w.end : 0)));
  if (!(lastEnd > 0)) return { wav, timing, trimmedSeconds: 0 };
  const { peaks, windowSeconds } = windowPeaks(wav);
  const span = audibleSpan(peaks, windowSeconds, LIMITS.audibleFloor);
  if (!span) return { wav, timing, trimmedSeconds: 0 }; // a silent file is for the checks to refuse
  const keepEnd = Math.max(lastEnd + LIMITS.tailKeepSeconds, span.end + LIMITS.tailGuardSeconds);
  const { dataStart, dataSize } = findData(wav);
  const frameBytes = (info.bits / 8) * info.channels;
  const frames = Math.floor(Math.min(dataSize, wav.length - dataStart) / frameBytes);
  const keepFrames = Math.ceil(keepEnd * info.rate);
  if ((frames - keepFrames) / info.rate < LIMITS.tailTrimMinSeconds) return { wav, timing, trimmedSeconds: 0 };
  const newSize = keepFrames * frameBytes;
  const pad = newSize % 2;
  const out = Buffer.alloc(dataStart + newSize + pad);
  wav.copy(out, 0, 0, dataStart + newSize);
  out.writeUInt32LE(newSize, dataStart - 4);
  out.writeUInt32LE(out.length - 8, 4);
  const trimmedInfo = inspectWav(out);
  return {
    wav: out,
    timing: { ...timing, audio_sha256: sha256(out), duration_s: round3(trimmedInfo.seconds) },
    trimmedSeconds: round3(info.seconds - trimmedInfo.seconds),
  };
}

// ---- a clipped last word ----
/**
 * The aligner sometimes ends the last word early while the voice is still sounding it (seen: 0.1 s long, sound 0.57 s longer). When the audible end of the audio is later than the
 * last word's end by more than the slack the checker allows (so the checks would refuse it) but by no more than lastWordExtendMaxSeconds, only that word's end is moved to the
 * audible end. Pure: returns { timing, extendedSeconds }; the same object and 0 when nothing changes. It never shortens, never touches another word, and sound further out stays for
 * audio_not_matching to refuse. Everything else (onset, tail limit, voiced share, sha, text and duration binding) is checked afterwards, unchanged.
 */
export function extendClippedLastWord({ wav, timing }) {
  if (!Buffer.isBuffer(wav) || !isObj(timing) || !Array.isArray(timing.words) || !timing.words.length) return { timing, extendedSeconds: 0 };
  const index = timing.words.length - 1;
  const last = timing.words[index];
  if (!isObj(last) || !isNum(last.end)) return { timing, extendedSeconds: 0 };
  let span;
  try { const { peaks, windowSeconds } = windowPeaks(wav); span = audibleSpan(peaks, windowSeconds, LIMITS.audibleFloor); } catch { return { timing, extendedSeconds: 0 }; }
  if (!span) return { timing, extendedSeconds: 0 };
  const excess = span.end - last.end;
  if (excess <= LIMITS.audioToWordSlackSeconds || excess > LIMITS.lastWordExtendMaxSeconds) return { timing, extendedSeconds: 0 };
  const words = timing.words.map((w, i) => (i === index ? { ...w, end: round3(span.end) } : w));
  return { timing: { ...timing, words }, extendedSeconds: round3(span.end - last.end) };
}

// ---- a collapsed first word ----
/**
 * The aligner sometimes collapses the first word to zero length after the voice has already said it (job mwgt0zmz-c75642, 2026-11-14:
 * "Venice" at 0.40-0.40 s with sound from 0.02 s, on two takes with different seeds). The mirror of extendClippedLastWord: when the audible
 * start is earlier than the first word's start by more than the checker's slack but by no more than firstWordExtendMaxSeconds, only that word's
 * start moves to the audible start. Only with evidence of the collapse: the word is shorter than collapsedWordMaxSeconds and the sound runs from
 * the audible start up to it without a silent gap over leadSoundGapMaxSeconds, so a detached click or extra utterance before the voice is still
 * refused. Pure: the same object and 0 when nothing changes. It never moves a start later and never touches another word.
 */
export function extendClippedFirstWord({ wav, timing }) {
  if (!Buffer.isBuffer(wav) || !isObj(timing) || !Array.isArray(timing.words) || !timing.words.length) return { timing, extendedSeconds: 0 };
  const first = timing.words[0];
  if (!isObj(first) || !isNum(first.start) || !isNum(first.end) || first.end - first.start > LIMITS.collapsedWordMaxSeconds + 1e-9) return { timing, extendedSeconds: 0 };
  let span; let peaks; let windowSeconds;
  try { ({ peaks, windowSeconds } = windowPeaks(wav)); span = audibleSpan(peaks, windowSeconds, LIMITS.audibleFloor); } catch { return { timing, extendedSeconds: 0 }; }
  if (!span) return { timing, extendedSeconds: 0 };
  const early = first.start - span.start;
  if (early <= LIMITS.audioToWordSlackSeconds || early > LIMITS.firstWordExtendMaxSeconds) return { timing, extendedSeconds: 0 };
  let gap = 0;
  for (let k = Math.floor(span.start / windowSeconds); k < Math.floor(first.start / windowSeconds) && k < peaks.length; k += 1) {
    gap = peaks[k] >= LIMITS.audibleFloor ? 0 : gap + windowSeconds;
    if (gap > LIMITS.leadSoundGapMaxSeconds) return { timing, extendedSeconds: 0 };
  }
  const words = timing.words.map((w, i) => (i === 0 ? { ...w, start: round3(span.start) } : w));
  return { timing: { ...timing, words }, extendedSeconds: round3(early) };
}

// ---- the checker ----
/** True when the word times look spread over the text by letter count (no real alignment): every letters-per-second ratio is almost the same, or the words tile the audio with no gap from 0 to the end. */
export function looksEstimated(words, durationSeconds) {
  if (words.length < LIMITS.estimateMinWords) return false;
  const ratios = words.map((w) => (w.e - w.s) / Math.max(1, token(w.w).length));
  if (ratios.every((r) => r > 0)) {
    const lo = Math.min(...ratios);
    const hi = Math.max(...ratios);
    if (hi / lo <= LIMITS.estimateSpread) return true;
  }
  let tiled = words[0].s === 0 && Math.abs(words[words.length - 1].e - durationSeconds) < 0.005;
  for (let i = 1; tiled && i < words.length; i += 1) if (Math.abs(words[i].s - words[i - 1].e) > 0.0005) tiled = false;
  return tiled;
}

/**
 * Check the kit files. `wav` is a Buffer, `doc` is the words.json object, `scriptWords` the whitespace-split approved script (optional but required for a real run).
 * Returns { ok: true, metrics } or throws CodebuiltVoiceError. Fail closed: any problem throws.
 */
export function checkVoiceFiles({ wav, doc, scriptWords, source }) {
  if (!Buffer.isBuffer(wav)) reject('bad_voice_files', 'vo.wav is not a buffer');
  let info;
  try { info = inspectWav(wav); } catch { reject('bad_voice_files', 'vo.wav is not a valid WAV'); }
  const dur = info.seconds;
  if (!isObj(doc) || !Array.isArray(doc.words) || !doc.words.length) reject('bad_voice_files', 'words.json needs a dur and a words list');
  if (!isNum(doc.dur) || doc.dur <= 0 || Math.abs(doc.dur - dur) > 0.01) reject('timing_mismatch', 'words.json dur is not the length of vo.wav', [{ dur: doc.dur, audio: dur }]);
  if (doc.words.length > STAGE_LIMITS.words) reject('bad_voice_files', 'too many words');
  if (source !== 'aligned') reject('timing_not_measured', 'word times were not produced by an aligner');
  let prevS = 0;
  let prevE = 0;
  const problems = [];
  doc.words.forEach((w, i) => {
    if (!isObj(w) || typeof w.w !== 'string' || !w.w.trim() || w.w.length > LIMITS.maxTextChars || !/[\p{L}\p{N}]/u.test(w.w)) { problems.push({ i, problem: 'bad word' }); return; }
    if (!isNum(w.s) || !isNum(w.e)) { problems.push({ i, problem: 'not a finite number' }); return; }
    if (w.s < 0 || w.e < w.s) problems.push({ i, problem: 'negative or reversed' });
    else if (w.s < prevS || w.e < prevE) problems.push({ i, problem: 'out of order' });
    if (w.e > dur + LIMITS.endSlackSeconds) problems.push({ i, problem: 'past the end of the audio' });
    prevS = w.s; prevE = w.e;
  });
  if (problems.length) reject('bad_word_times', `${problems.length} word time(s) are invalid`, problems.slice(0, 10));
  if (Array.isArray(scriptWords)) {
    const expected = scriptWords.map(splitToken).filter((t) => t.w);
    if (expected.length !== doc.words.length) reject('timing_mismatch', 'words do not match the script', [{ script: expected.length, words: doc.words.length }]);
    const bad = expected.findIndex((t, i) => token(t.w) !== token(doc.words[i].w));
    if (bad >= 0) reject('timing_mismatch', 'words do not match the script', [{ i: bad }]);
  }
  if (looksEstimated(doc.words, dur)) reject('estimated_timings', 'word times look spread by text length, not measured');
  const first = doc.words[0];
  const last = doc.words[doc.words.length - 1];
  if (first.s > LIMITS.onsetMaxSeconds) reject('bad_lead', `silence before the first word is ${round3(first.s)} s, the limit is ${LIMITS.onsetMaxSeconds} s`);
  const tailSilence = dur - last.e;
  if (tailSilence > LIMITS.tailSilenceMaxSeconds) reject('bad_tail', `silence after the last word is ${round3(tailSilence)} s, the limit is ${LIMITS.tailSilenceMaxSeconds} s`);
  // The sound has to be where the words say it is.
  const { peaks, windowSeconds } = windowPeaks(wav);
  const span = audibleSpan(peaks, windowSeconds, LIMITS.audibleFloor);
  if (!span) reject('audio_not_matching', 'vo.wav holds no sound');
  const slack = LIMITS.audioToWordSlackSeconds;
  if (span.start < first.s - slack) reject('audio_not_matching', `sound starts at ${round3(span.start)} s, before the first word at ${round3(first.s)} s`);
  if (span.start > first.s + slack) reject('audio_not_matching', `sound starts at ${round3(span.start)} s, after the first word at ${round3(first.s)} s`);
  if (span.end > last.e + slack) reject('audio_not_matching', `sound runs to ${round3(span.end)} s, past the last word at ${round3(last.e)} s`);
  if (span.end < last.e - slack) reject('audio_not_matching', `sound stops at ${round3(span.end)} s, before the last word at ${round3(last.e)} s`);
  let voiced = 0;
  for (const w of doc.words) {
    const a = Math.floor(w.s / windowSeconds);
    const b = Math.max(a + 1, Math.ceil(w.e / windowSeconds));
    let heard = false;
    for (let k = a; k < b && k < peaks.length; k += 1) if (peaks[k] >= LIMITS.audibleFloor) { heard = true; break; }
    if (heard) voiced += 1;
  }
  const share = voiced / doc.words.length;
  if (share < LIMITS.minVoicedWordShare) reject('audio_not_matching', `only ${Math.round(share * 100)}% of the words have sound under them`);
  return {
    ok: true,
    metrics: {
      duration_s: round3(dur), words: doc.words.length, onset_s: round3(first.s), tail_silence_s: round3(tailSilence),
      audible_start_s: round3(span.start), audible_end_s: round3(span.end), voiced_word_share: round3(share),
      lead_s: LEAD_S, tail_s: TAIL_S, video_seconds: round3(dur + LEAD_S + TAIL_S),
    },
  };
}

// ---- reading the stage's output ----
function readRegular(file, maxBytes) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { reject('bad_voice_files', 'a voice stage file is missing'); }
  if (!stat.isFile()) reject('bad_voice_files', 'a voice stage file is not a plain file'); // not a link, not a folder
  if (stat.size > maxBytes) reject('bad_voice_files', 'a voice stage file is too large');
  return fs.readFileSync(file);
}

/**
 * Read voice.wav + timing.json (the stage's files) and turn them into the kit files, with every check. Pure apart from reading the two files.
 * Returns { wav, doc, manifest, metrics }; nothing is written.
 */
export function convertStageOutput({ voicePath, timingPath, script }) {
  if (typeof voicePath !== 'string' || typeof timingPath !== 'string' || !voicePath || !timingPath) reject('invalid_input', 'voicePath and timingPath are required');
  let normalised;
  try { normalised = normaliseScript(script); } catch (error) { reject('invalid_input', error.message); }
  let wav = readRegular(voicePath, STAGE_LIMITS.wavBytes);
  let timing;
  try { timing = JSON.parse(readRegular(timingPath, 64 * 1024 * 1024).toString('utf8')); } catch (error) { if (error instanceof CodebuiltVoiceError) throw error; reject('bad_timing_file', 'timing.json is not valid JSON'); }
  if (!isObj(timing) || timing.version !== 1 || !Array.isArray(timing.words)) reject('bad_timing_file', 'timing.json is not the voice stage format');
  if (timing.word_timing_source !== 'aligned') reject('timing_not_measured', 'timing.json does not say the words were aligned');
  if (timing.audio_sha256 !== sha256(wav)) reject('timing_mismatch', 'timing.json belongs to different audio');
  if (timing.timing_text_sha256 !== sha256(normalised.text)) reject('timing_mismatch', 'timing.json belongs to a different script');
  let info;
  try { info = inspectWav(wav); } catch { reject('bad_voice_files', 'voice.wav is not a valid WAV'); }
  if (!isNum(timing.duration_s) || Math.abs(timing.duration_s - info.seconds) > 0.01) reject('timing_mismatch', 'timing.json duration is not the length of voice.wav');
  if (timing.words.length !== normalised.words.length) reject('timing_mismatch', 'timing words do not match the script');
  if (!timing.words.every((w) => isObj(w) && typeof w.text === 'string' && isNum(w.start) && isNum(w.end))) reject('bad_word_times', 'timing words are malformed');
  // The timing is now known to belong to this audio and script. Cut the trailing silence, then check the result exactly as strictly as an untrimmed one.
  const trimmed = trimTailSilence({ wav, timing });
  wav = trimmed.wav;
  timing = trimmed.timing;
  if (trimmed.trimmedSeconds > 0) {
    try { info = inspectWav(wav); } catch { reject('bad_voice_files', 'trimmed voice.wav is not a valid WAV'); }
    if (timing.audio_sha256 !== sha256(wav) || Math.abs(timing.duration_s - info.seconds) > 0.01) reject('timing_mismatch', 'timing.json does not describe the trimmed audio');
  }
  const extended = extendClippedLastWord({ wav, timing });
  timing = extended.timing;
  const extendedFirst = extendClippedFirstWord({ wav, timing });
  timing = extendedFirst.timing;
  const doc = { dur: round3(info.seconds), words: buildWordsList(timing.words) };
  // dur must be the exact file length for the kit; round3 can differ from the file by under 0.5 ms, well inside the 10 ms check.
  const { metrics: checked } = checkVoiceFiles({ wav, doc, scriptWords: normalised.words, source: timing.word_timing_source });
  const metrics = { ...checked, tail_trimmed_s: trimmed.trimmedSeconds, last_word_extended_s: extended.extendedSeconds, first_word_extended_s: extendedFirst.extendedSeconds };
  const manifest = {
    version: CODEBUILT_VOICE_VERSION, source: timing.source, voice: timing.voice ?? null, word_timing_source: 'aligned',
    audio_file: 'vo.wav', audio_sha256: sha256(wav), words_file: 'words.json', script_sha256: sha256(normalised.text), ...metrics,
  };
  return { wav, doc, manifest, metrics };
}

// ---- writing ----
export function resolveJobDir(outDir, allowedRoot = defaultJobsRoot()) {
  if (typeof outDir !== 'string' || !outDir || outDir.includes('\0') || !path.isAbsolute(outDir)) reject('bad_output_dir', 'output folder must be an absolute path');
  let real;
  let rootReal;
  try {
    if (!fs.lstatSync(outDir).isDirectory()) reject('bad_output_dir', 'output folder is not a plain folder'); // false for a link or a junction
    real = fs.realpathSync(outDir);
    rootReal = fs.realpathSync(allowedRoot);
  } catch (error) { if (error instanceof CodebuiltVoiceError) throw error; reject('bad_output_dir', 'output folder does not exist'); }
  const rel = path.relative(rootReal, real);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) reject('bad_output_dir', 'output folder is outside the job folders');
  return real;
}
export function defaultJobsRoot() {
  const repo = process.env.FORGEAI_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  return path.join(repo, 'output', 'agent-jobs');
}

function writeFile(dir, name, data) {
  const target = path.join(dir, name);
  let stat = null;
  try { stat = fs.lstatSync(target); } catch { /* not there yet */ }
  if (stat && !stat.isFile()) reject('bad_output_dir', 'an output file is blocked'); // never write through a link or over a folder
  atomicWrite(dir, name, data);
}

/** Write vo.wav, voice.json and words.json (last: it is the file that says the set is complete) into an existing job folder. Only after every check has passed. */
export function writeVoiceFiles({ outDir, allowedRoot, result }) {
  const dir = resolveJobDir(outDir, allowedRoot);
  for (const name of ['words.json', 'voice.json']) {
    const target = path.join(dir, name);
    let stat = null;
    try { stat = fs.lstatSync(target); } catch { /* none yet */ }
    if (stat && !stat.isFile()) reject('bad_output_dir', 'an output file is blocked');
    if (stat) fs.unlinkSync(target); // a half-done run then shows no words.json at all, never a stale one
  }
  writeFile(dir, 'vo.wav', result.wav);
  writeFile(dir, 'voice.json', `${JSON.stringify(result.manifest, null, 2)}\n`);
  writeFile(dir, 'words.json', `${JSON.stringify(result.doc, null, 1)}\n`);
  return { voPath: path.join(dir, 'vo.wav'), wordsPath: path.join(dir, 'words.json'), manifestPath: path.join(dir, 'voice.json') };
}

/**
 * The callable: approved script text -> vo.wav + words.json in `outDir`.
 *  script       approved script text (string or list of lines, as the stage takes it)
 *  beats        optional, the script's shots [{ narration, feel }]: see planBeatDeliveries
 *  voice        a voice id the chosen stage accepts (episode stage: one Qwen3 speaker id); or ownerWavPath
 *  outDir       an existing folder under output/agent-jobs (absolute)
 *  episodeDir   the Episode folder the stage writes into (its own scratch place; the stage checks it lives under episodesRoot)
 *  voiceOption  'episode' (default) or a stage function (the seam)
 *  postFactoryFn injected factory client; the default reads TTS_TOKEN from the environment itself
 */
export async function runCodebuiltVoice({ script, beats, voice, ownerWavPath, outDir, allowedRoot, episodeDir, episodesRoot, voiceOption = 'episode', postFactoryFn = postFactory, runId, onCall, now = Date.now } = {}) {
  const stage = selectVoiceStage(voiceOption);
  resolveJobDir(outDir, allowedRoot); // refuse a bad destination before any request is made
  const plan = planBeatDeliveries({ script, beats, ownerWavPath });
  let staged;
  const started = now();
  // KAN-932: the factory TTS and alignment time is a cost line (no tokens). A recorder failure never changes the voice result.
  const record = (status) => {
    if (typeof onCall !== 'function') return;
    try { onCall({ step: 'voice', provider: 'factory', model: typeof voice === 'string' && voice ? voice : null, wall_s: Math.round(Math.max(0, now() - started)) / 1000, input_tokens: null, output_tokens: null, status }); } catch { /* ignore */ }
  };
  try { staged = await stage({ episodeDir, episodesRoot, script: plan.mode === 'beats' ? plan.scenes : script, voice, ownerWavPath, postFactoryFn, runId, ...(plan.mode === 'beats' ? { deliveries: plan.deliveries } : {}) }); record('ok'); }
  catch (error) { record('error'); reject('voice_stage_failed', `voice stage failed: ${error?.message ? error.message : 'unknown error'}`); }
  if (!isObj(staged)) reject('voice_stage_failed', 'voice stage returned nothing');
  const result = convertStageOutput({ voicePath: staged.voicePath, timingPath: staged.timingPath, script });
  // What the voice was told, as the factory reported it: the stage returns the factory's own per-sentence list (null when it gave none).
  result.manifest.delivery = {
    mode: plan.mode, ...(plan.mode === 'single_scene' ? { reason: plan.reason } : {}),
    scenes: plan.mode === 'beats' ? plan.scenes.length : 1,
    sent: plan.mode === 'beats' ? plan.deliveries : null,
    sentences: Array.isArray(staged.sentences) ? staged.sentences : null,
  };
  const files = writeVoiceFiles({ outDir, allowedRoot, result });
  return { ...files, metrics: result.metrics };
}
