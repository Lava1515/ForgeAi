// KAN-404: planner technique -> the move blender_worker/shot_math.keyframes(camera_v3=True) really builds.
// Only used behind policy.motion_laws_v1; applyTechniques fills missing shot fields and never overwrites one the plan set.
//
// technique     kind    camera_move   transition (kind/cause)     role     what shot_math renders
// push_through  dolly   push_through  zoom_through / part_reveal  exit     direct: dive along the line of sight into the part, the next shot opens inside it (MG-52)
// whip          orbit   whip          whip / action_end           exit     direct: accelerating azimuth smear into the next framing, cut on the fastest frame (MG-51, MG-35)
// orbit         orbit   orbit         cut                         travel   direct: constant-rate arc around the subject over the whole beat (MG-40)
// crane_rise    orbit   travel        cut                         travel   approximate: one eased arc ending on the highest elevation shot_math has (orbit, 25 deg); there is no vertical boom
// dolly         dolly   arrival       cut                         arrival  direct: push in onto the target on a long-tailed ease out (MG-19, MG-29)
// side_tour     orbit   travel        cut                         travel   approximate: one eased close arc around a targeted part; there is no straight lateral track (MG-49)
// crash_zoom    dolly   push_through  push_through / impact       exit     direct: accelerating push that lands on the part at the cut; a whole-frame hit (MG-44)
//
// A shot with a transition is an "exit" in shot_math: it rests, then moves in the last part of the beat so the cut lands at speed.
// The hold before the payoff and the still last shot use camera_move "hold" (MG-01, MG-11); a hold ignores the table's transition.
export const TECHNIQUE_MAP = {
  push_through: { kind: 'dolly', camera_move: 'push_through', transition: { kind: 'zoom_through', cause: 'part_reveal' }, role: 'exit', hint: 'push into a target part, the next shot opens inside it' },
  whip: { kind: 'orbit', camera_move: 'whip', transition: { kind: 'whip', cause: 'action_end' }, role: 'exit', hint: 'fast swing to the next framing' },
  orbit: { kind: 'orbit', camera_move: 'orbit', transition: null, role: 'travel', hint: 'steady arc around the whole object' },
  crane_rise: { kind: 'orbit', camera_move: 'travel', transition: null, role: 'travel', hint: 'pull back and rise to a high wide view (the zoom-out reveal)' },
  dolly: { kind: 'dolly', camera_move: 'arrival', transition: null, role: 'arrival', hint: 'slow push in onto a named target part' },
  side_tour: { kind: 'orbit', camera_move: 'travel', transition: null, role: 'travel', hint: 'one eased close arc along a target part' },
  crash_zoom: { kind: 'dolly', camera_move: 'push_through', transition: { kind: 'push_through', cause: 'impact' }, role: 'exit', hint: 'very fast push onto a target part, a whole-frame hit' },
};
export const TECHNIQUES = Object.keys(TECHNIQUE_MAP);
export function machineTechniqueFor(scene, policy, cameraV3) {
  if (policy?.machine_explainer_v1 !== true || policy?.camera_v3 !== true || cameraV3 !== true || !(scene?.world === 'lab' || scene?.view === 'xray')) return null;
  return { technique: 'push_in', camera_move: scene.push_in === true && scene.hold !== true ? 'push_in' : 'hold' }; // owner decision KAN-640 (2026-11-04): hold is the default, push_in only when a scene asks for it
}
// KAN-449: the real moves KAN-431 added to shot_math (camera_move names, only built with camera_v3). Used only when policy.camera_v3 === true;
// with camera_v3 off TECHNIQUE_MAP above applies exactly as before. pull_back, push_in and drift are new technique names; crane_rise is the
// same name as above but with camera_v3 it is the true vertical rise. A shot that carries a transition becomes an "exit" in shot_math and
// would lose its real move, so these four never get a transition filled.
const V3B_ROWS = {
  pull_back: { kind: 'dolly', camera_move: 'pull_back', transition: null, role: 'arrival', hint: 'start tight on a part and pull back to the whole object (the zoom-out reveal)' },
  push_in: { kind: 'dolly', camera_move: 'push_in', transition: null, role: 'travel', hint: 'close in on a named part, then hold the close frame' },
  drift: { kind: 'dolly', camera_move: 'drift', transition: null, role: 'drift', hint: 'very slow straight dolly for an establishing or calm shot' },
  crane_rise: { kind: 'dolly', camera_move: 'crane_rise', transition: null, role: 'travel', hint: 'straight vertical rise with the look-at held on the target' },
};
const V3B_MOVES = Object.values(V3B_ROWS).map((r) => r.camera_move);
export const V3B_TECHNIQUES = ['pull_back', 'push_in', 'drift'];
// Shot fields the planner may set that studioPlan's shot normalisation must keep when the flag is on (shot_math + validateMotionLaws read them).
export const MOTION_SHOT_KEYS = ['technique', 'transition', 'camera_move', 'hold_orbit_dps', 'hit', 'angle', 'density', 'text_closeup', 'text_axis', 'peak_speed', 'start_speed', 'motion_caps', 'solid'];
const REPEAT_ORDER = ['dolly', 'orbit', 'side_tour', 'crane_rise', 'push_through', 'whip', 'crash_zoom']; // calm moves first for a demoted repeat
const HOLD_DPS = 4; // MG-20 stage-orbit band 3-5 deg/s: life in the hold before the payoff

