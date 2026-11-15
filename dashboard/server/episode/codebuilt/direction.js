// Direction step (2026-11-14): the shot list a director writes AFTER the narration is recorded, the way the chat-built shorts were
// planned (C:/code/output/shorts-playbook/BRIEF-earth-stop.md): a few places built once, and shots that cut on phrase boundaries of
// the measured voice, each with what is on screen, what moves and how the camera moves. Before this step the cuts were placed by
// arithmetic on word starts and every shot got its own unrelated set (13 sets in a 55 s video; job mwfoupp9-07ab7d).
//
//   phrasesOf(words)                         -> [{ i, start, end, text }]   speech phrases in VIDEO seconds (lead included)
//   directionPrompt({...})                   -> the prompt
//   checkDirection({ phrases, nframes })     -> (replyText) => direction      throws DirectionError with the reasons
//   directionShotStarts(direction, phrases)  -> start seconds, first 0, one per shot (same grid as cadence.js)
//   directionMarkdown(direction, starts, s)  -> the "## Direction" block the build model and the look model read
//   fallbackDirection({ words, shots })      -> a direction made without a model call (arithmetic cuts, the script's own beats)
//
// Pure: no model call, no file, no clock. planner.js makes the call.
import { startSecondsForFrame, planShotCadence } from './cadence.js';

export const DIRECTION_VERSION = 'codebuilt-direction-v1';
export const MIN_DIRECTED_SHOT_S = 2.2;
export const MAX_DIRECTED_SHOT_S = 8;
export const TARGET_DIRECTED_SHOT_S = 5;
export const MAX_PHRASE_S = 3.6;
export const PAUSE_BREAK_S = 0.3;
export const MIN_PLACES = 2;
export const MAX_PLACES = 5;
// The visual check previews at most 24 frames and every shot needs its own, plus one for the opening and one for the ending
// (previewFrames.js): more than 22 shots could never be looked at, so a direction may not have more.
export const MAX_DIRECTED_SHOTS = 22;
const PLACE_ID = /^[a-z][a-z0-9]{1,15}$/;
const FPS = 30;

