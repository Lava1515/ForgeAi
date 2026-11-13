// KAN-746: skill_build_v1 model chain. Four asks (brief, blockout, secondary forms, detail) instead of one parts list.
// Any throw here is caught by getModel/getProp, which run today's draftModel instead. Nothing here touches the network:
// the planner is the injected `ask`.
import path from 'node:path';
import { GEMINI_MID_MODEL } from './gemini.js';
import { SHAPE_RULES_V2, validateModel, MAX_PARTS } from './model3d.js';
import { skillsPrompt } from '../camera/knowledgeLoader.js';

export const SKILL_BUILD_DIR = '_skill_v1'; // under modelsDir()/propsDir(); has no model.json of its own, so no lister sees it
export const CLASSES = ['hard_surface', 'vehicle', 'prop', 'organic'];
export const BLOCKOUT_MAX_PARTS = 25;
const POLICY = { skills_in_prompt_v1: true }; // the digests are the point of this flag, independent of the channel's skills_in_prompt_v1
const GAP = 0.05; // floating: gap over 5% of the model size
const FILL = 0.8;
const GROUND_TOL = 0.02;
export const skillBuildRoot = (root) => path.join(root, SKILL_BUILD_DIR);

const num = (v) => Number(v) || 0;
// ponytail: axis-aligned half extents from the declared shape, rot only swaps axes on 90 degree turns, no per-vertex layout;
// upgrade to the worker's part_boxes if a repair loop needs exact boxes.
function halfExtent(p) {
  const g = (v) => (Array.isArray(v) ? v.map(num) : [0, 0, 0]);
  let h;
  switch (p.shape) {
    case 'box': case 'panel': h = g(p.size).map((s) => s / 2); break;
    case 'cylinder': h = [num(p.r), num(p.r), num(p.h) / 2]; break;
    case 'cone': h = [Math.max(num(p.r1), num(p.r2)), Math.max(num(p.r1), num(p.r2)), num(p.h) / 2]; break;
    case 'sphere': h = [num(p.r), num(p.r), num(p.r)]; break;
    case 'torus': h = [num(p.r) + num(p.thickness), num(p.r) + num(p.thickness), num(p.thickness)]; break;
    case 'lathe': { const pr = p.profile || []; const r = Math.max(0, ...pr.map((q) => num(q[0]))); h = [r, r, Math.max(0, ...pr.map((q) => Math.abs(num(q[1]))))]; break; }
    case 'extrude': {
      const o = p.outline || []; const u = Math.max(0, ...o.map((q) => Math.abs(num(q[0])))); const v = Math.max(0, ...o.map((q) => Math.abs(num(q[1])))); const d = num(p.depth) / 2;
      h = { xy: [u, v, d], xz: [u, d, v], yz: [d, u, v] }[p.plane || 'xy'] || [u, v, d]; break;
    }
    case 'loft': {
      const s = p.sections || []; const along = Math.max(0, ...s.map((q) => Math.abs(num(q.at)))); const w = Math.max(0, ...s.map((q) => num(q.w))) / 2; const hh = Math.max(0, ...s.map((q) => num(q.h))) / 2;
      h = { x: [along, w, hh], y: [w, along, hh], z: [w, hh, along] }[p.axis || 'x'] || [along, w, hh]; break;
    }
    case 'tube': { const pts = p.path || []; h = [0, 1, 2].map((k) => Math.max(0, ...pts.map((q) => Math.abs(num(q[k])))) + num(p.r)); break; }
    case 'truss': h = [num(p.length) / 2, num(p.width) / 2, num(p.height) / 2]; break;
    case 'gear': h = [num(p.r) + num(p.tooth_depth), num(p.r) + num(p.tooth_depth), num(p.thickness) / 2]; break;
    default: h = [0, 0, 0];
  }
  const rot = (Array.isArray(p.rot) ? p.rot : [0, 0, 0]).map((a) => Math.round(num(a) / 90) % 2 !== 0);
  if (rot[0]) h = [h[0], h[2], h[1]];
  if (rot[1]) h = [h[2], h[1], h[0]];
  if (rot[2]) h = [h[1], h[0], h[2]];
  return h;
}