// A 3D shot as plans carry it: director plans mark it render "3d", cutaway3d plans kind "shot3d" (the shot normaliser never sets "render" there).
const is3dShot = (s) => (s?.render === '3d' || s?.kind === 'shot3d') && s.shot && typeof s.shot === 'object';
const PUSH_IN = ['dolly', 'push_through', 'crash_zoom']; // techniques that close in on a named part
const PULL_BACK = 'crane_rise'; // the zoom-out reveal; shot_math has no true zoom-out, so this one eased rising arc is the nearest move
const namesPart = (shot) => Boolean(shot.target || shot.about);
const isOrbit = (shot) => shot.type === 'orbit' || shot.technique === 'orbit';
const known = (t, v3) => Boolean(TECHNIQUE_MAP[t] || (v3 && V3B_ROWS[t]));
// the table row for a shot: with camera_v3 the real moves, and a dolly that names a part is the close-in (push_in); otherwise today's row
const rowOf = (shot, v3) => {
  const row = TECHNIQUE_MAP[shot.technique];
  if (!v3) return row;
  if (V3B_ROWS[shot.technique]) return V3B_ROWS[shot.technique];
  return shot.technique === 'dolly' && namesPart(shot) ? { ...row, camera_move: 'push_in' } : row;
};

// fillGaps (KAN-430, cutaway3d plans under motion_laws_v1): the planner often leaves the camera plan thin, so plan-wide gaps are filled in place:
// a technique for every shot that has none (a named part gets a push-in), the opening shot is the pull-back, one shot closes in on a named part,
// every shot that names a part highlights it, and orbits stay under 40% and never run back to back. A planner technique is only replaced
// (or swapped with the pull-back holder) to meet one of those needs; director plans keep their authored shots and never come here.
function fillPlanGaps(shots, v3 = false) {
  const PULL = v3 ? 'pull_back' : PULL_BACK; // KAN-449: with camera_v3 the zoom-out reveal is the real pull_back move
  const has = (t) => shots.some((s) => s.technique === t);
  const free = (list, fallback) => list.find((t) => !has(t)) || fallback;
  // a shot that names no part but highlights one targets its first highlight (validated ids)
  const named = (shot) => { if (!shot.target && !shot.about && shot.highlight?.[0]) shot.target = shot.highlight[0]; return namesPart(shot); };
  shots.forEach((shot, k) => { if (k > 0 && !known(shot.technique, v3) && named(shot)) shot.technique = free(PUSH_IN, 'dolly'); });
  shots.forEach((shot) => { if (!known(shot.technique, v3)) shot.technique = has(PULL) ? free(['side_tour', 'whip'], 'side_tour') : PULL; });
  if (shots.length >= 3) {
    const [first] = shots;
    if (first.technique !== PULL) { // the establishing shot pulls back; whoever held the pull-back takes the opener's move
      const holder = shots.find((s) => s.technique === PULL);
      if (holder) holder.technique = first.technique;
      first.technique = PULL;
    }
    if (!shots.some((s) => PUSH_IN.includes(s.technique) && namesPart(s))) {
      const pick = shots.find((s, k) => k > 0 && s.technique !== PULL && named(s));
      if (pick) pick.technique = free(PUSH_IN, 'dolly');
    }
  }
  if (v3 && shots.length >= 3 && !shots.some((s) => (s.technique === 'push_in' || s.technique === 'dolly') && namesPart(s))) { // KAN-449: the close-in is the real push_in
    const exits = ['push_through', 'whip', 'crash_zoom']; // an exit shot keeps its transition move, so a calm shot takes the push_in when there is one
    const pick = shots.find((s, k) => k > 0 && s.technique !== PULL && !exits.includes(s.technique) && named(s)) || shots.find((s, k) => k > 0 && s.technique !== PULL && named(s));
    if (pick) { pick.technique = 'push_in'; if (pick.type === 'orbit') pick.type = 'dolly'; }
  }
  for (const shot of shots) if (shot.type === 'orbit' && shot.target && PUSH_IN.includes(shot.technique)) shot.type = 'dolly'; // a close-in on a named part is a dolly, not a spin
  const cap = Math.max(1, Math.floor(shots.length * 0.4));
  let orbits = 0;
  shots.forEach((shot, k) => {
    if (!isOrbit(shot)) return;
    if (++orbits <= cap && !(k > 0 && isOrbit(shots[k - 1]))) return;
    if (!named(shot)) return; // nothing to close in on: keep the orbit
    shot.type = 'dolly';
    if (shot.technique === 'orbit') shot.technique = free(PUSH_IN, 'side_tour');
    orbits--;
  });
  for (const shot of shots) if (shot.target && !shot.highlight?.length) shot.highlight = [shot.target];
}

