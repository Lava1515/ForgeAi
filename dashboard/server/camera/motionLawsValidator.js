import { loadMotionRules } from './knowledgeLoader.js';
import { V3B_TECHNIQUES, GRAMMAR_CAPS, GRAMMAR_PROFILES, profileOf, shotSize, isSpinShot, hardcutRuns } from './techniqueMap.js';

// Planner motion laws (KAN-374): warnings only, never rejects a plan.
// Input = real plan objects: plan.scenes[i] = { render ('3d') or kind ('shot3d' on cutaway3d plans), text, start?, end?, shot: { type, technique?, transition?, hit?, angle?, density?, text_closeup?, peak_speed? } }.
export const TECHNIQUES = ['push_through', 'whip', 'orbit', 'crane_rise', 'dolly', 'side_tour', 'crash_zoom'];
export const HIT_KINDS = ['flash', 'punch_zoom', 'shudder'];
const MAX_KINDS = 5, MIN_KINDS = 3, LONG_VIDEO_S = 30, MAX_HARD_CUT_SHARE = 1 / 3;
const MAX_HITS = 3, MIN_HIT_GAP_S = 8;
const WORDS_PER_S = 2.5; // ponytail: spoken-pace fallback for scenes without start/end; use real voice timings when plans carry them
const RULE_IDS = ['MG-05', 'MG-13', 'MG-14', 'MG-24', 'MG-27', 'MG-44'];

export const motionLawsEnabled = ({ policy = null, motion_laws_v1 = false } = {}) =>
  motion_laws_v1 === true || policy?.motion_laws_v1 === true;

// A 3D shot as plans carry it: director plans render '3d', cutaway3d plans kind 'shot3d' (KAN-430: only the first form was checked, so real cutaway plans were never validated).
const is3dShot = (s) => s?.render === '3d' || s?.kind === 'shot3d';
const hitsOf = (shot) => [].concat(shot?.hit ?? []).filter((h) => HIT_KINDS.includes(h));
const kindOf = (scene) => { const t = scene.shot?.transition; return (t && typeof t === 'object' ? t.kind : t) || 'cut'; }; // string or {kind, cause} (KAN-373)

function timeline(scenes) {
  let t = 0;
  return scenes.map((s) => {
    const dur = Number.isFinite(s.end) && Number.isFinite(s.start) ? s.end - s.start : String(s.text || '').split(/\s+/).filter(Boolean).length / WORDS_PER_S;
    const start = Number.isFinite(s.start) ? s.start : t;
    t = start + dur;
    return { start, end: start + dur };
  });
}

// opts (KAN-449): camera_v3 also accepts the real-move technique names; shortsGrammar swaps hero-once for the grammar's caps (SG-35, SG-39)
// and puts the highest camera peak speed on the peak shot (SG-24) instead of the last body shot, since the payoff is slower than the peak (SG-29).
export function validateMotionLaws(plan, { camera_v3 = false, shortsGrammar = false, profile = undefined } = {}) {
  const known = camera_v3 ? [...TECHNIQUES, ...V3B_TECHNIQUES] : TECHNIQUES;
  const warnings = [];
  const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
  if (!scenes.length) return warnings;
  const times = timeline(scenes);
  const total = times[times.length - 1].end;

  // 1. technique naming + hero once
  const heroAt = new Map();
  scenes.forEach((s, i) => {
    if (!is3dShot(s) || !s.shot) return;
    const tech = s.shot.technique;
    if (!known.includes(tech)) return warnings.push(`Scene ${i + 1}: 3D shot has no known technique (${known.join(', ')}).`);
    if (shortsGrammar) {
      heroAt.set(tech, [...(heroAt.get(tech) || []), i]);
      if (heroAt.get(tech).length === (GRAMMAR_CAPS[tech] ?? Infinity) + 1) warnings.push(`Scene ${i + 1}: technique "${tech}" is used more than ${GRAMMAR_CAPS[tech]} time(s) in one video.`);
    } else if (heroAt.has(tech)) warnings.push(`Scene ${i + 1}: technique "${tech}" is already the hero of scene ${heroAt.get(tech) + 1}; one hero per technique.`);
    else heroAt.set(tech, i);
  });

  // 2. transition budget
  const kinds = scenes.slice(0, -1).map(kindOf); // the last scene has no outgoing transition
  const distinct = new Set(kinds);
  if (distinct.size > MAX_KINDS) warnings.push(`Transitions use ${distinct.size} kinds; at most ${MAX_KINDS}.`);
  if (total > LONG_VIDEO_S && distinct.size < MIN_KINDS) warnings.push(`Transitions use ${distinct.size} kinds on a ${Math.round(total)} s video; at least ${MIN_KINDS}.`);
  const hard = kinds.filter((k) => k === 'cut').length;
  const hardcut = profileOf(profile) !== undefined; // KAN-658: hard cuts are the point of this profile, so the one-third budget does not apply
  if (!hardcut && kinds.length && hard / kinds.length > MAX_HARD_CUT_SHARE) warnings.push(`${hard} of ${kinds.length} transitions are hard cuts; at most a third.`);

  // 3. whole-frame hit budget
  const hits = [];
  scenes.forEach((s, i) => hitsOf(s.shot).forEach((h) => hits.push({ h, i, at: times[i].start })));
  if (hits.length > MAX_HITS) warnings.push(`${hits.length} whole-frame hits; at most ${MAX_HITS}.`);
  for (let k = 1; k < hits.length; k++) {
    if (hits[k].at - hits[k - 1].at < MIN_HIT_GAP_S) warnings.push(`Scene ${hits[k].i + 1}: ${hits[k].h} is under ${MIN_HIT_GAP_S} s after the hit in scene ${hits[k - 1].i + 1}.`);
  }

  // 4. angle per shot + finale at the energy peak
  const body = [];
  scenes.forEach((s, i) => {
    const sh = s.shot;
    if (!is3dShot(s) || !sh) return;
    body.push(i);
    if (sh.density === 'dense' && sh.angle && sh.angle !== 'frontal') warnings.push(`Scene ${i + 1}: dense information shot should be frontal, not ${sh.angle}.`);
    if (sh.text_closeup === true && (sh.angle !== 'side' || sh.text_axis !== 'horizontal')) warnings.push(`Scene ${i + 1}: close-up of text should be side-on and horizontal.`);
  });
  const speeds = body.map((i) => scenes[i].shot.peak_speed).filter(Number.isFinite);
  if (body.length > 1 && speeds.length === body.length) {
    const at = shortsGrammar && body.length >= 5 ? body.length - 4 : body.length - 1; // grammar: the peak shot is the one two before the payoff (hold, payoff, cta follow it)
    const top = scenes[body[at]].shot.peak_speed;
    if (!speeds.every((v, k) => k === at || top > v)) warnings.push(shortsGrammar && at !== body.length - 1
      ? `Scene ${body[at] + 1}: the peak shot must have the highest camera peak speed.`
      : `Scene ${body[body.length - 1] + 1}: the last body shot must have the highest camera peak speed (finale at the energy peak).`);
  }
  if (hardcut) warnings.push(...hardcutWarnings(scenes, total));
  return warnings;
}

