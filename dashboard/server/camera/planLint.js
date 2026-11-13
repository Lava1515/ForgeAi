// KAN-588 (plan_lint_v1): plan rules checked before the GPU. Pure: lintPlan(plan, {tts, sockets}) -> [{rule, scene, message}].
// scene is the 0-based index, or null for a whole-plan rule. Never mutates the plan. tts ({scenes:[{start,end}]}) is optional:
// without it, scene length comes from the scene's own start/end, else from the word count.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORDS_PER_SECOND = 2.5;
const RUN_SPEED = 3; // m/s a run scene has to cover
const WINDOW_S = 4; // longest stretch without an event
const SHOT_MAX_S = 4.5; // longest shot without an animate tag
const WPS_MIN = 1.5;
const WPS_MAX = 4.2;
const TOUR_CLOSEUP_BY_S = 8;
const TOUR_SHARE = 0.35;
const STILL = new Set(['idle', 'stand', 'wait']);
const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;
const cast = (s) => (Array.isArray(s?.cast) ? s.cast.filter(Boolean) : []);
const fail = (rule, scene, message) => ({ rule, scene, message });

function durations(scenes, tts) {
  return scenes.map((s, i) => {
    const t = tts?.scenes?.[i];
    if (Number.isFinite(t?.start) && Number.isFinite(t?.end) && t.end > t.start) return t.end - t.start;
    if (Number.isFinite(s?.start) && Number.isFinite(s?.end) && s.end > s.start) return s.end - s.start;
    return words(s?.text) / WORDS_PER_SECOND;
  });
}

// ponytail: reads the kit sockets from data/worlds/kits on demand; an unknown kit or socket makes route_length skip, never fail.
const kitCache = new Map();
const KITS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data/worlds/kits');
function kitSockets(kit) {
  if (!/^[a-z0-9_]+$/i.test(kit || '')) return null;
  if (!kitCache.has(kit)) {
    let map = null;
    for (const f of [`${kit}.json`, path.join(kit, 'kit.json')]) {
      try {
        map = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(KITS, f), 'utf8')).sockets.map((k) => [k.id, k.pos]));
        break;
      } catch { /* try the next layout */ }
    }
    kitCache.set(kit, map);
  }
  return kitCache.get(kit);
}