// KAN-449 shorts grammar (policy.shorts_grammar_v1, needs motion_laws_v1; cutaway3d plans only, director plans keep their authored shots).
// Beat of the k-th of n 3D shots: hook first, calm cta last, payoff before it, the hold before the payoff, the peak before the hold.
const beatOf = (k, n) => (k === 0 ? 'hook' : k === n - 1 ? 'cta' : k === n - 2 ? 'payoff' : k === n - 3 ? 'hold' : k === n - 4 ? 'peak' : k === 1 ? 'context' : 'build');
const BEAT_ROWS = { // SG-34: allowed techniques per beat, in the order a replacement is chosen
  hook: ['push_through', 'whip', 'crash_zoom'], // SG-06 also lists pull_back and crane_rise; left out: they stay the one zoom-out reveal, and a real move cannot carry the hook's transition
  context: ['dolly', 'drift', 'side_tour'], // SG-12 also lists push_in, crane_rise and pull_back; left out: push_in and pull_back have one shot each, and every real move costs a hard cut
  build: ['dolly', 'side_tour', 'push_through', 'whip', 'drift', 'orbit'], // transition-capable techniques first: a real move (drift) cannot carry a transition
  peak: ['crash_zoom', 'push_through', 'whip'],
  hold: ['dolly', 'drift', 'side_tour', 'crane_rise'],
  payoff: ['pull_back', 'crane_rise', 'push_in', 'dolly'],
  cta: ['drift', 'dolly', 'side_tour', 'pull_back'],
};
export const GRAMMAR_CAPS = { orbit: 1, whip: 2, push_through: 2, crash_zoom: 1, push_in: 1 }; // SG-35, SG-39: per video; calm techniques are not capped
const ROTATION = ['orbit', 'whip', 'side_tour']; // SG-35: an orbit never sits beside another rotation-kind shot
const MIN_KINDS = 5; // distinct techniques wanted once a plan has this many 3D shots (SG-36 asks for 3 to 4; the owner's verdict asks for more variety)

// KAN-658 profile story_hardcut (policy.shorts_grammar_profile === 'story_hardcut', only with motion_laws_v1 + shorts_grammar_v1): a second grammar next to the
// whip one. secondsPerShot sets the prompt's shot count (14-18 at 30 s); cutInterval is what the validator accepts as the average; the plan has no shot size
// field, so size is a function of the technique (shotSize); whip and push_through stay optional; no orbit and no side_tour (a spin).
export const GRAMMAR_PROFILES = {
  story_hardcut: { secondsPerShot: [1.7, 2.1], cutInterval: [1.5, 2.5], alternation: 'size', optional: ['whip', 'push_through'], orbits: 0 },
};
export const profileOf = (value) => (value === 'story_hardcut' ? value : undefined); // strict: any other value is no profile
const CLOSE_SIZE = ['push_in', 'crash_zoom'], WIDE_SIZE = ['crane_rise', 'pull_back'];
export const shotSize = (shot) => {
  const t = shot?.technique;
  if (!shot || typeof shot !== 'object' || GRAMMAR_PROFILES.story_hardcut.optional.includes(t)) return null; // the optional exits have no size, whatever their shot type
  if (CLOSE_SIZE.includes(t) || (t === 'dolly' && namesPart(shot))) return 'close';
  if (WIDE_SIZE.includes(t) || shot.type === 'establish' || shot.type === 'reveal') return 'wide';
  return null;
};
// a spin: an orbit or side_tour, or a leftover orbit shot type (the whip and push_through rows carry type orbit from the table; they are not spins)
export const isSpinShot = (s) => s?.technique === 'orbit' || s?.technique === 'side_tour' || s?.camera_move === 'orbit' || (s?.type === 'orbit' && !GRAMMAR_PROFILES.story_hardcut.optional.includes(s.technique));

// Alternation rule (one definition, the validator applies the same): judged over the sequence of SIZED shots. A shot with no size (the optional whip and
// push_through, or a locked shot with none) is skipped, so close, whip, close is a repeat and the two closes must differ. hardcutRuns lists the equal pairs.
export function hardcutRuns(sizes) {
  const out = []; let last = null;
  sizes.forEach((size, k) => { if (size == null) return; if (size === last?.size) out.push([last.k, k]); last = { k, size }; });
  return out;
}

// Close and wide alternate. Immovable: locked shots (the caller's: follow, hold, tour) and the optional whip and push_through. Every other shot is close (only on a named
// part) or wide; the sizes come from a small search over the plan that changes as few shots as possible and leaves no equal sized neighbours (a change is a spin, an
// unsized shot, or a size that has to flip). A shot that cannot be fixed (its neighbours leave it no size) stays. Returns { solved, runs }: runs are the [i, j] shot
// index pairs still equal (empty when solved); the validator reports the same pairs on the plan.
export function applyHardcutProfile(shots, v3, locked = () => false) {
  if (!shots.length) return { solved: true, runs: [] };
  const wide = v3 ? ['pull_back', 'crane_rise'] : ['crane_rise'];
  const cur = shots.map(shotSize), fixed = (k) => locked(k) || GRAMMAR_PROFILES.story_hardcut.optional.includes(shots[k].technique);
  const sizes = shots.map((s, k) => (fixed(k) ? [cur[k]] : namesPart(s) || cur[k] === 'close' ? ['close', 'wide'] : ['wide']));
  const cost = (k, size) => (fixed(k) || (size === cur[k] && !isSpinShot(shots[k])) ? 0 : 1);
  // state: the last sized shot's size so far (null before any); an unsized shot keeps the state
  const best = [], from = []; // best[k]: state -> least cost of shots 0..k; from[k]: state -> { before: state after shot k-1, size: size of shot k }
  shots.forEach((s, k) => {
    best[k] = new Map(); from[k] = new Map();
    for (const size of sizes[k]) {
      for (const [before, c] of k > 0 ? best[k - 1] : [[null, 0]]) {
        const state = size ?? before, total = c + cost(k, size) + (size != null && size === before ? 100 : 0);
        if (total < (best[k].get(state) ?? Infinity)) { best[k].set(state, total); from[k].set(state, { before, size }); }
      }
    }
  });
  const [last] = [...best[shots.length - 1]].reduce((a, e) => (e[1] < a[1] ? e : a));
  const pick = []; let state = last;
  for (let k = shots.length - 1; k >= 0; k--) { const f = from[k].get(state); pick[k] = f.size; state = f.before; }
  let w = 0;
  shots.forEach((shot, k) => {
    if (fixed(k) || (pick[k] === cur[k] && !isSpinShot(shot))) return;
    shot.technique = pick[k] === 'close' ? (v3 ? 'push_in' : 'dolly') : wide[w++ % wide.length];
    if (shot.type === 'orbit' || shot.type === undefined) shot.type = pick[k] === 'close' ? 'dolly' : 'establish';
    if (shot.camera_move !== undefined) shot.camera_move = rowOf(shot, v3).camera_move; // a planned move is replaced with the new technique's; unset stays unset for the fill
    delete shot.transition;
  });
  const runs = hardcutRuns(shots.map(shotSize));
  return { solved: runs.length === 0, runs };
}