// KAN-658 profile story_hardcut: the cut interval on average, no spin, and no two neighbouring SIZED 3D shots of one size (close or wide, see shotSize;
// unsized shots such as whip are skipped, the same rule as hardcutRuns in the search, so the pairs it names are the ones the search could not separate).
function hardcutWarnings(scenes, total) {
  const out = [], P = GRAMMAR_PROFILES.story_hardcut, tag = 'Profile story_hardcut:';
  const [lo, hi] = P.cutInterval, every = total / scenes.length;
  if (every < lo || every > hi) out.push(`${tag} a cut every ${every.toFixed(1)} s on average; the profile asks for every ${lo}-${hi} s.`);
  const shots = [];
  scenes.forEach((s, i) => {
    if (!is3dShot(s) || !s.shot) return;
    if (isSpinShot(s.shot)) out.push(`${tag} Scene ${i + 1} is an orbit; the profile has none.`);
    shots.push({ i, size: shotSize(s.shot) });
  });
  for (const [a, b] of hardcutRuns(shots.map((x) => x.size))) out.push(`${tag} Scene ${shots[a].i + 1} and Scene ${shots[b].i + 1} are both ${shots[b].size} shots (no sized shot between them); alternate close and wide.`);
  return out;
}

// Prompt block for the planner; flag off returns the input untouched (supervisor hook appends/returns this).
export function motionLawsPrompt(prompt, opts = {}) {
  if (!motionLawsEnabled(opts)) return prompt;
  const rules = loadMotionRules(RULE_IDS).join('\n');
  return `${prompt}\n\n   Motion laws (motion_laws_v1): give every 3D shot a "technique" from ${TECHNIQUES.join(', ')}; each technique is the hero of one shot only. Use at most ${MAX_KINDS} transition kinds, at least ${MIN_KINDS} on videos over ${LONG_VIDEO_S} s, at most a third hard cuts. At most ${MAX_HITS} whole-frame hits (flash, punch_zoom, shudder, field "hit"), ${MIN_HIT_GAP_S} s apart. Dense information shots frontal; text close-ups side-on and horizontal; the last body shot has the fastest camera.\n   Camera plan (KAN-430): open on a zoom-out reveal (first shot technique crane_rise, a pull-back to a wide view); at least one shot closes in on a named part (a target part id with technique dolly, push_through or crash_zoom); list the key part in "highlight" on the shot that shows it; the shot before the payoff is a hold (nearly still camera; it is added for you); use orbit in at most one shot and never in two shots in a row, and prefer a push-in or a pull-back to a spin.\n${rules}`;
}
