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

test('unknown place, unused place and a reply without shots are refused with the reason', () => {
  assert.throws(() => check(reply([shot(0, 'street'), shot(2, 'moon'), shot(4, 'street'), shot(6, 'space')])), (e) => e.reasons.some((r) => r.includes('not one of the listed places')));
  assert.throws(() => check(reply([shot(0, 'street'), shot(2, 'street'), shot(4, 'street'), shot(6, 'street')])), (e) => e.reasons.some((r) => r.includes('never used')));
  assert.throws(() => check(reply([])), (e) => e instanceof DirectionError && e.reasons.some((r) => r.includes('found 0')));
  assert.throws(() => check(reply([shot(0, 'street'), { ...shot(2, 'space'), from: 'later' }])), (e) => e.reasons.some((r) => r.includes('must be a phrase number')));
});

test('timing slips are repaired on the phrase grid, not refused: too long, too short, out of order, late first shot', () => {
  const long = check(reply([shot(0, 'street'), shot(1, 'space'), shot(2, 'street')]));
  assert.ok(long.repairs.some((r) => r.includes('split')));
  const tight = { dur: 20.3, words: words.words.map((w, i) => (i === 1 ? { ...w, punct: ',' } : w)) };
  const tightPhrases = phrasesOf(tight, 0.35);
  const tightCheck = checkDirection({ phrases: tightPhrases, videoSeconds, setNames: [], parse: parseModelJson });
  const short = tightCheck(reply([shot(0, 'street'), shot(1, 'space'), shot(3, 'street'), shot(5, 'space'), shot(7, 'street')]));
  assert.deepEqual(short.repairs, ['shot 1 (from P0) lasted 1.4 s; shot 2 now starts at P2 instead of P1']);
  const order = check(reply([shot(0, 'street'), shot(4, 'space'), shot(2, 'street'), shot(6, 'space')]));
  assert.ok(order.repairs.some((r) => r.includes('not after shot 2')));
  const late = check(reply([shot(2, 'street'), shot(4, 'space'), shot(6, 'street')]));
  assert.equal(late.shots[0].from, 0);
  for (const [d, ph] of [[long, phrases], [short, tightPhrases], [order, phrases], [late, phrases]]) {
    assert.equal(d.source, 'director');
    const starts = d.shots.map((x) => (x.from === 0 ? 0 : ph[x.from].start));
    starts.forEach((st, k) => {
      if (k) assert.ok(d.shots[k].from > d.shots[k - 1].from);
      const len = (k + 1 < starts.length ? starts[k + 1] : videoSeconds) - st;
      assert.ok(len >= MIN_DIRECTED_SHOT_S - 1e-6 && len <= MAX_DIRECTED_SHOT_S + 1e-6, `shot ${k + 1} lasts ${len}`);
    });
    assert.equal(d.narrations.join(' ').split(' ').length, 40);
  }
  assert.equal(check(reply([shot(0, 'street'), shot(2, 'space'), shot(4, 'street'), shot(6, 'space')])).repairs, undefined);
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

// Review of 2026-11-14 (codex · gpt-6.1-sol): three findings that would have stopped real jobs.
import { directedShotRange, MAX_DIRECTED_SHOTS } from '../episode/codebuilt/direction.js';
import { pickPreviewFrames } from '../episode/codebuilt/previewFrames.js';

test('a direction can never have more shots than the visual check can preview', () => {
  for (const seconds of [30, 47, 62, 92, 100]) assert.ok(directedShotRange(seconds).max <= MAX_DIRECTED_SHOTS);
  const n = MAX_DIRECTED_SHOTS; const nframes = Math.round(n * 2.2 * 30);
  const frames = pickPreviewFrames({ nframes, shotStarts: Array.from({ length: n }, (_, i) => Math.round(i * 2.2 * 1000) / 1000) });
  assert.ok(frames.length <= 24);
});

test('twelve shots sharing three ready sets are not refused as too little scene', () => {
  const src = "a = city_street.build((0, 0, 0))\nb = globe.build((600, 0, 0))\nc = tunnel.build((1200, 0, 0))\ncolls = {'place-street': a, 'place-space': b, 'place-hole': c}\n";
  const why = validateBuildScript(src, { nframes: 1500, shotStarts: Array.from({ length: 12 }, (_, i) => i * 4), places: ['street', 'space', 'hole'] });
  assert.ok(!why.some((r) => r.startsWith('too little scene')), why.join('; '));
});

test('a long phrase of three words is split', () => {
  const w = { dur: 9, words: [{ w: 'a', s: 0, e: 3 }, { w: 'b', s: 3, e: 6 }, { w: 'c', s: 6, e: 9, punct: '.' }] };
  assert.ok(phrasesOf(w, 0.35).length >= 2);
});

// Bug that happened (2026-11-16, final panel finding A4): Baarle (job mwj5bu87-0a6f86) lost its director. Both replies were refused for one
// timing slip each ("shot 4: from must be larger than the shot before it", then "shot 2 (from P2) lasts 1.2 s") and the video was built on
// the fallback with placeholder places. The replies were not saved; these rebuild the two slips on Baarle's measured words.
import { planCodebuiltDirection } from '../episode/codebuilt/planner.js';
const BAARLE = [["Your",0,0.24],["couch",0.24,0.46],["is",0.48,0.74],["in",0.74,0.8],["Belgium",0.8,1.04,","],["but",1.84,1.84],["your",1.84,2.04],["television",2.04,2.42],["is",2.42,2.9],["in",2.9,3.04],["the",3.04,3.1],["Netherlands",3.1,3.56,"."],["Welcome",4.45,4.77],["to",4.77,5.01],["Baarle",5.01,5.65,","],["where",5.65,5.69],["the",5.69,5.85],["border",5.85,6.09],["zigzags",6.09,6.85],["straight",6.93,7.11],["through",7.15,7.39],["living",7.39,7.59],["rooms",7.59,7.99,"."],["Walk",8.58,8.8],["its",8.8,9.1],["streets",9.1,9.38],["and",9.38,9.58],["you",9.64,9.74],["step",9.74,9.94],["over",9.94,10.22],["white",10.22,10.48],["crosses",10.5,10.88],["set",10.88,11.24],["into",11.24,11.4],["the",11.4,11.56],["pavement",11.56,11.913,"."],["Each",12.753,12.753],["cross",12.753,13.073],["marks",13.073,13.353],["the",13.353,13.553],["frontier",13.553,14.253,","],["even",14.533,14.533],["where",14.533,14.793],["it",14.793,14.993],["slices",15.013,15.333],["through",15.333,15.713],["restaurant",15.713,16.093],["tables",16.093,16.553,"."],["So",17.53,17.55],["why",17.55,17.81],["is",17.81,18.03],["it",18.07,18.27],["such",18.27,18.55],["a",18.65,18.75],["tangle",18.75,19.119,"?"],["Because",19.849,19.849],["in",19.849,20.049],["the",20.049,20.149],["Middle",20.149,20.269],["Ages",20.269,20.569,","],["feudal",21.149,21.429],["dukes",21.429,21.709],["and",21.709,21.929],["lords",21.929,22.309],["swapped",22.389,22.649],["land",22.689,23.149],["plot",23.229,23.449],["by",23.529,23.749],["plot",23.749,23.989,"."],["Those",24.874,24.874],["swaps",24.874,25.334],["left",25.334,25.554],["twenty-two",25.634,26.154],["Belgian",26.154,26.494],["pieces",26.494,26.974],["surrounded",26.974,27.434],["by",27.434,27.794],["Dutch",27.794,28.054],["land",28.054,28.434,"."],["Inside",29.363,29.363],["some",29.363,29.723],["of",29.723,29.823],["them",29.823,30.043],["sit",30.043,30.243],["seven",30.243,30.663],["Dutch",30.663,31.003],["pieces",31.003,31.853,","],["countries",32.223,32.323],["nested",32.323,32.903],["in",32.903,33.103],["countries",33.103,33.503,"."],["Today",34.291,35.041,","],["a",35.061,35.121],["house's",35.121,35.481],["country",35.481,35.781],["is",35.781,36.061],["decided",36.061,36.401],["by",36.401,36.701],["its",36.761,36.861],["front",36.861,37.081],["door",37.081,37.357,"."],["But",37.877,38.057],["a",38.057,38.237],["white",38.237,38.417],["cross",38.437,38.777],["can",38.837,39.037],["run",39.037,39.297],["right",39.297,39.557],["across",39.597,39.857],["a",39.857,40.077],["doorway",40.077,40.457,"."],["So",41.038,41.318],["one",41.318,41.658],["small",41.658,42.018],["step",42.078,42.298],["takes",42.358,42.618],["you",42.618,42.878],["from",42.958,43.198],["Belgium",43.198,43.638],["into",43.638,44.098],["the",44.098,44.258],["Netherlands",44.258,44.678,"."]];
const baarleWords = { dur: 44.978, words: BAARLE.map(([w, s, e, punct]) => ({ w, s, e, ...(punct ? { punct } : {}) })) };
const mapPlace = (id) => ({ id, base: 'custom', what: 'a flat map of the Baarle border', build: 'a dark sea plane, the Belgian and Dutch land tiles with outlines, white border crosses, labels, a soft key light from above' });
const baarleReply = (froms) => JSON.stringify({ look: 'Dark blue sea, warm yellow Belgium, orange Netherlands, white borders, a soft even light and a curious mood.', places: [mapPlace('map'), mapPlace('street')], shots: froms.map((f, k) => shot(f, k % 2 ? 'street' : 'map')) });
const baarleDirect = (replies) => { let n = 0; return planCodebuiltDirection({ topic: 'Baarle', duration: 45, script: 'x', brief: 'y', words: baarleWords, pathPack: { id: 'codebuilt', skills: [], rules: { skillsByStep: {} } } }, { askFn: async () => replies[Math.min(n++, replies.length - 1)] }); };

test('Baarle: both refused directions are repaired and kept, not replaced by the fallback', async () => {
  // Reply 1: shots 3 and 4 both start at P4. Reply 2: shot 2 runs P2 to P3, 4.8 to 6.0 s.
  for (const [froms, needle] of [[[0, 2, 4, 4, 7, 9, 10, 12, 14, 16], 'shot 4 started at P4, not after shot 3 (P4); moved to P5'], [[0, 2, 3, 5, 7, 9, 10, 12, 14, 16], 'shot 2 (from P2) lasted 1.2 s; shot 3 now starts at P4 instead of P3']]) {
    const { direction, shotStarts, calls } = await baarleDirect([baarleReply(froms)]);
    assert.equal(direction.source, 'director');
    assert.equal(calls.length, 1);
    assert.ok(direction.repairs.includes(needle), direction.repairs.join(' | '));
    assert.equal(shotStarts.length, 10);
    assert.deepEqual(direction.places.map((p) => p.id), ['map', 'street']);
  }
});

test('an unusable direction still falls back, and says why', async () => {
  const { direction, calls } = await baarleDirect([JSON.stringify({ look: 'Dark blue sea and warm yellow land with a soft even light.', places: [mapPlace('map'), mapPlace('street')], shots: [] })]);
  assert.equal(calls.length, 2);
  assert.equal(direction.source, 'fallback');
  assert.match(direction.why, /refused twice/);
});