function applyShortsGrammar(shots, v3, hookMove = false) {
  const n = shots.length;
  if (n < 4) return; // too short for a beat map; the existing hold logic needs 4 shots too
  const rowFor = (beat) => (hookMove && v3 && beat === 'hook' ? [...BEAT_ROWS.hook, 'crane_rise'] : BEAT_ROWS[beat]); // KAN-614: hook_move_v1 lets the hook open on the real crane_rise
  const allowed = (k) => rowFor(beatOf(k, n)).filter((t) => known(t, v3));
  const count = (t, k) => shots.reduce((c, s, i) => c + (i !== k && s.technique === t ? 1 : 0), 0);
  const bad = (k, t) => !known(t, v3) || !allowed(k).includes(t) || count(t, k) >= (GRAMMAR_CAPS[t] ?? Infinity)
    || [k - 1, k + 1].some((j) => shots[j] && (shots[j].technique === t || (ROTATION.includes(t) && shots[j].technique === 'orbit') || (t === 'orbit' && ROTATION.includes(shots[j].technique))));
  const costly = (k, t) => (t === 'orbit' || (v3 && V3B_MOVES.includes(t))) && k !== n - 3 && k !== n - 1; // a hold or the last shot carries no cut cost
  const fixed = new Set();
  const set = (k, t) => { shots[k].technique = t; fixed.add(k); };
  const named = (shot) => { if (!shot.target && !shot.about && shot.highlight?.[0]) shot.target = shot.highlight[0]; return namesPart(shot); };
  const holdK = n - 3, peakK = n >= 5 ? n - 4 : -1;
  const CLOSE = v3 ? 'push_in' : 'dolly';

  // forced roles first (the zoom-out reveal, the peak, the one close-in on a named part); the repair below works around them
  set(n - 2, v3 ? 'pull_back' : 'crane_rise');
  if (peakK >= 0) set(peakK, 'crash_zoom');
  const inBuild = (s, k) => k > 0 && k < holdK && k !== peakK;
  const closeK = shots.findIndex((s, k) => inBuild(s, k) && s.technique === CLOSE && named(s));
  let pickK = closeK >= 0 ? closeK : shots.findIndex((s, k) => inBuild(s, k) && named(s));
  if (pickK < 0 && peakK > 0 && named(shots[peakK])) pickK = peakK; // a 5-shot plan has no build shot between the hook and the peak: the close-in takes the peak
  if (pickK >= 0) set(pickK, CLOSE);

  // repair: unknown or off-row technique, a cap, an equal neighbour, a second orbit beside a rotation
  shots.forEach((shot, k) => {
    if (fixed.has(k) || !bad(k, shot.technique)) return;
    const pool = allowed(k).filter((t) => !bad(k, t));
    const cheap = pool.filter((t) => !costly(k, t)); // prefer a technique that can carry a transition: every hard cut counts against the one-third budget
    shot.technique = cheap.find((t) => !count(t, k)) || cheap[0] || pool.find((t) => !count(t, k)) || pool[0] || shot.technique;
  });
  // variety: replace a repeated technique by an unused allowed one until the plan has MIN_KINDS kinds
  const kinds = () => new Set(shots.map((s) => s.technique)).size;
  for (let k = 0; k < n && kinds() < Math.min(MIN_KINDS, n); k++) {
    if (fixed.has(k) || count(shots[k].technique, k) === 0) continue;
    const t = allowed(k).find((c) => !count(c, k) && !bad(k, c));
    if (t) shots[k].technique = t;
  }
  // cuts: an orbit or a real move cannot carry a transition, so each one is a hard cut; when they exceed the one-third budget the planner's extras
  // (never the forced push_in and pull_back) give way to a technique that can
  if (hookMove && v3 && shots[0].technique === 'crane_rise') fixed.add(0); // KAN-614: the hook crane is the point of the flag; the other extras give way to it
  const budget = Math.floor((n - 1) / 3);
  const cutShots = () => shots.filter((s, k) => costly(k, s.technique)).length;
  for (let k = 0; k < n && cutShots() > budget; k++) {
    if (fixed.has(k) || !costly(k, shots[k].technique)) continue;
    const pool = allowed(k).filter((t) => !costly(k, t) && !bad(k, t));
    if (pool.length) shots[k].technique = pool.find((t) => !count(t, k)) || pool[0];
  }
  // a spin is the technique orbit, never a leftover shot type: only an orbit-technique shot keeps type "orbit"
  shots.forEach((shot) => { if (shot.type === 'orbit' && shot.technique !== 'orbit') shot.type = named(shot) ? 'dolly' : 'establish'; });
  // exactly one close-in with camera_v3: any other dolly on a named part stays an arrival, not a push_in
  if (v3) shots.forEach((shot, k) => { if (k !== pickK && k !== holdK && k !== n - 1 && shot.technique === 'dolly' && shot.camera_move === undefined) shot.camera_move = 'arrival'; }); // the hold and the last shot stay free for their hold move
  // hold: the one highlight, on the key part (the peak's target when the hold names none)
  const hold = shots[holdK];
  if (!hold.highlight?.length) {
    const key = hold.target || shots[peakK]?.target || shots.find((s) => s.highlight?.length)?.highlight[0];
    if (key) hold.highlight = [key];
  }
  if (shots[0].start_speed === undefined) shots[0].start_speed = 'running'; // hook: the renderer starts moving within 15 frames (shot_math support is a follow-up)
}