export const RULES = {
  // SG-07, MG-07: the first frame must already move
  scene0(scenes) {
    const s = scenes[0], out = [];
    if (!s) return out;
    if (s.shot?.camera_move === 'hold' || s.shot?.technique === 'hold') out.push(fail('scene0', 0, 'scene 0 camera_move is hold'));
    const c = cast(s);
    if (c.length && c.every((x) => STILL.has(x.action))) out.push(fail('scene0', 0, 'scene 0 has cast but no subject action verb'));
    return out;
  },
  // SG-12: a scene over 4 s needs something happening inside it (scene starts are cuts already)
  dead_window(scenes, { dur }) {
    return scenes.flatMap((s, i) => {
      if (dur[i] <= WINDOW_S) return [];
      const event = (Array.isArray(s.beats) && s.beats.length > 1) || s.shot?.highlight?.length || s.transition
        || cast(s).some((c) => c.from_socket && c.to_socket && c.from_socket !== c.to_socket)
        || (s.props || []).some((p) => p?.state && p.state !== 'idle') || s.shot?.type === 'animate' || s.shot?.tour_part;
      return event ? [] : [fail('dead_window', i, `scene ${i + 1} runs ${dur[i].toFixed(1)} s with no event`)];
    });
  },
  // a run has to cover RUN_SPEED m/s over its window
  route_length(scenes, { dur, sockets }) {
    return scenes.flatMap((s, i) => cast(s).filter((c) => c.action === 'run').flatMap((c) => {
      const map = sockets?.[s.location?.kit] || kitSockets(s.location?.kit);
      const a = map?.[c.from_socket], b = map?.[c.to_socket];
      if (!a || !b) return [];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], (b[2] || 0) - (a[2] || 0));
      return len >= RUN_SPEED * dur[i] ? [] : [fail('route_length', i, `scene ${i + 1} run is ${len.toFixed(1)} m, needs ${(RUN_SPEED * dur[i]).toFixed(1)} m`)];
    }));
  },
  words_per_second(scenes, { dur, tts }) {
    if (!tts?.scenes?.length) return [];
    return scenes.flatMap((s, i) => {
      const w = words(s.text) / dur[i];
      return w >= WPS_MIN && w <= WPS_MAX ? [] : [fail('words_per_second', i, `scene ${i + 1} speaks ${w.toFixed(1)} words per second`)];
    });
  },
  // cast or a hero prop in the scene: the camera follows or targets it, never a bare socket
  cast_target(scenes) {
    return scenes.flatMap((s, i) => {
      if (!cast(s).length && !(s.props || []).length) return [];
      const t = s.shot?.target;
      return s.shot?.follow || (typeof t === 'string' && t && !t.startsWith('socket:')) ? [] : [fail('cast_target', i, `scene ${i + 1} has cast or a prop but the camera targets ${t || 'nothing'} and follows nothing`)];
    });
  },
  // only plans that carry a parts tour
  tour(scenes, { dur }) {
    const idx = scenes.map((s, i) => (s.shot?.tour_part ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return [];
    const start = (i) => (Number.isFinite(scenes[i].start) ? scenes[i].start : dur.slice(0, i).reduce((a, b) => a + b, 0));
    const total = dur.reduce((a, b) => a + b, 0), tour = idx.reduce((a, i) => a + dur[i], 0), out = [];
    if (start(idx[0]) > TOUR_CLOSEUP_BY_S) out.push(fail('tour', idx[0], `first tour close-up at ${start(idx[0]).toFixed(1)} s, wanted by ${TOUR_CLOSEUP_BY_S} s`));
    if (tour / total < TOUR_SHARE) out.push(fail('tour', null, `tour is ${Math.round((100 * tour) / total)} percent of the video, wanted ${TOUR_SHARE * 100}`));
    return out;
  },
  // SG-04
  long_shot(scenes, { dur }) {
    return scenes.flatMap((s, i) => (dur[i] > SHOT_MAX_S && s.shot?.type !== 'animate' && !(s.beats || []).some((b) => b?.shot?.type === 'animate')
      ? [fail('long_shot', i, `scene ${i + 1} holds one shot for ${dur[i].toFixed(1)} s with no animate tag`)] : []));
  },
  // the words and the action have to agree
  text_verb(scenes) {
    return scenes.flatMap((s, i) => {
      const acts = cast(s).map((c) => c.action);
      if (!acts.length) return [];
      const t = String(s.text || '');
      if (/\b(run|runs|running|sprint\w*)\b/i.test(t) && acts.every((a) => STILL.has(a))) return [fail('text_verb', i, `scene ${i + 1} says running but the cast ${acts.join('/')}`)];
      if (/\b(stand|stands|standing|waits?|waiting)\b/i.test(t) && acts.some((a) => a === 'run')) return [fail('text_verb', i, `scene ${i + 1} says standing but the cast runs`)];
      return [];
    });
  },
};

export function lintPlan(plan, { tts = null, sockets = null } = {}) {
  const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
  if (!scenes.length) return [];
  const ctx = { dur: durations(scenes, tts), tts, sockets };
  return Object.values(RULES).flatMap((rule) => rule(scenes, ctx));
}

export const lintMessages = (failures) => failures.map((f) => `plan_lint ${f.rule}: ${f.message}`);

// node planLint.js plan.json [tts.json]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const t0 = Date.now();
  const res = lintPlan(read(process.argv[2]), { tts: process.argv[3] ? read(process.argv[3]) : null });
  console.log(JSON.stringify(res, null, 2));
  console.error(`${res.length} failures in ${Date.now() - t0} ms`);
}