function partBox(p) {
  const at = Array.isArray(p.at) ? p.at.map(num) : [0, 0, 0];
  const h = halfExtent(p);
  let lo = at.map((a, k) => a - h[k]);
  let hi = at.map((a, k) => a + h[k]);
  const rep = p.repeat;
  if (rep && num(rep.count) > 1) {
    if (Array.isArray(rep.step)) {
      const end = rep.step.map((s) => num(s) * (num(rep.count) - 1));
      lo = lo.map((l, k) => Math.min(l, l + end[k])); hi = hi.map((x, k) => Math.max(x, x + end[k]));
    } else {
      const r = num(rep.radius); const ax = ['x', 'y', 'z'].indexOf(rep.axis ?? 'z');
      lo = lo.map((l, k) => (k === ax ? l : l - r)); hi = hi.map((x, k) => (k === ax ? x : x + r));
    }
  }
  const mk = p.mirror === 'x' ? 0 : p.mirror === 'y' ? 1 : -1;
  if (mk >= 0) { const l = -hi[mk]; const x = -lo[mk]; lo[mk] = Math.min(lo[mk], l); hi[mk] = Math.max(hi[mk], x); }
  return [lo, hi];
}

const gapBetween = ([al, ah], [bl, bh]) => Math.hypot(...[0, 1, 2].map((k) => Math.max(0, bl[k] - ah[k], al[k] - bh[k])));

// Findings (strings, used as repair text) for a parts-list model. Empty list = conforms.
export function modelConformance(model, { cls = 'prop' } = {}) {
  const out = [];
  const parts = Array.isArray(model?.parts) ? model.parts : [];
  const size = [num(model?.size_m?.length), num(model?.size_m?.width), num(model?.size_m?.height)];
  if (!parts.length || size.some((s) => s <= 0)) return out; // validateModel reports these
  const boxes = parts.map(partBox);
  const maxDim = Math.max(...size);
  boxes.forEach((b, i) => {
    if (boxes.length < 2) return;
    if (!boxes.some((o, j) => j !== i && gapBetween(b, o) <= GAP * maxDim)) out.push(`part ${parts[i].id}: floats; it touches no other part (gap over ${Math.round(GAP * 100)}% of the model size). Move it onto its neighbour.`);
  });
  const lo = [0, 1, 2].map((k) => Math.min(...boxes.map((b) => b[0][k])));
  const hi = [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b[1][k])));
  ['length (x)', 'width (y)', 'height (z)'].forEach((axis, k) => {
    const ext = hi[k] - lo[k];
    if (ext > size[k] * 1.05) out.push(`the parts span ${ext.toFixed(2)} m of ${axis}, outside size_m ${size[k]} m; shrink or move the parts that stick out`);
    else if (ext < size[k] * FILL) out.push(`the parts fill only ${Math.round((ext / size[k]) * 100)}% of size_m ${axis} (${size[k]} m); they must fill at least ${Math.round(FILL * 100)}%`);
  });
  boxes.forEach((b, i) => {
    const ext = [0, 1, 2].map((k) => b[1][k] - b[0][k]);
    if (ext.some((e, k) => e > size[k] * 1.05)) out.push(`part ${parts[i].id}: larger than size_m on an axis`);
  });
  if ((cls === 'prop' || cls === 'vehicle') && Math.abs(lo[2]) > GROUND_TOL) out.push(`the lowest point is at z=${lo[2].toFixed(3)} m; a ${cls} must touch the ground at z=0 (within 2 cm)`);
  return out;
}

const parseJson = (raw) => {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* falls through */ }
  }
  throw new Error('the planner returned no JSON');
};

const modelHead = (story) => `You are a technical 3D modeller building "${story.name}" for a video.${story.facts?.length ? `\nFacts:\n${story.facts.map((f) => `- ${f}`).join('\n')}` : ''}`;
// a function: model3d.js and this file import each other, so SHAPE_RULES_V2 is only read at call time
const format = () => `Mark the parts the story is about "interior": true.
Metres, z up, "size_m": {"length": x, "width": y, "height": z}; every part: {"id", "label", "parent", "stage", "shape", ...shape parameters, "at": [x, y, z] (absolute), "material"}.\n${SHAPE_RULES_V2}`;

const briefPrompt = (story, ref, policy) => `${modelHead(story)}${ref ? `\n${ref}` : ''}
Plan the model before building it. Return ONLY this JSON: {"class": one of ${CLASSES.join(', ')}, "tier": "simple" | "standard" | "hero", "silhouette_features": [3 to 6 short strings], "hierarchy": ["main body", ...], "materials": {"role": "material"}, "scale_anchor": "a real size, e.g. 4.5 m long", "size_m": {"length", "width", "height"}}${skillsPrompt('model_brief', { policy })}`;

const blockPrompt = (story, brief, policy) => `${modelHead(story)}
Brief: ${JSON.stringify(brief)}
Pass 1, the blockout: at most ${BLOCKOUT_MAX_PARTS} primary volumes that give the silhouette, touching each other, filling size_m. Return ONLY {"name", "size_m", "parts": [...]}.
${format()}${skillsPrompt(`model_block_${brief.class}`, { policy })}`;