// KAN-497 any-story director plans (policy.any_story_v1 + shorts_grammar_v1): the story planner authors its own shots, so the grammar only
// repairs what the 2026-11-01 proofs measured: orbit-kind shots over a quarter, no real pull_back, no running start. Targets, follow, camera_zone
// and highlights are never touched (so is a scene's own place-change transition); no hard cut is added.
export function applyStoryGrammar(scenes, { camera_v3: v3 = false, motion_limits: motionLimits = false, profile = undefined } = {}) {
  const idx = scenes.map((s, i) => (is3dShot(s) ? i : -1)).filter((i) => i >= 0);
  const n = idx.length;
  if (n < 4) return scenes;
  const shots = idx.map((i) => scenes[i].shot);
  const orbitKind = (s) => s.type === 'orbit' || s.camera_move === 'orbit' || s.technique === 'orbit';
  const cutKind = (s) => { const t = s.transition; const k = t && typeof t === 'object' ? t.kind : t; return k === 'cut' || k === 'hard_cut'; };
  // (b) the reveal: a real pull_back on the closing shot (else the one before it), never on a highlight or a follow shot; it cannot carry a transition
  let revealK = -1;
  if (v3 && !shots.some((s) => s.camera_move === 'pull_back')) {
    revealK = [n - 1, n - 2].find((k) => !shots[k].highlight?.length && !shots[k].follow && !scenes[idx[k]].transition && (k === n - 1 || shots[k].camera_move !== 'hold'));
    if (revealK !== undefined) {
      const shot = shots[revealK];
      Object.assign(shot, { technique: 'pull_back', camera_move: 'pull_back', type: shot.type === 'orbit' ? 'dolly' : shot.type });
      delete shot.transition;
      const prev = shots[revealK - 1];
      if (prev && cutKind(prev) && !V3B_MOVES.includes(prev.camera_move)) prev.transition = { kind: 'match_cut', cause: 'action_end' }; // the shot before is not a hard cut
    } else revealK = -1;
  }
  // (a) orbit-kind shots at most a quarter: the latest surplus ones (follow shots last) become a drift or a plain dolly arrival on the same target
  const cap = Math.floor(n * 0.25);
  const spare = shots.map((s, k) => k).filter((k) => k > 0 && k !== revealK && k !== n - 1 && orbitKind(shots[k]) && !scenes[idx[k]].transition).sort((a, b) => (shots[a].follow ? 1 : 0) - (shots[b].follow ? 1 : 0) || b - a);
  for (let over = shots.filter(orbitKind).length - cap; over > 0 && spare.length; over--) {
    const k = spare.shift(), shot = shots[k];
    const near = [shots[k - 1], shots[k + 1]].map((s) => s?.technique);
    const t = ['drift', 'dolly'].find((c) => known(c, v3) && !near.includes(c)) || 'dolly';
    Object.assign(shot, { technique: t, type: 'dolly', camera_move: t === 'drift' ? 'drift' : 'arrival' });
    delete shot.transition; // a real move cannot carry one, and the cut count stays as it was
  }
  // (c) a first scene that runs or rides starts with the camera already moving
  if (shots[0].start_speed === undefined && (scenes[idx[0]].cast || []).some((c) => c?.action === 'run' || c?.action === 'ride')) shots[0].start_speed = 'running';
  if (v3 && motionLimits) applyStoryMotionLimits(scenes, idx); // KAN-537: opt-in until studioPlan.js passes it and the KAN-497 one-pull_back test is updated
  if (profileOf(profile)) applyHardcutProfile(shots, v3, (k) => Boolean(shots[k].follow) || shots[k].camera_move === 'hold'); // KAN-658: close and wide alternate, no spin; a follow shot and a hold keep their move
  return scenes;
}

// KAN-537: the numbers a human tunes for story camera moves (plan side; the azimuth speed caps are MOTION_CAPS in blender_worker/shot_math.py).
export const STORY_CAMERA_LIMITS = {
  wordsPerSecond: 2.5, // a scene's length from its words, the same rate the validator counts (SG-05)
  orbitShareMax: 0.25, // orbit-kind shots, share of the video's shot time
  minSeconds: { orbit: 2.5, side_tour: 2.0, push_in: 1.4, pull_back: 1.6, drift: 1.0 }, // a shorter shot cannot finish its move, so it gets a calm arrival instead
  minLocationShots: 3, // a location with this many shots gets its own push-in on a named part and its own pull-back
};
const orbitKind = (s) => s.type === 'orbit' || s.camera_move === 'orbit' || s.technique === 'orbit';
const moveKind = (s) => (orbitKind(s) ? 'orbit' : s.technique === 'side_tour' ? 'side_tour' : s.camera_move);
const sceneSeconds = (scene) => Math.max(0.5, String(scene.text || '').split(/\s+/).filter(Boolean).length / STORY_CAMERA_LIMITS.wordsPerSecond);