export class DirectionError extends Error {
  constructor(message, reasons) { super(message); this.name = 'DirectionError'; this.code = 'BAD_DIRECTION'; this.reasons = Array.isArray(reasons) ? reasons : [message]; }
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Speech phrases: runs of measured words that end at punctuation or at a pause, and never longer than MAX_PHRASE_S (a long run is
 * split at its largest inner gap, else in the middle). Times are video seconds (word time + lead). A cut may sit only on a phrase start.
 */
export function phrasesOf(words, lead = 0.35) {
  const list = Array.isArray(words?.words) ? words.words : [];
  const runs = [];
  let current = [];
  list.forEach((w, k) => {
    current.push(k);
    const next = list[k + 1];
    const pause = next ? next.s - w.e : 0;
    if (!next || (typeof w.punct === 'string' && w.punct) || pause >= PAUSE_BREAK_S) { runs.push(current); current = []; }
  });
  if (current.length) runs.push(current);
  const split = (run) => {
    const dur = list[run.at(-1)].e - list[run[0]].s;
    if (dur <= MAX_PHRASE_S || run.length < 2) return [run];
    let at = Math.max(1, Math.floor(run.length / 2)); let best = -1;
    for (let j = 1; j < run.length; j += 1) {
      const gap = list[run[j]].s - list[run[j - 1]].e;
      const balance = 1 - Math.abs(j / run.length - 0.5);
      const score = gap * 4 + balance;
      if (score > best) { best = score; at = j; }
    }
    return [...split(run.slice(0, at)), ...split(run.slice(at))];
  };
  return runs.flatMap(split).map((run, i) => ({
    i,
    start: round3(list[run[0]].s + lead),
    end: round3(list[run.at(-1)].e + lead),
    text: run.map((k) => `${list[k].w}${typeof list[k].punct === 'string' ? list[k].punct : ''}`).join(' '),
    firstWord: run[0],
  }));
}

/** How many shots a video of `seconds` should have: about one per TARGET_DIRECTED_SHOT_S, inside what the length limits allow. */
export function directedShotRange(seconds) {
  const s = Number(seconds);
  const min = Math.max(1, Math.ceil(s / MAX_DIRECTED_SHOT_S - 1e-9));
  const max = Math.max(min, Math.min(MAX_DIRECTED_SHOTS, Math.floor(s / MIN_DIRECTED_SHOT_S + 1e-9)));
  return { min, max, target: Math.max(min, Math.min(max, Math.round(s / TARGET_DIRECTED_SHOT_S))) };
}

export function directionPrompt({ topic, duration, script, brief, beats = [], phrases, videoSeconds, setManual, propsManual, guides = '', choicesText = '' }) {
  const range = directedShotRange(videoSeconds);
  const phraseLines = phrases.map((p) => `P${p.i} [${p.start.toFixed(2)}-${p.end.toFixed(2)} s] ${JSON.stringify(p.text)}`).join('\n');
  const beatLines = beats.length ? beats.map((b, i) => `${i + 1}. ${String(b.narration ?? '').slice(0, 160)} -> ${String(b.subject ?? '').slice(0, 200)}; ${String(b.action ?? '').slice(0, 200)}`).join('\n') : '(none)';
  return `You are the director of a ${duration}-second vertical (9:16) 3D explainer short. The narration is already recorded. Every picture will be built from Blender Python code by a programmer who follows your shot list exactly, so write what must be SEEN, concretely enough to build.
Topic: ${JSON.stringify(topic)}
${choicesText}Narration: ${JSON.stringify(script)}
The writer's idea of the look: ${String(brief).slice(0, 1500)}
The writer's rough visual beats (a starting point; improve them):
${beatLines}

The recorded narration as phrases with their measured times in the video (${videoSeconds.toFixed(2)} s in total, the picture runs about 1.5 s after the last word):
${phraseLines}

WHAT YOU DECIDE
1. PLACES. ${MIN_PLACES} to ${MAX_PLACES} places for the whole video. A place is a complete location built once and reused by several shots with a new camera and new action (the good shorts of this channel had 3 to 4 places for 8 shots). Each place must belong to THIS topic: do not use a place only because it exists in the library. A place is either one of the ready sets below, or "custom". A ready set comes exactly as described, with its own daylight and props: choose one only when the story needs that very location as it is. When you need another time of day (night, sunset), another mood, or anything the set does not have, make the place custom, and for most topics most places are custom. For a custom place say what it is made of (ground or floor, what stands behind the action up to the horizon or the far wall, 4 to 8 props around the subject, one landmark, the sky or ceiling, the light and time of day).
2. SHOTS. About ${range.target} shots (${range.min} to ${range.max}). Each shot starts at the start of a phrase (give its number in "from") and runs to the next shot; the first shot starts at P0. Each shot lasts ${MIN_DIRECTED_SHOT_S} to ${MAX_DIRECTED_SHOT_S} seconds. Cut where the narration moves to a new idea, not in the middle of one.
3. For every shot: the place; what the viewer sees (the subject, LARGE: it fills a third to two thirds of the frame height, in the middle of the frame); what visibly happens during the shot (something must move or change in every shot: a character acts, an object travels, grows, breaks, lights up); the camera (where it starts and how it moves: push in, pull back, orbit, crane up, follow, whip to; say close, medium or wide); for a shot longer than 4 s a second beat ("then": the view or the action changes again); an optional short on-screen readout (a number or 1 to 3 words, shown when a named narration word is spoken).
4. Neighbouring shots must differ in framing (wide then close, low then high, front then side). The first shot shows the question of the video inside the first second. The last shot resolves the story or returns to the opening picture; its final second holds on that finished picture with the subject in frame (the camera never drifts off into empty space).
5. Keep one recurring character or object through the video when the story allows it (the same person, the same planet), so the shots read as one story.

READY SETS (each is a complete location; the full details are given to the programmer):
${setManual}

READY PROPS for custom places (the programmer has these as one call each):
${propsManual}
The programmer can also build any other object from spheres, boxes, lathes and swept tubes. Simple people are available (a stretched-sphere figure 1.8 m tall that can stand, walk, wave, fall and tumble); a face in close-up is not, so do not plan facial acting.

${guides ? `GUIDANCE FOR THIS STEP (project skills):\n${guides}\n\n` : ''}Reply with ONE JSON object and nothing else:
{"look": "2 to 3 sentences: the palette (name 3 to 5 colours), the light and the mood, the same for the whole video",
 "places": [{"id": "short lowercase word", "base": "custom" or the name of a ready set, "what": "what this place is, in one sentence", "build": "what it is made of: ground, backdrop to the horizon, props, landmark, sky, light"}],
 "shots": [{"from": 0, "place": "<a place id>", "shows": "what is on screen and how large", "action": "what moves or changes", "camera": "framing and move", "then": "the second beat, or an empty string for a short shot", "text": "READOUT or an empty string", "text_at": "the narration word that triggers the readout, or an empty string"}]}`;
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The parsed direction with shot windows attached, or a DirectionError that lists every problem. `parse(text)` turns a reply into an object. */
export function checkDirection({ phrases, videoSeconds, setNames = [], parse }) {
  const range = directedShotRange(videoSeconds);
  return (text) => {
    const why = [];
    let v;
    try { v = parse(text); } catch { throw new DirectionError('the reply was not one JSON object'); }
    const look = str(v.look, 800);
    if (look.split(/\s+/).length < 8) why.push('look must be 2 to 3 sentences');
    const placesIn = Array.isArray(v.places) ? v.places : [];
    if (placesIn.length < MIN_PLACES || placesIn.length > MAX_PLACES) why.push(`places must list ${MIN_PLACES} to ${MAX_PLACES} places (found ${placesIn.length})`);
    const places = [];
    const ids = new Set();
    for (const p of placesIn) {
      const id = str(p?.id, 20).toLowerCase();
      const base = str(p?.base, 30).toLowerCase() || 'custom';
      if (!PLACE_ID.test(id)) { why.push(`place id ${JSON.stringify(p?.id ?? null)} must be one short lowercase word (letters and digits)`); continue; }
      if (ids.has(id)) { why.push(`place id ${id} is used twice`); continue; }
      if (base !== 'custom' && !setNames.includes(base)) { why.push(`place ${id}: base must be "custom" or one of ${setNames.join(', ')}`); continue; }
      const what = str(p?.what, 300); const build = str(p?.build, 900);
      if (what.split(/\s+/).length < 3) why.push(`place ${id}: "what" must say what the place is`);
      if (base === 'custom' && build.split(/\s+/).length < 10) why.push(`place ${id}: a custom place needs "build": ground, backdrop, props, landmark, sky and light`);
      ids.add(id);
      places.push({ id, base, what, build });
    }
    const shotsIn = Array.isArray(v.shots) ? v.shots : [];
    if (shotsIn.length < range.min || shotsIn.length > range.max) why.push(`shots must list ${range.min} to ${range.max} shots, about ${range.target} (found ${shotsIn.length})`);
    const shots = [];
    let prev = -1;
    shotsIn.forEach((s, k) => {
      const from = Number.isInteger(s?.from) ? s.from : -1;
      if (from < 0 || from >= phrases.length) { why.push(`shot ${k + 1}: "from" must be a phrase number 0..${phrases.length - 1}`); return; }
      if (k === 0 && from !== 0) why.push('the first shot must start at phrase 0');
      if (from <= prev) { why.push(`shot ${k + 1}: "from" must be larger than the shot before it (shots are in order, one phrase starts at most one shot)`); return; }
      prev = from;
      const place = str(s?.place, 20).toLowerCase();
      if (!ids.has(place)) why.push(`shot ${k + 1}: place ${JSON.stringify(place)} is not one of the listed places`);
      const shows = str(s?.shows, 500); const action = str(s?.action, 500); const camera = str(s?.camera, 400);
      if (shows.split(/\s+/).length < 5) why.push(`shot ${k + 1}: "shows" must describe what is on screen`);
      if (action.split(/\s+/).length < 4) why.push(`shot ${k + 1}: "action" must say what moves or changes`);
      if (camera.split(/\s+/).length < 3) why.push(`shot ${k + 1}: "camera" must give the framing and the move`);
      shots.push({ from, place, shows, action, camera, then: str(s?.then, 400), text: str(s?.text, 40), text_at: str(s?.text_at, 40) });
    });
    if (!why.length) {
      const starts = shots.map((s) => (s.from === 0 ? 0 : phrases[s.from].start));
      shots.forEach((s, k) => {
        const end = k + 1 < shots.length ? starts[k + 1] : videoSeconds;
        const len = end - starts[k];
        if (len < MIN_DIRECTED_SHOT_S - 1e-6) why.push(`shot ${k + 1} (from P${s.from}) lasts ${len.toFixed(1)} s; the shortest allowed is ${MIN_DIRECTED_SHOT_S} s: start it earlier or merge it with a neighbour`);
        if (len > MAX_DIRECTED_SHOT_S + 1e-6) why.push(`shot ${k + 1} (from P${s.from}) lasts ${len.toFixed(1)} s; the longest allowed is ${MAX_DIRECTED_SHOT_S} s: split it at a phrase inside it`);
      });
      const used = new Set(shots.map((s) => s.place));
      for (const p of places) if (!used.has(p.id)) why.push(`place ${p.id} is never used by a shot; remove it or use it`);
    }
    if (why.length) throw new DirectionError(why.slice(0, 12).join('; '), why);
    const direction = { version: DIRECTION_VERSION, source: 'director', look, places, shots };
    direction.narrations = shotNarrations(direction, phrases);
    return direction;
  };
}

/** Start seconds per shot on the frame grid cadence.js uses (first 0). */
export function directionShotStarts(direction, phrases, fps = FPS) {
  return direction.shots.map((s) => (s.from === 0 ? 0 : startSecondsForFrame(Math.round(phrases[s.from].start * fps), fps)));
}

/** The words each shot carries: its phrases joined, from its first phrase to the one before the next shot. */
export function shotNarrations(direction, phrases) {
  return direction.shots.map((s, k) => {
    const to = k + 1 < direction.shots.length ? direction.shots[k + 1].from : phrases.length;
    return phrases.slice(s.from, to).map((p) => p.text).join(' ');
  });
}

/** What the look call is told each shot should show. */
export function directionLookShots(direction) {
  const narr = direction.narrations;
  return direction.shots.map((s, k) => ({
    subject: `place ${s.place}: ${s.shows} Action: ${s.action} Camera: ${s.camera}${s.then ? ` Then: ${s.then}` : ''}${s.text ? ` Readout "${s.text}"${s.text_at ? ` at the word "${s.text_at}"` : ''}.` : ''}`.slice(0, 900),
    narration: narr[k].slice(0, 400),
  }));
}

export function directionMarkdown(direction, shotStarts, videoSeconds) {
  const narr = direction.narrations;
  const places = direction.places.map((p) => `- place-${p.id} (${p.base === 'custom' ? 'custom, build it from props and primitives' : `ready set ${p.base}`}): ${p.what}${p.build ? ` Build: ${p.build}` : ''}`).join('\n');
  const shots = direction.shots.map((s, k) => {
    const end = k + 1 < shotStarts.length ? shotStarts[k + 1] : videoSeconds;
    return `${k}. ${shotStarts[k]} to ${round3(end)} s (${round3(end - shotStarts[k])} s), in place-${s.place}\n   Narration: ${JSON.stringify(narr[k])}\n   Shows: ${s.shows}\n   Action: ${s.action}\n   Camera: ${s.camera}${s.then ? `\n   Then: ${s.then}` : ''}${s.text ? `\n   Readout: "${s.text}"${s.text_at ? ` when the word "${s.text_at}" is spoken` : ''}` : ''}`;
  }).join('\n');
  return `## Direction\nLook: ${direction.look}\n\n### Places (build each ONCE)\n${places}\n\n### Shots\n${shots}\n`;
}

/**
 * A direction made without a model call, for when the director's reply is refused twice: cuts by arithmetic (cadence.js) and the
 * script's own beats spread over them, one custom place per distinct beat subject up to MAX_PLACES. The video is still made.
 */
export function fallbackDirection({ words, beats = [], lead = 0.35, tail = 1.5 }) {
  const starts = planShotCadence(words, lead, { tail, fps: FPS });
  const phrases = phrasesOf(words, lead);
  const n = starts.length;
  const placeCount = Math.max(MIN_PLACES, Math.min(MAX_PLACES, Math.ceil(n / 3)));
  const places = Array.from({ length: placeCount }, (_, i) => ({ id: `p${i + 1}`, base: 'custom', what: 'a place that fits this part of the story', build: 'ground, a backdrop that reaches the horizon, 4 to 8 props around the subject, one landmark, a sky and a key light' }));
  const shots = starts.map((start, k) => {
    const beat = beats.length ? beats[Math.min(beats.length - 1, Math.floor((k * beats.length) / n))] : null;
    return {
      from: k, place: places[Math.min(placeCount - 1, Math.floor((k * placeCount) / n))].id,
      shows: str(beat?.subject, 500) || 'the subject of this part of the narration, large in the middle of the frame',
      action: str(beat?.action, 500) || 'the subject visibly moves or changes during the shot',
      camera: k % 2 ? 'close, slow push in' : 'wide, slow orbit', then: '', text: '', text_at: '',
    };
  });
  const list = words.words;
  const end = Math.trunc((words.dur + lead + tail) * FPS) / FPS;
  const narrations = starts.map((start, k) => {
    const stop = k + 1 < n ? starts[k + 1] : end;
    return list.filter((w) => w.s + lead >= start - 1e-9 && w.s + lead < stop - 1e-9).map((w) => `${w.w}${typeof w.punct === 'string' ? w.punct : ''}`).join(' ');
  });
  return { direction: { version: DIRECTION_VERSION, source: 'fallback', look: 'Bright toy-like stylized 3D with saturated colours, a warm key light and a cool fill, the same palette in every place.', places, shots, narrations }, shotStarts: starts, phrases };
}