const formsPrompt = (story, brief, model, policy) => `${modelHead(story)}
Brief: ${JSON.stringify(brief)}
Current model: ${JSON.stringify(model)}
Pass 2, secondary forms: add the forms that make it read (wings, handles, fairings, pipes), keep every existing part id, keep size_m. Return ONLY the full {"name", "size_m", "parts": [...]}.
${format()}${skillsPrompt('model_forms', { policy })}`;

const detailPass = (story, brief, model, policy) => `${modelHead(story)}
Brief: ${JSON.stringify(brief)}
Current model: ${JSON.stringify(model)}
Pass 3, detail: add small real pieces (bolts, panels, vents, windows) on the surfaces, keep every existing part id, keep size_m. Return ONLY the full {"name", "size_m", "parts": [...]}.
${format()}${skillsPrompt('model_detail', { policy })}`;

const briefProblems = (b) => {
  const e = [];
  if (!CLASSES.includes(b?.class)) e.push(`"class" must be one of ${CLASSES.join(', ')}`);
  if (!Array.isArray(b?.silhouette_features) || b.silhouette_features.length < 3 || b.silhouette_features.length > 6) e.push('"silhouette_features" needs 3 to 6 entries');
  if (!b?.scale_anchor) e.push('"scale_anchor" is missing');
  return e;
};

// One planner call, one repair on problems. problemsOf(parsed) -> string[]; returns the parsed value or throws.
async function askWithRepair(ask, prompt, problemsOf, what, calls, emit, tag) {
  const call = async (p) => { calls.n++; return parseJson(await ask(p, { model: GEMINI_MID_MODEL, maxTokens: 8192 })); };
  let out;
  let errors;
  try { out = await call(prompt); errors = problemsOf(out); } catch (err) { out = null; errors = [err.message]; }
  if (!errors.length) return out;
  emit(tag, `${what} has ${errors.length} problem(s); one repair.`);
  const fix = `${prompt}\n\n${out ? `Your previous JSON:\n${JSON.stringify(out)}\n` : ''}It has these problems:\n${errors.map((e) => `- ${e}`).join('\n')}\nReturn the full corrected JSON.`;
  out = await call(fix); // a second bad answer or a throw propagates
  errors = problemsOf(out);
  if (errors.length) throw new Error(`${what} is still invalid (${errors.slice(0, 3).join('; ')})`);
  return out;
}

// Returns a parts-list model with build_passes, or throws (the caller falls back to draftModel).
export async function buildWithSkills(story, { ask, emit = () => {}, tag = 'MODEL', requireInterior = true, reference = null, policy } = {}) {
  void policy; // digests are always on in this chain
  const calls = { n: 0 };
  const refText = reference ? (typeof reference === 'string' ? reference : JSON.stringify(reference)) : '';
  const brief = await askWithRepair(ask, briefPrompt(story, refText, POLICY), briefProblems, 'The brief', calls, emit, tag);
  const cls = brief.class;
  const structural = (m, cap, strictInterior) => {
    const errors = validateModel(m, { requireInterior: strictInterior, shapesV2: true });
    if (!errors.length && cap && m.parts.length > cap) errors.push(`${m.parts.length} parts; the limit for this pass is ${cap}`);
    return errors.length ? errors : modelConformance(m, { cls });
  };
  const keepIds = (prev) => (m) => {
    const ids = new Set((m?.parts || []).map((p) => p?.id));
    const lost = prev.parts.map((p) => p.id).filter((id) => !ids.has(id));
    return lost.length ? [`these part ids are missing and must stay: ${lost.join(', ')}`] : structural(m, MAX_PARTS, false);
  };
  const passes = ['brief'];
  let model = await askWithRepair(ask, blockPrompt(story, brief, POLICY), (m) => structural(m, BLOCKOUT_MAX_PARTS, false), 'The blockout', calls, emit, tag);
  passes.push('blockout');
  const next = async (what, prompt, check) => {
    try {
      const m = await askWithRepair(ask, prompt, check, what, calls, emit, tag);
      model = m;
      passes.push(what);
    } catch (err) {
      emit('WARN', `${what} failed (${err.message}); keeping the last good pass.`);
    }
  };
  await next('forms', formsPrompt(story, brief, model, POLICY), keepIds(model));
  const beforeDetail = model;
  await next('detail', detailPass(story, brief, model, POLICY), keepIds(beforeDetail));
  if (!model.name) model.name = story.name;
  const finalErrors = validateModel(model, { requireInterior, shapesV2: true });
  if (finalErrors.length) throw new Error(`The skill-built model is invalid (${finalErrors.slice(0, 3).join('; ')}).`);
  return { ...model, build_passes: passes };
}