// Deterministic repair of what the 2026-11-01 camera audit measured (docs/superpowers/perf/2026-11-01-camera-audit-v2.md): orbits back to back or
// over a quarter of the time, moves too short to finish, no push-in or pull-back in a location. Never touches targets, follow, highlights or a
// place-change transition; shots get motion_caps so shot_math eases and caps them.
function applyStoryMotionLimits(scenes, idx, { explainer = false } = {}) {
  const L = STORY_CAMERA_LIMITS, n = idx.length;
  const shots = idx.map((i) => scenes[i].shot), secs = idx.map((i) => sceneSeconds(scenes[i]));
  // explainer shots highlight a part on nearly every shot (the move keeps that highlight), but a transition the planner chose stays as it is
  const free = (k) => k > 0 && k < n - 1 && (explainer || !shots[k].highlight?.length) && shots[k].camera_move !== 'hold' && !scenes[idx[k]].transition && !(explainer && shots[k].transition);
  const dollyLike = (s) => s && !orbitKind(s) && !['push_in', 'pull_back', 'drift', 'hold', 'whip', 'push_through', 'crane_rise'].includes(s.camera_move) && (s.technique ?? 'dolly') === 'dolly';
  const dollyRun = (k) => { let r = 1; for (let j = k - 1; dollyLike(shots[j]); j--) r++; for (let j = k + 1; dollyLike(shots[j]); j++) r++; return r; }; // the run of dolly-kind shots this one would sit in
  const calm = (k) => { // same replacement the orbit cap uses: a drift or a plain dolly arrival on the same target
    const near = [shots[k - 1], shots[k + 1]].map((s) => s?.technique); let t = ['drift', 'dolly'].find((c) => !near.includes(c)) || 'dolly';
    // an explainer prefers the arrival or, after two of them, a slow hold: a drift cannot carry a transition and the hard-cut budget needs them
    if (explainer) { shots[k].hold_orbit_dps = HOLD_DPS; t = dollyRun(k) >= 3 ? 'hold' : 'dolly'; if (t === 'dolly') delete shots[k].hold_orbit_dps; }
    Object.assign(shots[k], { technique: t === 'hold' ? 'dolly' : t, type: 'dolly', camera_move: t === 'drift' ? 'drift' : t === 'hold' ? 'hold' : 'arrival' });
    delete shots[k].transition;
  };
  const long = (k, move) => secs[k] >= (L.minSeconds[move] ?? 0);
  shots.forEach((s, k) => { if (free(k) && !long(k, moveKind(s))) calm(k); }); // a move that cannot finish
  shots.forEach((s, k) => { if (orbitKind(s) && k > 0 && orbitKind(shots[k - 1])) { if (free(k)) calm(k); else if (free(k - 1)) calm(k - 1); } }); // no two orbits in a row
  const total = secs.reduce((a, b) => a + b, 0), orbitTime = () => shots.reduce((a, s, k) => a + (orbitKind(s) ? secs[k] : 0), 0);
  for (let k = n - 1; k > 0 && orbitTime() / total > L.orbitShareMax; k--) if (orbitKind(shots[k]) && free(k)) calm(k);
  // one pull-back and one push-in on a named part per location (a run of scenes in one kit)
  const kitOf = (k) => scenes[idx[k]].location?.kit ?? null;
  const named = (k) => shots[k].target || (explainer && shots[k].highlight?.[0]); // an explainer shot that only highlights a part still names it
  for (let a = 0; a < n;) {
    let b = a;
    while (b + 1 < n && kitOf(b + 1) === kitOf(a)) b++;
    const ks = Array.from({ length: b - a + 1 }, (_, j) => a + j);
    if (ks.length >= L.minLocationShots) {
      if (!ks.some((k) => shots[k].camera_move === 'push_in' && shots[k].target)) {
        const k = ks.find((j) => free(j) && named(j) && shots[j].camera_move !== 'pull_back' && long(j, 'push_in') && j > a) ?? ks.find((j) => free(j) && named(j) && shots[j].camera_move !== 'pull_back' && long(j, 'push_in'));
        if (k !== undefined) Object.assign(shots[k], { technique: 'push_in', camera_move: 'push_in', type: 'dolly', target: named(k) });
      }
      if (!ks.some((k) => shots[k].camera_move === 'pull_back')) {
        const k = [...ks].reverse().find((j) => free(j) && shots[j].camera_move !== 'push_in' && long(j, 'pull_back'));
        if (k !== undefined) {
          Object.assign(shots[k], { technique: 'pull_back', camera_move: 'pull_back', type: shots[k].type === 'orbit' ? 'dolly' : shots[k].type });
          delete shots[k].transition;
        }
      }
    }
    a = b + 1;
  }
  for (const s of shots) s.motion_caps = true;
}

// KAN-552: the cutaway3d shot pass (resolveShots) never set motion_caps or any grammar; the 2026-11-02 explainer measured orbit share 44%, no push-in,
// no pull-back, 100% hard cuts. Same limits table as the stories (STORY_CAMERA_LIMITS); only under camera_v3, only for plans with 4+ 3D shots.
// Transitions the renderer does not know (dissolve and the like) are dropped, then the shorts grammar fills the hard-cut budget.
const KNOWN_TRANSITIONS = ['cut', 'hard_cut', 'whip', 'push_through', 'match_cut', 'zoom_through'];
export function applyExplainerGrammar(scenes, { camera_v3: v3 = false } = {}) {
  if (!v3 || !Array.isArray(scenes)) return scenes;
  const idx = scenes.map((s, i) => (is3dShot(s) ? i : -1)).filter((i) => i >= 0);
  if (idx.length < 4) return scenes;
  for (const i of idx) {
    const t = scenes[i].shot.transition, kind = t && typeof t === 'object' ? t.kind : t;
    if (t !== undefined && !KNOWN_TRANSITIONS.includes(kind)) delete scenes[i].shot.transition;
  }
  applyStoryMotionLimits(scenes, idx, { explainer: true });
  fillShortsTransitions(scenes, idx, true);
  return scenes;
}

