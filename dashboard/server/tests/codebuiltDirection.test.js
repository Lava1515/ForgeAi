// The director's shot list decides where every cut of the video sits (2026-11-14). Real damage if it is wrong: a shot shorter than a
// viewer can read, a cut that is not on the recorded voice, or a build that silently drops a place.
import test from 'node:test';
import assert from 'node:assert/strict';
import { phrasesOf, checkDirection, directionShotStarts, fallbackDirection, DirectionError, MIN_DIRECTED_SHOT_S, MAX_DIRECTED_SHOT_S } from '../episode/codebuilt/direction.js';
import { validateBuildScript, parseModelJson } from '../episode/codebuilt/planner.js';

// 40 words, one every 0.5 s, a full stop after every fifth: eight phrases of 2.5 s.
const words = { dur: 20.3, words: Array.from({ length: 40 }, (_, i) => ({ w: `w${i}`, s: i * 0.5, e: i * 0.5 + 0.4, ...(i % 5 === 4 ? { punct: '.' } : {}) })) };
const phrases = phrasesOf(words, 0.35);
const videoSeconds = Math.trunc((words.dur + 0.35 + 1.5) * 30) / 30;
const place = (id) => ({ id, base: 'custom', what: 'a small town street at night', build: 'asphalt ground, a row of houses to the horizon, lamps, a tree, a night sky and a cool key light' });
const shot = (from, p) => ({ from, place: p, shows: 'the hero large in the middle of the frame', action: 'the hero walks toward the camera', camera: 'medium, slow push in', then: '', text: '', text_at: '' });
const reply = (shots, places = [place('street'), place('space')]) => JSON.stringify({ look: 'Navy, warm yellow and teal with a soft key light and a calm mood.', places, shots });
const check = checkDirection({ phrases, videoSeconds, setNames: ['globe'], parse: parseModelJson });

test('phrases end at punctuation and cover every word once, in order', () => {
  assert.equal(phrases.length, 8);
  assert.equal(phrases[0].start, 0.35);
  assert.deepEqual(phrases.map((p) => p.firstWord), [0, 5, 10, 15, 20, 25, 30, 35]);
});

test('a direction whose cuts sit on phrase starts is accepted and gives frame-aligned starts', () => {
  const d = check(reply([shot(0, 'street'), shot(2, 'space'), shot(4, 'street'), shot(6, 'space')]));
  const starts = directionShotStarts(d, phrases);
  assert.equal(starts[0], 0);
  assert.equal(starts.length, 4);
  for (let i = 1; i < starts.length; i += 1) assert.ok(Math.abs(starts[i] - phrases[d.shots[i].from].start) < 1 / 30 + 1e-9);
  assert.equal(d.narrations.join(' ').split(' ').length, 40);
});

test('too short, too long, out of order, unknown place and unused place are all refused with the reason', () => {
  assert.throws(() => check(reply([shot(0, 'street'), shot(1, 'space'), shot(2, 'street')])), (e) => e instanceof DirectionError && e.reasons.some((r) => r.includes(`longest allowed is ${MAX_DIRECTED_SHOT_S}`)));
  const tight = { dur: 20.3, words: words.words.map((w, i) => (i === 1 ? { ...w, punct: ',' } : w)) };
  const tightPhrases = phrasesOf(tight, 0.35);
  const tightCheck = checkDirection({ phrases: tightPhrases, videoSeconds, setNames: [], parse: parseModelJson });
  assert.throws(() => tightCheck(reply([shot(0, 'street'), shot(1, 'space'), shot(3, 'street'), shot(5, 'space'), shot(7, 'street')])), (e) => e.reasons.some((r) => r.includes(`shortest allowed is ${MIN_DIRECTED_SHOT_S}`)));
  assert.throws(() => check(reply([shot(0, 'street'), shot(4, 'space'), shot(2, 'street'), shot(6, 'space')])), DirectionError);
  assert.throws(() => check(reply([shot(0, 'street'), shot(2, 'moon'), shot(4, 'street'), shot(6, 'space')])), (e) => e.reasons.some((r) => r.includes('not one of the listed places')));
  assert.throws(() => check(reply([shot(0, 'street'), shot(2, 'street'), shot(4, 'street'), shot(6, 'street')])), (e) => e.reasons.some((r) => r.includes('never used')));
  assert.throws(() => check(reply([shot(2, 'street'), shot(4, 'space'), shot(6, 'street')])), (e) => e.reasons.some((r) => r.includes('first shot must start at phrase 0')));
});

test('the fallback direction needs no model and covers the whole narration', () => {
  const fb = fallbackDirection({ words, beats: [{ subject: 'a man on a street', action: 'he looks up', narration: 'x' }] });
  assert.equal(fb.direction.source, 'fallback');
  assert.equal(fb.shotStarts[0], 0);
  assert.equal(fb.direction.shots.length, fb.shotStarts.length);
  assert.equal(fb.direction.narrations.join(' ').split(' ').length, 40);
  assert.ok(new Set(fb.direction.shots.map((s) => s.place)).size >= 2);
});

test('a directed build must register every place; the per-shot collection rule no longer applies to it', () => {
  const src = "colls = {'place-street': a, 'place-space': b}\n";
  const missing = validateBuildScript(src, { nframes: 90, shotStarts: [0, 1, 2], places: ['street', 'space', 'pole'] });
  assert.ok(missing.some((r) => r.includes("place collection 'place-pole' is missing")));
  assert.ok(!missing.some((r) => /collection 'shot-\d+' is missing/.test(r)));
  const ok = validateBuildScript(src, { nframes: 90, shotStarts: [0, 1, 2], places: ['street', 'space'] });
  assert.ok(!ok.some((r) => r.includes('place collection')));
});