// With camera_v3 the real moves cannot carry a transition (shot_math turns a shot with a transition into an exit and drops the move), so
// cuts become caused transitions only on the other shots: a hold hands over with a match cut, a shot that names a part dives into it
// (zoom_through, part_reveal), the rest match-cut on an action end. Only as many as the one-third hard-cut budget needs, earliest first.
function fillShortsTransitions(scenes, idx, v3) {
  const kindOf = (s) => { const t = s.shot?.transition; return (t && typeof t === 'object' ? t.kind : t) || 'cut'; };
  const outgoing = scenes.slice(0, -1);
  let cuts = outgoing.filter((s) => kindOf(s) === 'cut').length;
  const budget = Math.floor(outgoing.length / 3);
  for (const i of idx.slice(0, -1)) {
    if (cuts <= budget) break;
    const shot = scenes[i].shot;
    if (kindOf(scenes[i]) !== 'cut' || shot.camera_move === 'orbit' || (v3 && V3B_MOVES.includes(shot.camera_move))) continue; // the one orbit stays an orbit too
    shot.transition = shot.camera_move === 'hold' ? { kind: 'match_cut', cause: 'part_reveal' } : namesPart(shot) ? { kind: 'zoom_through', cause: 'part_reveal' } : { kind: 'match_cut', cause: 'action_end' };
    cuts--;
  }
}

// SG-05: a sentence over 3.5 s of speech (2.5 words a second, as the validator counts) is covered by two shots, so cutaway3d plans under the
// grammar split every longer scene at the clause break nearest its middle (else the middle word), again until each part is short enough.
// The narration is untouched (the parts join back to the same text); the new part opens a dolly on the same part, its technique comes from the grammar.
const MAX_SCENE_WORDS = 8;
// KAN-568: a parts tour shot (KAN-557/564: type dismantle, tour_part = one child id) is one continuous take the grammar must not retype, retime or split.
const isTourShot = (scene) => typeof scene?.shot?.tour_part === 'string' && scene.shot.tour_part !== '';
const EXIT_TECHNIQUES = ['whip', 'push_through', 'crash_zoom'];
const splitText = (text) => {
  const w = text.split(/\s+/).filter(Boolean);
  if (w.length <= MAX_SCENE_WORDS) return [text];
  const mid = w.length / 2;
  const breaks = w.map((x, i) => i).filter((i) => /[,;:—–]$/.test(w[i]) && i >= 2 && w.length - i - 1 >= 3).sort((a, b) => Math.abs(a + 1 - mid) - Math.abs(b + 1 - mid));
  const at = (breaks.length ? breaks[0] : Math.ceil(mid) - 1) + 1;
  return [...splitText(w.slice(0, at).join(' ')), ...splitText(w.slice(at).join(' '))];
};
export function splitLongShots(scenes) {
  if (!Array.isArray(scenes)) return scenes;
  return scenes.flatMap((scene) => {
    if (!is3dShot(scene) || scene.beats || scene.act !== undefined || isTourShot(scene)) return [scene]; // KAN-568: a tour line (capped by validatePartsTour) keeps its one shot and its tour_part
    const parts = splitText(String(scene.text || ''));
    if (parts.length < 2) return [scene];
    const { type: _t, target, about, highlight } = scene.shot;
    return parts.map((text, k) => (k === 0 ? { ...scene, text } : { text, shows: scene.shows ?? '', kind: scene.kind, shot: { type: 'dolly', ...(target && { target }), ...(about && { about }), highlight: [...(highlight || [])] }, delivery: '' }));
  });
}

// scenes: plan.scenes after validation. 3D shots with a valid technique get their missing fields; everything else is left alone.
// camera_v3 (KAN-449): technique -> the real moves; shortsGrammar: the grammar's caps, roles and transitions instead of hero-once.
export function applyTechniques(scenes, { repeatOrder = REPEAT_ORDER, fillGaps = false, camera_v3: v3 = false, shortsGrammar = false, hook_move_v1: hookMove = false, profile = undefined } = {}) {
  if (!Array.isArray(scenes)) return scenes;
  const all3d = scenes.map((s, i) => (is3dShot(s) ? i : -1)).filter((i) => i >= 0);
  const idx = all3d.filter((i) => !isTourShot(scenes[i])); // KAN-568: the grammar, the gap fill, hold and finale rules only act on the non-tour shots
  const afterTour = new Set(all3d.filter((i, p) => p > 0 && !isTourShot(scenes[i]) && isTourShot(scenes[all3d[p - 1]])));
  const grammar = fillGaps && shortsGrammar;
  const hardcut = grammar && profileOf(profile) !== undefined; // KAN-658
  if (grammar) applyShortsGrammar(idx.map((i) => scenes[i].shot), v3, hookMove === true);
  else if (fillGaps) fillPlanGaps(idx.map((i) => scenes[i].shot), v3);
  if (hardcut) applyHardcutProfile(idx.map((i) => scenes[i].shot), v3);
  for (const i of afterTour) { // the tour is one continuous take: the shot after it takes no whip, push_through or crash_zoom
    const shot = scenes[i].shot;
    if (!EXIT_TECHNIQUES.includes(shot.technique)) continue;
    const near = [scenes[i - 1], scenes[i + 1]].map((s) => s?.shot?.technique);
    shot.technique = ['dolly', 'drift', 'side_tour'].find((t) => known(t, v3) && !near.includes(t)) || 'dolly';
  }
  if (fillGaps) repeatOrder = repeatOrder.filter((t) => t !== 'orbit'); // a demoted repeat never becomes the orbit
  const n = idx.length;
  const last = n >= 2 ? idx[n - 1] : -1; // calm end card (MG-01); a lone shot must still move
  const holdBefore = n >= 4 ? idx[n - 3] : -1; // payoff = the 3D shot before the last; the one before it holds (MG-11), never the hook (MG-07)
  const used = new Set();
  for (const i of idx) {
    const shot = scenes[i].shot;
    if (!known(shot.technique, v3)) continue;
    if (!grammar && used.has(shot.technique)) { // a technique is the hero of one shot only (MG-14): the repeat takes the first unused one
      const free = repeatOrder.find((t) => known(t, v3) && !used.has(t) && !(afterTour.has(i) && EXIT_TECHNIQUES.includes(t)));
      if (free) shot.technique = free;
    }
    used.add(shot.technique);
    const row = rowOf(shot, v3);
    const fill = (key, value) => { if (shot[key] === undefined && value !== null) shot[key] = value; };
    if (i === last) fill('camera_move', 'hold');
    else if (i === holdBefore) { fill('camera_move', 'hold'); if (shot.camera_move === 'hold') fill('hold_orbit_dps', HOLD_DPS); }
    fill('type', row.kind);
    fill('camera_move', row.camera_move);
    if (shot.camera_move !== 'hold') fill('transition', row.transition);
  }
  if (grammar && !hardcut) fillShortsTransitions(scenes, idx, v3); // the hard-cut profile keeps its cuts
  return scenes;
}

// Planner prompt line (appended after the motion-laws block when the flag is on).
export const techniquePrompt = () => `\n   Technique -> move: put "technique" inside each 3D "shot". ${TECHNIQUES.map((t) => `${t}: ${TECHNIQUE_MAP[t].hint}`).join('; ')}. The shot before the payoff is held and the last shot is still; you do not add those.`;

// KAN-449: the Shorts shot grammar as planner lines (spec section 4.1; the "beat" field is not asked for because the renderer already reads shot.beat).
export function shortsGrammarPrompt({ seconds = 30, camera_v3: v3 = false, profile = undefined } = {}) {
  const lo = Math.round(11 + (seconds - 30) * 0.3);
  const hi = Math.round(15 + (seconds - 30) * 0.4);
  const row = (beat) => BEAT_ROWS[beat].filter((t) => known(t, v3)).join('/');
  const extra = v3 ? `\n   - Extra techniques: ${V3B_TECHNIQUES.map((t) => `${t}: ${V3B_ROWS[t].hint}`).join('; ')}; crane_rise is a straight vertical rise.` : '';
  return `\n   Shorts shot grammar (shorts_grammar_v1):
   - Beat map: hook 0-1.5 s, context to 4 s, build to 70% of the length, peak 2 s, hold 1 s, payoff 4 s, CTA and loop 3 s.
   - Shots: ${lo}-${hi} at ${seconds} s, none over 4.5 s except the payoff and the CTA; split any sentence over 3.5 s into two scenes at a clause break, each with its own shot.${extra}
   - Hook: frame 0 shows the hero already in motion; one shot of at most 1.5 s with ${row('hook')}; no title card.
   - Allowed technique per beat: context ${row('context')}; build ${row('build')}; peak ${row('peak')}; payoff ${row('payoff')}; CTA ${row('cta')}.
   - Caps: orbit at most once and never beside another orbit/whip/side_tour; at least 5 different techniques; never the same technique in two neighbouring shots; whip and push_through at most 2 each, crash_zoom at most 1.
   - Exactly one close-in on a part the narration names (${v3 ? 'push_in' : 'dolly'}), one zoom-out reveal after the hook (${v3 ? 'pull_back' : 'crane_rise'}), one highlight on the key part in the hold shot.
   - At least 40% of the shots show an action; every 3D shot names where it is, and the place changes when the story changes place.
   - Cuts: a shot that introduces a named thing starts a moment before the narration says its name; other cuts sit on a pause. The last shot is a hold that mirrors the first framing; no outro card.${profileOf(profile) ? hardcutPrompt(seconds, v3) : ''}`;
}
// KAN-658: appended after the base grammar, so a profile-less prompt stays byte-identical; it overrides the shot count and length lines above.
function hardcutPrompt(seconds, v3) {
  const [fast, slow] = GRAMMAR_PROFILES.story_hardcut.secondsPerShot, [cutLo, cutHi] = GRAMMAR_PROFILES.story_hardcut.cutInterval;
  return `
   Hard-cut profile (shorts_grammar_profile story_hardcut; this overrides the shot count and shot lengths above): ${Math.round(seconds / slow)}-${Math.round(seconds / fast)} shots at ${seconds} s, a hard cut every ${cutLo}-${cutHi} s, so each beat is one or two quick shots. Alternate a close shot (${v3 ? 'push_in' : 'dolly onto a named part'} or crash_zoom) with a wide shot (${v3 ? 'pull_back or crane_rise' : 'crane_rise'}, or an establishing or revealing frame); never two close or two wide shots in a row. No orbit and no side_tour. whip and push_through are allowed but optional.`;
}
