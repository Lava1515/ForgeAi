// KAN-754: compileKit(brief, templateKit, { seed }) -> a full, valid kit JSON. Code places the props (exact metres), the AI only names what the place holds.
// Recipes (kitRecipes.js) are data extracted from the six scenery_v2 generators; this file turns a brief into positions:
// keep the template's story structure, regenerate the rest, keep sockets and routes clear, avoid overlap, place by zone distance from the story route
// (the scenery_metrics.py layers), fill the three layers, then close every stretch of the route that no prop covers (scenery_metrics.empty_along).
// Deterministic: the only randomness is a generator seeded from sha256(brief, template, seed).
import { createHash } from 'node:crypto';
import { kitRecipes, scenePlans, archetypeRecipes, archetypePlans } from './kitRecipes.js';
import { heroPropErrors, HERO_MAX_TRIANGLES } from './storyKits.js';

// scenery_metrics.py: layer distances (m) of a prop box from the story route, and what a scene sees
export const FG_M = 2.5, MID_M = 8.0, SEE_M = 14.0;
const GAP_RADIUS_M = 3.0, GAP_MIN_HEIGHT_M = 0.3;           // scenery_metrics.empty_along
const SOCKET_CLEAR_M = 1.0, ROUTE_CLEAR_M = 1.0, NEAR_SOCKET_M = 1.5, TOUCH_M = 0.05;
const MAX_PIECE_TRIS = 2500, MAX_TOTAL_TRIS = 45000;       // data/worlds/kits/README.md
const ATTEMPTS = 200, FACADE_WORDS = ['window', 'door', 'storefront', 'awning', 'cornice'];
const ZONES = ['foreground', 'midground', 'background'];
const BANDS = { foreground: [ROUTE_CLEAR_M, FG_M - 0.05], midground: [FG_M + 0.1, MID_M - 0.1], background: [MID_M + 0.2, SEE_M - 0.2] };
const DEFAULT_FILLERS = ['bollard', 'traffic_cone', 'crate', 'signboard'];
const R4 = v => Math.round(v * 1e4) / 1e4;

const stable = v => (v && typeof v === 'object') ? (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`) : JSON.stringify(v);
const sha = v => createHash('sha256').update(stable(v)).digest('hex');
const clone = x => JSON.parse(JSON.stringify(x));
function mulberry32(a) { return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---- scenery_metrics.py, ported (same numbers as the Python acceptance test) ----
export const boxOf = p => {
  const pos = p.pos || p.rel_pos, size = p.size || p.size_m || p.scale;
  return { lo: pos.map((v, i) => v - size[i] / 2), hi: pos.map((v, i) => v + size[i] / 2) };
};
export function kindOf({ lo, hi }, id = '') {
  const s = hi.map((v, i) => v - lo[i]);
  if (Math.max(s[0], s[1]) >= 8.0 && s[2] <= 0.3) return 'ground';
  if (s[2] <= 0.05) return 'marking';
  if (String(id).startsWith('hero_')) return 'detail';   // KAN-757: a hero prop (a lighthouse) is one unique object, not a building of the street
  if (s[2] >= 6.0) return 'building';
  return FACADE_WORDS.some(w => String(id).includes(w)) ? 'facade' : 'detail';
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], d = dx * dx + dy * dy;
  const t = d === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / d));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
const segsOf = route => route.length > 1 ? route.slice(1).map((b, i) => [route[i], b]) : [[route[0], route[0]]];
function routeDist({ lo, hi }, route) {
  const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
  const pts = [[cx, cy], ...[lo[0], hi[0]].flatMap(x => [lo[1], hi[1]].map(y => [x, y])), [cx, lo[1]], [cx, hi[1]], [lo[0], cy], [hi[0], cy]];
  return Math.min(...segsOf(route).flatMap(([a, b]) => pts.map(p => segDist(p, a, b))));
}
export function layerOf(box, route, id) {
  if (['building', 'facade'].includes(kindOf(box, id))) return 'background';
  const d = routeDist(box, route);
  return d <= FG_M ? 'foreground' : d <= MID_M ? 'midground' : 'background';
}
export function sceneryCount(props, route) {
  const out = { foreground: 0, midground: 0, background: 0 };
  for (const p of props) {
    const box = boxOf(p), k = kindOf(box, p.id);
    if (k === 'ground' || (routeDist(box, route) > SEE_M && !['building', 'facade'].includes(k))) continue;
    out[layerOf(box, route, p.id)]++;
  }
  return out;
}
const ptBox = (p, { lo, hi }) => Math.hypot(Math.max(lo[0] - p[0], 0, p[0] - hi[0]), Math.max(lo[1] - p[1], 0, p[1] - hi[1]));
const solidBox = (box, id) => !['ground', 'marking', 'building', 'facade'].includes(kindOf(box, id)) && box.hi[2] - box.lo[2] >= GAP_MIN_HEIGHT_M;
/** Samples of the route as empty_along walks it: [{pt, len}] (1 m steps, one sample per step) per segment. */
function samples(route) {
  const out = [];
  for (let s = 0; s < route.length - 1; s++) {
    const a = route[s], b = route[s + 1], dist = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(Math.trunc(dist), 1);
    for (let i = 0; i < n; i++) out.push({ pt: [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n], len: dist / n });
  }
  return out;
}
export function emptyAlong(props, route) {
  const solids = props.map(p => ({ box: boxOf(p), id: p.id })).filter(s => solidBox(s.box, s.id)).map(s => s.box);
  let best = 0, run = 0;
  for (const { pt, len } of samples(route)) { if (solids.some(b => ptBox(pt, b) <= GAP_RADIUS_M)) run = 0; else { run += len; best = Math.max(best, run); } }
  return Math.round(best * 100) / 100;
}

// ---- planar geometry for the keep-outs ----
function segRect(a, b, lo, hi) {                         // distance (m) in the floor plane between segment a-b and the rectangle lo-hi; 0 when they touch
  let t0 = 0, t1 = 1; const d = [b[0] - a[0], b[1] - a[1]];
  for (let k = 0; k < 2; k++) {
    if (Math.abs(d[k]) < 1e-12) { if (a[k] < lo[k] || a[k] > hi[k]) { t0 = 2; break; } continue; }
    let u = (lo[k] - a[k]) / d[k], v = (hi[k] - a[k]) / d[k]; if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u); t1 = Math.min(t1, v);
  }
  if (t0 <= t1) return 0;
  const corners = [[lo[0], lo[1]], [lo[0], hi[1]], [hi[0], lo[1]], [hi[0], hi[1]]];
  return Math.min(ptBox(a, { lo, hi }), ptBox(b, { lo, hi }), ...corners.map(c => segDist(c, a, b)));
}
const overlaps = (A, B, gap = 0) => [0, 1, 2].every(k => Math.min(A.hi[k], B.hi[k]) - Math.max(A.lo[k], B.lo[k]) > -gap + 1e-6);   // true when the boxes overlap or sit closer than `gap` m
const near3d = (p, { lo, hi }) => Math.hypot(...[0, 1, 2].map(k => Math.max(lo[k] - p[k], 0, p[k] - hi[k])));

// ---- recipe parts ----
const rotate = (parts, q) => {                           // quarter turns counter-clockwise about the item centre (the rule of extract_kit_recipes.py)
  q = ((q % 4) + 4) % 4;
  return q === 0 ? parts : parts.map(p => {
    let [dx, dy] = p.o; for (let i = 0; i < q; i++) [dx, dy] = [-dy, dx];
    const [sx, sy, sz] = p.s;
    return { ...p, o: [R4(dx), R4(dy), p.o[2]], s: q % 2 ? [sy, sx, sz] : [sx, sy, sz] };
  });
};
const extent = parts => ({ hx: Math.max(...parts.map(p => Math.abs(p.o[0]) + p.s[0] / 2)), hy: Math.max(...parts.map(p => Math.abs(p.o[1]) + p.s[1] / 2)), h: Math.max(...parts.map(p => p.o[2] + p.s[2])) });
const world = (parts, cx, cy, base) => parts.map(p => {
  const pos = [R4(cx + p.o[0]), R4(cy + p.o[1]), R4(base + p.o[2] + p.s[2] / 2)];
  return { ...p, pos, ...boxOf({ pos, size: p.s }) };
});
const unionOf = ws => ({ lo: [0, 1, 2].map(k => Math.min(...ws.map(w => w.lo[k]))), hi: [0, 1, 2].map(k => Math.max(...ws.map(w => w.hi[k]))) });


// ---- KAN-757: hero props. A model (the parts of the model chain) becomes one kit prop that carries its own `parts`. ----
const SEGMENTS = 48;                                     // shapes.py SEGMENTS
const GEOMETRY_KEYS = ['id', 'shape', 'material', 'at', 'rot', 'mirror', 'repeat', 'segments', 'plane', 'axis', 'profile', 'outline', 'depth', 'sections', 'size', 'r', 'h', 'r1', 'r2',
  'thickness', 'path', 'bevel', 'length', 'width', 'height', 'bays', 'member', 'teeth', 'tooth_depth'];   // label, parent, stage, interior, motion and anchors are not geometry
const latheTris = (rs, segments, closed = false) => {                           // shapes.lathe: a pole (r ~ 0) is one vertex
  const poles = rs.map((r) => r <= 1e-9);
  const pairs = rs.slice(1).map((_, i) => [poles[i], poles[i + 1]]);
  if (closed) pairs.push([poles[poles.length - 1], poles[0]]);
  return pairs.reduce((n, [a, b]) => n + (a && b ? 0 : a || b ? segments : 2 * segments), 0);
};
function partTriangles(part) {                           // the triangles shapes.geometry builds for one part (quads count 2, n-gons n - 2)
  const num = (v) => { if (!finiteNum(v)) throw new Error(`${part.shape}: a number is missing`); return v; };
  switch (part.shape) {
    case 'lathe': { const seg = part.segments === undefined ? SEGMENTS : Math.floor(num(part.segments)); if (seg < 3 || seg > 256) throw new Error('lathe: segments'); return latheTris(part.profile.map((pt) => num(pt[0])), seg); }
    case 'extrude': return 4 * part.outline.length - 4;
    case 'loft': return 60 + 64 * (part.sections.length - 1);
    case 'box': return 12;
    case 'cylinder': return latheTris([0, num(part.r), num(part.r), 0], 32);
    case 'cone': return latheTris([0, num(part.r1), num(part.r2), 0], 32);
    case 'sphere': return 960;
    case 'torus': return latheTris(Array.from({ length: 12 }, (_, i) => num(part.r) + num(part.thickness) * Math.cos(2 * Math.PI * i / 12)), 32, true);
    case 'tube': return 28 + 32 * (part.path.length - 1);
    case 'panel': return 28;
    case 'truss': { const bays = Math.floor(num(part.bays)); return 12 * (4 + 2 * (bays + 1) + 2 * bays); }
    case 'gear': return 20 * Math.floor(num(part.teeth)) - 4;
    default: throw new Error(`unknown shape ${JSON.stringify(part.shape)}`);
  }
}
/** Triangles the worker builds for a list of model parts, repeat and mirror included. Throws on a part it cannot count. */
export function modelTriangles(parts) {
  return parts.reduce((n, part) => {
    const count = part.repeat?.count === undefined ? 1 : Math.floor(part.repeat.count);
    return n + partTriangles(part) * Math.max(1, count) * (part.mirror === 'x' || part.mirror === 'y' ? 2 : 1);
  }, 0);
}
const heroSlug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
/** A built model -> a hero for the brief: { id, name, zone, size_m (metres), tri_count, parts (geometry only) }. Throws when the model is not a usable hero. */
export function heroSpec(name, model, zone = 'midground') {
  const slug = typeof name === 'string' ? heroSlug(name) : '';
  if (!slug) throw new Error('a hero needs a plain name');
  if (!isObj(model)) throw new Error('a hero needs a model');
  const sz = model.size_m, size = isObj(sz) ? [sz.length, sz.width, sz.height] : null;
  if (!size || !size.every((v) => finiteNum(v) && v > 0)) throw new Error('the model has no usable size_m');
  if (!Array.isArray(model.parts)) throw new Error('the model has no parts');
  const parts = model.parts.map((p) => (isObj(p) ? Object.fromEntries(GEOMETRY_KEYS.filter((k) => p[k] !== undefined).map((k) => [k, clone(p[k])])) : p));
  const hero = { id: `hero_${slug}`, name: String(name).slice(0, 80), zone: ZONES.includes(zone) ? zone : 'midground', size_m: size, tri_count: 0, parts };
  const bad = heroPropErrors({ ...hero, tri_count: HERO_MAX_TRIANGLES }, 'gen_x');
  if (bad.length) throw new Error(bad[0]);
  hero.tri_count = modelTriangles(parts);
  return hero;
}
function cleanHero(h) {                                  // a hero from the brief (untrusted) or null
  try {
    if (!isObj(h) || typeof h.id !== 'string' || !/^[a-z0-9_]{1,60}$/.test(h.id) || !Array.isArray(h.parts)) return null;
    const parts = clone(h.parts), computed = modelTriangles(parts), tri_count = Math.max(computed, finiteNum(h.tri_count) ? h.tri_count : 0);
    const hero = { id: h.id, name: typeof h.name === 'string' ? h.name.slice(0, 80) : h.id, zone: ZONES.includes(h.zone) ? h.zone : 'midground', size_m: clone(h.size_m), tri_count, parts };
    return heroPropErrors(hero, 'gen_x').length ? null : hero;
  } catch { return null; }
}

// KAN-754 review: the brief is planner output (KAN-756), so it is untrusted. Only plain objects, known recipe names (own keys: no __proto__ / constructor),
// finite numbers and bounded counts get through; anything else is ignored, never thrown on.
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const finiteNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const BRIEF_LIMITS = { items: 120, count: 200, wanted: 1500, structures: 60, fillers: 20, route: 500, heroes: 3 };
export function cleanBrief(brief, recipes, plans = scenePlans) {
  const b = isObj(brief) ? brief : {};
  const route = Array.isArray(b.route) && b.route.length > 1 && b.route.length <= BRIEF_LIMITS.route
    && b.route.every((p) => Array.isArray(p) && p.length >= 2 && finiteNum(p[0]) && finiteNum(p[1]) && (p[2] === undefined || finiteNum(p[2])))
    ? b.route.map((p) => [p[0], p[1], p[2] ?? 0]) : undefined;
  const items = [], rejected = { items: 0, structures: 0, heroes: 0 }; let wanted = 0;  // rejected: counted as drops by compileKit, never by the sender's own strings
  for (const it of Array.isArray(b.items) ? b.items.slice(0, BRIEF_LIMITS.items) : []) {
    if (!isObj(it)) continue;
    const count = Math.min(Math.max(1, Math.floor(Number(it.count)) || 1), BRIEF_LIMITS.count);
    if (!own(recipes, it.recipe)) { rejected.items += count; continue; }
    if (wanted + count > BRIEF_LIMITS.wanted) break;
    wanted += count;
    items.push({ recipe: it.recipe, count, ...(ZONES.includes(it.zone) && { zone: it.zone }),
      ...(Array.isArray(it.at) && it.at.length >= 2 && finiteNum(it.at[0]) && finiteNum(it.at[1]) && { at: [it.at[0], it.at[1]] }) });
  }
  const structList = (Array.isArray(b.structures) ? b.structures.slice(0, BRIEF_LIMITS.structures) : []).filter(isObj);
  const structures = structList.filter((st) => own(recipes, st.module) && ['left', 'right', 'back'].includes(st.side))
    .map((st) => ({ module: st.module, side: st.side, ...(Array.isArray(st.floors) && st.floors.length === 2 && st.floors.every((f) => Number.isInteger(f) && f >= 1 && f <= 12) && st.floors[0] <= st.floors[1] && { floors: [st.floors[0], st.floors[1]] }) }));
  const fillers = Array.isArray(b.fillers) ? b.fillers.filter((n) => own(recipes, n)).slice(0, BRIEF_LIMITS.fillers) : undefined;
  rejected.structures = structList.length - structures.length;
  const heroes = [], heroIn = Array.isArray(b.heroes) ? b.heroes.slice(0, 20) : [];
  for (const h of heroIn) { const ok = heroes.length < BRIEF_LIMITS.heroes ? cleanHero(h) : null; if (ok && !heroes.some((x) => x.id === ok.id)) heroes.push(ok); else rejected.heroes++; }
  return { ...(route && { route }), ...(own(plans, b.plan) && { plan: b.plan }), items, structures, heroes, ...(fillers && { fillers }), rejected };
}

/** @returns {object} the compiled kit; kit.compiler_report says what was placed and what was dropped (and why). */
export function compileKit(briefIn = {}, templateKit, { seed, recipes = kitRecipes, plans = scenePlans } = {}) {   // KAN-758: `plans` is the plan table (compileArchetype passes archetypePlans); the default is today's
  const kit = clone(templateKit);
  const hashed = isObj(briefIn) && Array.isArray(briefIn.heroes) && !briefIn.heroes.length ? Object.fromEntries(Object.entries(briefIn).filter(([k]) => k !== 'heroes')) : briefIn;   // no heroes = the same brief as before KAN-757
  let digest; try { digest = sha({ brief: hashed, template: sha(templateKit), seed: seed ?? null }); } catch { digest = sha({ brief: null, template: sha(templateKit), seed: seed ?? null }); }  // an unserialisable brief (BigInt, cycles) still compiles
  const brief = cleanBrief(briefIn, recipes, plans);
  const rng = mulberry32(parseInt(digest.slice(12, 20), 16));
  kit.kit_id = `gen_${digest.slice(0, 12)}`;
  const story = kit.story || {};
  const bounds = kit.bounds || kit.shell?.dimensions_m || { width: 30, depth: 40, height: 20 };
  const floorZ = Number(kit.shell?.floor_elevation_z ?? 0);
  const limit = { lo: [-bounds.width / 2 + 0.05, -bounds.depth / 2 + 0.05, floorZ], hi: [bounds.width / 2 - 0.05, bounds.depth / 2 - 0.05, floorZ + bounds.height] };
  const sockets = (kit.sockets || []).map(s => s.pos || s.position).filter(p => Array.isArray(p));
  const socketLines = sockets.flatMap((a, i) => sockets.slice(i + 1).map(b => [a, b]));
  const walks = (story.walk_paths || []).map(w => w.points).filter(r => Array.isArray(r) && r.length > 1);
  const longAxis = bounds.width >= bounds.depth;
  const routes = Array.isArray(brief.route) && brief.route.length > 1 ? [brief.route] : walks.length ? walks
    : [longAxis ? [[-bounds.width / 2 + 2, 0, 0], [bounds.width / 2 - 2, 0, 0]] : [[0, -bounds.depth / 2 + 2, 0], [0, bounds.depth / 2 - 2, 0]]];
  const plan = (brief.plan && plans[brief.plan]) || (own(plans, templateKit?.kit_id) && plans[templateKit.kit_id]) || {};
  const structures = [...(plan.structures || []), ...(brief.structures || [])], planned = [...(plan.items || []), ...(brief.items || [])];
  const report = { seed_hash: digest, kept: 0, removed: 0, placed: {}, dropped: 0, dropped_by_reason: {}, dropped_by_recipe: {}, structures: { placed: 0, dropped: 0 } };
  const rejectedBrief = brief.rejected;
  const drop = (name, reason) => { report.dropped++; report.dropped_by_reason[reason] = (report.dropped_by_reason[reason] || 0) + 1; report.dropped_by_recipe[name] = (report.dropped_by_recipe[name] || 0) + 1; return false; };
  for (let k = 0; k < rejectedBrief.items; k++) drop('(rejected)', 'unknown_recipe');
  for (let k = 0; k < rejectedBrief.structures; k++) { report.structures.dropped++; drop('(rejected)', 'unknown_structure'); }
  if (brief.heroes.length || rejectedBrief.heroes) report.heroes = { placed: 0, dropped: 0, dropped_by_id: {} };   // only a brief with heroes says anything about them
  for (let k = 0; k < rejectedBrief.heroes; k++) { report.heroes.dropped++; drop('(rejected)', 'invalid_hero'); }

  // 1. keep: ground-class props (floor slabs and paint), story-state props, props within 1.5 m of a socket, and what touches those (the pad deck under the missile)
  const props = kit.props || [];
  const entries = props.map(p => { const box = boxOf(p); return { p, box, kind: kindOf(box, p.id) }; });
  const groundClass = e => ['ground', 'marking'].includes(e.kind) && e.box.lo[2] <= 0.35;
  const stateIds = new Set([...Object.keys(story.states || {}), ...Object.keys(story.prop_states || {}), ...props.filter(p => Array.isArray(p.states)).map(p => p.id)]);
  const keep = new Set(entries.filter(e => groundClass(e)));
  if (!planned.length && !structures.length) entries.forEach(e => keep.add(e));   // nothing to regenerate with: the template stays as it is (gap fill still runs)
  const queue = entries.filter(e => !groundClass(e) && (stateIds.has(e.p.id) || sockets.some(s => near3d(s, e.box) <= NEAR_SOCKET_M)));
  for (const e of queue) keep.add(e);
  while (queue.length) {
    const e = queue.pop();
    for (const o of entries) if (!keep.has(o) && !groundClass(o) && overlaps(e.box, o.box, TOUCH_M)) { keep.add(o); queue.push(o); }
  }
  const kept = entries.filter(e => keep.has(e));
  report.kept = kept.length; report.removed = entries.length - kept.length;
  const usedIds = new Set(kept.map(e => e.p.id));
  const tops = kept.filter(e => e.kind === 'ground' && e.box.lo[2] <= 0.35).map(e => e.box);
  const surfaceTop = (x, y, hx = 0, hy = 0) => R4(Math.max(floorZ, ...[[0, 0], [-1, -1], [-1, 1], [1, -1], [1, 1]].flatMap(([dx, dy]) => tops.filter(b => b.lo[0] <= x + dx * hx && x + dx * hx <= b.hi[0] && b.lo[1] <= y + dy * hy && y + dy * hy <= b.hi[1]).map(b => b.hi[2]))));
  const solids = kept.filter(e => !groundClass(e)).map(e => e.box);
  const out = [];                                          // generated props, in placement order
  let total = kept.reduce((n, e) => n + (e.p.tri_count || 12), 0), budgetHit = false;

  const clear = (u, extra = []) => {                       // keep-outs of a candidate union box; false = rejected
    const lo2 = [u.lo[0], u.lo[1]], hi2 = [u.hi[0], u.hi[1]];
    if (u.lo.some((v, k) => v < limit.lo[k] - 1e-6) || u.hi.some((v, k) => v > limit.hi[k] + 1e-6)) return 'bounds';
    if (sockets.some(s => ptBox(s, u) < SOCKET_CLEAR_M) || socketLines.some(([a, b]) => segRect(a, b, lo2, hi2) < SOCKET_CLEAR_M)) return 'socket';
    if (routes.some(r => segsOf(r).some(([a, b]) => segRect(a, b, lo2, hi2) < ROUTE_CLEAR_M))) return 'route';
    return null;
  };
  const free = (ws, gap = 0.02) => {                       // no overlap with any solid (kept or generated), 2 cm apart; parts of one item may touch
    const u = unionOf(ws);
    for (const s of solids) { if (overlaps(u, s, gap)) { for (const w of ws) if (overlaps(w, s, gap)) return false; } }
    return true;
  };
  const commit = (name, ws, zone, role) => {
    let id = `${name}_${(report.placed[name] || 0) + 1}`;
    while (usedIds.has(id) || ws.some(w => usedIds.has(w.n ? `${id}_${w.n}` : id))) id += 'g';
    report.placed[name] = (report.placed[name] || 0) + 1;
    for (const w of ws) {
      const pid = w.n ? `${id}_${w.n}` : id; usedIds.add(pid);
      out.push({ id: pid, primitive: w.p, mesh_type: `procedural_${w.p}`, rel_pos: w.pos, rot_deg: [0, 0, w.r || 0], size_m: w.s, scale: w.s, clay_palette: w.c, tri_count: w.t,
        collision: Math.min(...w.s) >= 0.05, layer: 'dressing', zone, ...(role ? { surface_role: role } : {}) });
      solids.push({ lo: w.lo, hi: w.hi }); total += w.t;
    }
    return true;
  };
  const tris = parts => parts.reduce((n, p) => n + p.t, 0);

  // 2. structures: a row of 4 m facade modules (or any recipe) along a side of the ground, the street's building rows
  const rowSpec = side => {
    const g = kept.filter(e => e.kind === 'ground').map(e => e.box), gap = recipes.facade_row?.module?.face_gap_m ?? 0.5;
    const edge = { left: Math.min(limit.lo[0] + 0.05, ...g.map(b => b.lo[0])), right: Math.max(limit.hi[0] - 0.05, ...g.map(b => b.hi[0])), back: Math.max(limit.hi[1] - 0.05, ...g.map(b => b.hi[1])) };
    if (side === 'left') return { face: (g.length ? Math.min(...g.map(b => b.lo[0])) : limit.lo[0]) - gap, q: 0, axis: 1, from: limit.lo[1], to: limit.hi[1], edge: edge.left };
    if (side === 'right') return { face: (g.length ? Math.max(...g.map(b => b.hi[0])) : limit.hi[0]) + gap, q: 2, axis: 1, from: limit.lo[1], to: limit.hi[1], edge: edge.right };
    return { face: (g.length ? Math.max(...g.map(b => b.hi[1])) : limit.hi[1]) + gap, q: 3, axis: 0, from: limit.lo[0], to: limit.hi[0], edge: edge.back };
  };
  const facadeParts = (m, floors, idx) => {
    const w = m.window, H = R4(w.first_z - w.size[2] / 2 + w.pitch_m * floors + m.storey_extra_m + 0.75), box = (n, s, dx, zc, c) => ({ n, p: 'box', s, o: [dx, 0, R4(zc - s[2] / 2)], c, t: 12 });
    const parts = [box('body', [m.depth_m, m.module_m, H], -m.depth_m / 2, H / 2, m.body_palettes[Math.floor(rng() * m.body_palettes.length)]),
      box('storefront', m.storefront.size, m.storefront.dx, m.storefront.z, 'glass'),
      box('awning', m.awning.size, m.awning.dx, m.awning.z, m.awning.palettes[Math.floor(rng() * m.awning.palettes.length)]),
      box('cornice', m.cornice.size, m.cornice.dx, H - m.cornice.inset_z, 'metal')];
    if (idx % 2 === 0) { parts.push(box('door', m.door.size, m.door.dx, m.door.z, 'dark'), box('step', m.step.size, m.step.dx, m.step.z, m.step.palette)); }
    parts.push(box('shopsign', m.shopsign.size, m.shopsign.dx, m.shopsign.z, m.shopsign.palettes[Math.floor(rng() * m.shopsign.palettes.length)]),
      box('pilaster', [m.pilaster.size[0], m.pilaster.size[1], H - m.pilaster.inset_z - m.pilaster.from_z], m.pilaster.dx, (m.pilaster.from_z + H - m.pilaster.inset_z) / 2, m.pilaster.palette));
    parts[parts.length - 1].o[1] = -m.module_m / 2 + m.pilaster.size[1] / 2;
    for (let k = 0; k < floors; k++) {
      parts.push(box(`window_${k + 1}`, w.size, w.dx, w.first_z + k * w.pitch_m, w.palette), box(`sill_${k + 1}`, m.sill.size, m.sill.dx, w.first_z + k * w.pitch_m - m.sill.below_window_m, m.sill.palette));
    }
    if (idx % 2 === 1) parts.push(...m.roof.map(r => ({ ...r, o: [r.o[0], r.o[1], R4(H + r.o[2])], n: `roof_${r.n}` })));
    return parts;
  };
  for (const st of structures) {
    const m = recipes[st.module]?.module;
    if (!['left', 'right', 'back'].includes(st.side) || !m) { report.structures.dropped++; drop(st.module, 'unknown_structure'); continue; }
    const row = rowSpec(st.side), [fa, fb] = st.floors || m.floors;
    const depth = Math.min(m.depth_m, Math.abs(row.edge - row.face));
    if (depth < 1.5) { report.structures.dropped++; drop(st.module, 'no_room'); continue; }
    const n = Math.floor((row.to - row.from) / m.module_m);
    for (let i = 0; i < n; i++) {
      const c = row.from + m.module_m * (i + 0.5), floors = fa + Math.floor(rng() * (fb - fa + 1));
      const parts = rotate(facadeParts({ ...m, depth_m: depth }, floors, i), row.q);
      const ws = world(parts, row.axis === 1 ? row.face : c, row.axis === 1 ? c : row.face, floorZ), u = unionOf(ws);
      if (total + tris(parts) > MAX_TOTAL_TRIS) { budgetHit = true; report.structures.dropped++; drop(st.module, 'budget'); continue; }
      const why = clear(u);
      if (why || !free(ws, 0)) { report.structures.dropped++; drop(st.module, why || 'overlap'); continue; }
      commit('facade_row', ws, 'background'); report.structures.placed++;
    }
  }

  // 2b. heroes (KAN-757): one unique object each, a single box with its parts inlined; same keep-outs as an item, own triangle cap, never fails the kit
  const placeHero = (hero) => {
    const [sx, sy, sz] = hero.size_m, route = routes[0], segs = segsOf(route), lens = segs.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1])), len = lens.reduce((a, b) => a + b, 0);
    const [lo, hi] = BANDS[hero.zone] || BANDS.midground, half = Math.max(sx, sy) / 2;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      let u = rng() * len, k = 0; while (k < segs.length - 1 && u > lens[k]) u -= lens[k++];
      const [a, b] = segs[k], t = lens[k] ? u / lens[k] : 0, tx = lens[k] ? (b[0] - a[0]) / lens[k] : 1, ty = lens[k] ? (b[1] - a[1]) / lens[k] : 0;
      const side = rng() < 0.5 ? -1 : 1, nx = -ty * side, ny = tx * side, d = lo + rng() * (hi - lo), px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
      const cx = R4(px + nx * (d + half)), cy = R4(py + ny * (d + half)), surf = surfaceTop(cx, cy, sx / 2, sy / 2);
      const box = { lo: [cx - sx / 2, cy - sy / 2, surf], hi: [cx + sx / 2, cy + sy / 2, surf + sz] };
      if (clear(box) || layerOf(box, route, hero.id) !== hero.zone || !free([box])) continue;
      let id = hero.id; while (usedIds.has(id)) id += 'g';
      usedIds.add(id); solids.push(box); total += hero.tri_count;
      out.push({ id, mesh_type: 'procedural_hero', hero_name: hero.name, rel_pos: [cx, cy, R4(surf + sz / 2)], rot_deg: [0, 0, 0], size_m: [sx, sy, sz], scale: [sx, sy, sz], tri_count: hero.tri_count,
        collision: true, layer: 'dressing', zone: hero.zone, parts: clone(hero.parts) });
      return true;
    }
    return 'no_room';
  };
  for (const hero of brief.heroes) {
    const why = total + hero.tri_count > MAX_TOTAL_TRIS ? 'budget' : placeHero(hero);
    if (why === true) { report.heroes.placed++; continue; }
    report.heroes.dropped++; report.heroes.dropped_by_id[hero.id] = why; drop(hero.id, why);
  }

  // 3. one item at a time: a point on the story route, a side, a distance inside the zone's band, a facing; check every keep-out
  const place = (name, zone, ri, { at, fixedVariant } = {}) => {            // true when placed, else the reason
    const rec = recipes[name];
    if (!rec?.variants?.length) return 'unknown_recipe';
    const variant = rec.variants[fixedVariant ?? Math.floor(rng() * rec.variants.length)];
    if (variant.parts.some(p => p.t > MAX_PIECE_TRIS)) return 'piece_budget';
    if (total + tris(variant.parts) > MAX_TOTAL_TRIS) { budgetHit = true; return 'budget'; }
    const route = routes[ri % routes.length], segs = segsOf(route), lens = segs.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1])), len = lens.reduce((a, b) => a + b, 0);
    const [lo, hi] = BANDS[zone] || BANDS.midground;
    for (let attempt = 0; attempt < (at ? 1 : ATTEMPTS); attempt++) {
      let cx, cy, q;
      if (at) { [cx, cy] = at; q = 0; } else {
        let u = rng() * len, k = 0; while (k < segs.length - 1 && u > lens[k]) u -= lens[k++];
        const [a, b] = segs[k], t = lens[k] ? u / lens[k] : 0, tx = lens[k] ? (b[0] - a[0]) / lens[k] : 1, ty = lens[k] ? (b[1] - a[1]) / lens[k] : 0;
        const side = rng() < 0.5 ? -1 : 1, nx = -ty * side, ny = tx * side, d = lo + rng() * (hi - lo), px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
        const [fx, fy] = variant.fp;
        q = rec.orient === 'front' ? Math.round(Math.atan2(-ny, -nx) / (Math.PI / 2))
          : rec.orient === 'along' ? Math.round((Math.atan2(ty, tx) - (fx >= fy ? 0 : Math.PI / 2)) / (Math.PI / 2)) : Math.floor(rng() * 4);
        const parts = rotate(variant.parts, q), e = extent(parts), hn = Math.abs(nx) * e.hx + Math.abs(ny) * e.hy;
        cx = px + nx * (d + hn); cy = py + ny * (d + hn);
      }
      const parts = rotate(variant.parts, q), e = extent(parts), surf = surfaceTop(cx, cy, e.hx, e.hy);
      if (!rec.anchored && Math.abs(surf - rec.surface_top) > 0.011) continue;
      const ws = world(parts, cx, cy, surf + (rec.anchored ? 0 : rec.lift)), u = unionOf(ws);
      if (clear(u) || (!at && layerOf(u, route, name) !== zone) || !free(ws)) continue;
      return commit(name, ws, zone, rec.surface_role);
    }
    return 'no_room';
  };
  const wanted = planned.flatMap(it => Array.from({ length: Math.min(Math.max(1, Math.floor(Number(it.count) || 1)), BRIEF_LIMITS.count) }, () => it)).slice(0, BRIEF_LIMITS.wanted);
  const volume = it => { const f = recipes[it.recipe]?.variants?.[0]?.fp; return f ? f[0] * f[1] * f[2] : 0; };
  const order = wanted.map((it, i) => ({ it, i })).sort((a, b) => volume(b.it) - volume(a.it) || a.i - b.i);
  order.every(({ it, i }, n) => {
    if (budgetHit) { order.slice(n).forEach((r) => drop(r.it.recipe, 'budget')); return false; }   // the triangle budget is spent: the rest is dropped in one go, not placed
    let why = 'no_room';
    for (let k = 0; k < (Array.isArray(it.at) ? 1 : routes.length) && why !== true; k++) {   // the next route is the second chance
      why = place(it.recipe, ZONES.includes(it.zone) ? it.zone : 'midground', i + k, { at: Array.isArray(it.at) ? it.at : null });
      if (why === 'unknown_recipe' || why === 'budget' || why === 'piece_budget') break;
    }
    if (why !== true) drop(it.recipe, why);
    return true;
  });

  // 4. the three layers: every one holds at least one prop on the first route
  const live = () => [...kept.map(e => ({ ...e.p, id: e.p.id })), ...out];
  for (const zone of ZONES) {
    const names = [...new Set((plan.items || []).filter(i => i.zone === zone).map(i => i.recipe))];
    const pool = names.length ? names : Object.keys(recipes).filter(n => recipes[n].variants?.length && !recipes[n].anchored && recipes[n].variants[0].fp[2] < 6);
    for (let i = 0; i < pool.length * 3 && sceneryCount(live(), routes[0])[zone] === 0; i++) place(pool[i % pool.length], zone, 0);
  }

  // 5. gap fill: close every stretch of every route that no prop at least 0.3 m tall covers within 3 m
  const fillers = (brief.fillers || plan.fillers || DEFAULT_FILLERS).filter(n => own(recipes, n) && recipes[n]?.variants?.length);
  const rings = [1.4, 2.0, 2.5, 1.7, 2.2, 2.8, 2.95].flatMap(r => Array.from({ length: 24 }, (_, k) => [r, (k * Math.PI) / 12]));
  const coverable = ws => ws.some(w => solidBox(w, w.n ? `x_${w.n}` : 'x') && w.hi[2] - w.lo[2] >= GAP_MIN_HEIGHT_M);
  let unfilled = 0;
  routes.forEach(route => {
    const smp = samples(route), skip = new Set();
    for (let guard = 0; guard < 400; guard++) {
      const eligible = live().map(p => ({ box: boxOf(p), id: p.id })).filter(s => solidBox(s.box, s.id)).map(s => s.box);
      const open = smp.map((s, i) => (!skip.has(i) && !eligible.some(b => ptBox(s.pt, b) <= GAP_RADIUS_M)) ? i : -1);
      let best = [], run = [];
      open.forEach(i => { if (i < 0) run = []; else { run.push(i); if (run.length > best.length) best = run.slice(); } });
      if (!best.length) break;
      const order = best.map((_, k) => best[Math.floor(best.length / 2) + (k % 2 ? 1 : -1) * Math.ceil(k / 2)]).filter(i => i !== undefined);
      let done = false;
      for (const i of order) {
        const [px, py] = smp[i].pt;
        for (let f = 0; f < fillers.length && !done; f++) {
          const name = fillers[(guard + f) % fillers.length], rec = recipes[name], variant = rec.variants[Math.floor(rng() * rec.variants.length)];
          if (total + tris(variant.parts) > MAX_TOTAL_TRIS) { budgetHit = true; continue; }
          for (const [r, ang] of rings) {
            const parts = rotate(variant.parts, Math.floor(rng() * 4)), e = extent(parts), cx = px + r * Math.cos(ang), cy = py + r * Math.sin(ang), surf = surfaceTop(cx, cy, e.hx, e.hy);
            if (Math.abs(surf - rec.surface_top) > 0.011) continue;
            const ws = world(parts, cx, cy, surf + rec.lift), u = unionOf(ws);
            if (!coverable(ws) || ptBox([px, py], u) > GAP_RADIUS_M - 0.02 || clear(u) || !free(ws)) continue;
            commit(name, ws, 'foreground', rec.surface_role); report.gap_fill = (report.gap_fill || 0) + 1; done = true; break;
          }
        }
        if (done) break;
      }
      if (!done) { best.forEach(i => skip.add(i)); unfilled += best.length; }
    }
  });
  kit.props = [...kept.map(e => e.p), ...out];
  report.total_triangles = total;
  report.layers = sceneryCount(kit.props, routes[0]);
  report.empty_along = routes.map(r => emptyAlong(kit.props, r));
  report.unfilled_samples = unfilled;
  kit.compiler_report = report;
  return kit;
}
export default compileKit;

// ---- KAN-758 (Skill Build SB10): archetypes. A story can take place where no fixed kit fits: open ground, a walled room, a void. ----
// archetypeTemplate(name, brief) is a template kit built in code (a ground slab or a shell, a named lighting rig, 4 to 6 sockets from one pattern scaled to the bounds, story tags);
// compileArchetype fills it through compileKit with the archetype's own recipes. The brief is planner output, so untrusted: sizes are clamped, tags and label are plain words,
// the plan and the socket count come from fixed tables. Nothing here reads a path, a kit id or a recipe from the brief.
export const ARCHETYPES = Object.freeze(['outdoor', 'interior', 'void']);
export const parseArchetype = (value) => { const m = typeof value === 'string' ? /^archetype:(outdoor|interior|void)$/.exec(value) : null; return m ? m[1] : null; };

const ARCH = {
  outdoor: { name: 'Open ground', category: 'outdoor', size: [60, 60, 20], lo: [30, 30], hi: [120, 120], rig: 'outdoor_noon', ambient: 'sky', plan: 'forest', placement: 'ground', label: 'open ground under the sun',
    keywords: ['outdoor', 'outside', 'forest', 'woods', 'field', 'meadow', 'trail', 'clearing'] },
  interior: { name: 'Room', category: 'indoor_home', size: [9, 11, 3], lo: [5, 6], hi: [16, 20], rig: 'three_point', ambient: 'studio', plan: 'home_interior', placement: 'ground', label: 'a walled room with a ceiling',
    keywords: ['indoor', 'inside', 'room', 'home', 'house', 'kitchen', 'bedroom', 'living room'] },
  void: { name: 'Void', category: 'outdoor_space', size: [80, 80, 40], lo: [40, 40], hi: [200, 200], rig: 'space', ambient: 'space', plan: 'void_field', placement: 'float', label: 'a dark void',
    keywords: ['void', 'space', 'darkness', 'nothing', 'abyss', 'deep space', 'weightless'] },
};
const SOCKET_PATTERN = [   // in the order they are taken when 4 to 6 sockets are wanted: u along the depth (-1 front .. 1 back), v across (a zig-zag so the lines between sockets stay in one narrow band)
  { id: 'entry', u: -1, v: 0, yaw: 0 }, { id: 'center', u: 0, v: 0, yaw: 0 }, { id: 'far', u: 1, v: 0, yaw: 180 },
  { id: 'west_mark', u: -0.5, v: -1, yaw: 0 }, { id: 'east_mark', u: 0.5, v: 1, yaw: 0 }, { id: 'overlook', u: 0.25, v: -1, yaw: 90 }];
const TAG_OK = /^[a-z0-9][a-z0-9 _-]{0,23}$/, TAG_DENY = new Set(['constructor', 'prototype', 'tostring', 'valueof', 'hasownproperty']), MAX_TAGS = 8;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const plainTags = (list) => (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string').map((x) => x.trim().toLowerCase()).filter((x) => TAG_OK.test(x) && !TAG_DENY.has(x));
const plainLabel = (v) => (typeof v === 'string' ? v.replace(/[^\p{L}\p{N} ,.'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80) : '');

export function archetypeTemplate(name, briefIn = {}) {
  if (!own(ARCH, name)) throw new Error(`unknown archetype ${JSON.stringify(String(name).slice(0, 40))}`);
  const a = ARCH[name], b = isObj(briefIn) ? briefIn : {};
  const dim = (v, def, k) => (finiteNum(v) ? R4(clamp(v, a.lo[k], a.hi[k])) : def);
  const W = dim(b.width, a.size[0], 0), D = dim(b.depth, a.size[1], 1), H = a.size[2];
  const count = Number.isInteger(b.sockets) ? clamp(b.sockets, 4, 6) : 5, z = name === 'void' ? H / 2 : 0;
  const sockets = SOCKET_PATTERN.slice(0, count).map((s) => ({ id: s.id, pos: [R4(s.v * W * 0.1), R4(s.u * D * 0.4), z], rot_deg: [0, 0, s.yaw] }));
  const tags = [...new Set([name, ...plainTags(b.tags)])].slice(0, MAX_TAGS);
  const open = (reason) => Object.fromEntries(['back_pos_y', 'left_neg_x', 'right_pos_x', 'front_neg_y'].map((w) => [w, { enabled: false, reason }]));
  const dims = { width: W, depth: D, height: H };
  const kit = {
    $schema: 'https://forgeai.internal/schemas/location-kit-v1.json', kit_id: `archetype_${name}`, name: a.name, category: a.category, version: '1.0.0', author: 'ForgeAI Procedural Worlds Fleet', license: 'CC0-1.0',
    bounds: dims, shell: { dimensions_m: dims, floor_elevation_z: 0, walls: open('open_ground'), ceiling: { enabled: false, style: 'open_sky' }, camera_cutaways: [{ camera_yaw_range_deg: [-180, 180], hide_elements: [] }] },
    ground_floor: { enabled: false }, sockets, props: [], tri_count_budget: { max_triangles_per_piece: MAX_PIECE_TRIS, total_max_triangles: MAX_TOTAL_TRIS },
    clay_look_rules: { bevel_radius_m: 0.015, bevel_segments: 2, procedural_grain: { scale: 60.0, detail: 8.0, bump_strength: 0.35 }, force_metallic_zero: true, default_roughness: 0.65 },
    lighting_rig: { rig_type: a.rig, ambient_floor: a.ambient },
    story: { label: plainLabel(b.label) || a.label, tags, keywords: [...new Set([...a.keywords, ...tags])], placement: a.placement, default_socket: 'center',
      walk_paths: [{ id: 'main', points: sockets.map((s) => s.pos).sort((p, q) => p[1] - q[1]) }] },
  };
  if (name === 'outdoor') {
    kit.ground_floor = { material_type: 'pbr_tiled', preset: 'grass', asset_id: 'grass_ground', metres_per_tile: 4.0, clay_roughness: 0.8, clay_bump_strength: 0.3 };
    kit.sky_environment = { type: 'hdri_lit_soft_backdrop', hdri_preset: 'noon', hdri_asset_id: 'syferfontein_18d_clear_puresky', backdrop_mode: 'soft_clay', sun_enabled: true };
    kit.props = [{ id: 'meadow', primitive: 'box', mesh_type: 'procedural_box', rel_pos: [0, 0, 0.03], rot_deg: [0, 0, 0], scale: [R4(W * 0.9), R4(D * 0.9), 0.06], size_m: [R4(W * 0.9), R4(D * 0.9), 0.06],
      clay_palette: 'clay_skin_deep', tri_count: 12, collision: true }];
  } else if (name === 'interior') {
    const wall = { enabled: true, material: 'hull' };
    kit.shell.walls = { back_pos_y: wall, left_neg_x: wall, right_pos_x: wall, front_neg_y: wall };
    kit.shell.ceiling = { enabled: true, material: 'hull' };
    kit.shell.camera_cutaways = [{ camera_yaw_range_deg: [-180, 180], hide_elements: ['ceiling'] }, { camera_yaw_range_deg: [-60, 60], hide_elements: ['front_neg_y'] },
      { camera_yaw_range_deg: [30, 150], hide_elements: ['left_neg_x'] }, { camera_yaw_range_deg: [-150, -30], hide_elements: ['right_pos_x'] },
      { camera_yaw_range_deg: [120, 180], hide_elements: ['back_pos_y'] }, { camera_yaw_range_deg: [-180, -120], hide_elements: ['back_pos_y'] }];
    kit.ground_floor = { material_type: 'pbr_tiled', preset: 'wood_planks', asset_id: 'wood_planks', clay_palette: 'wood', metres_per_tile: 2.0, clay_roughness: 0.6, clay_bump_strength: 0.25 };
    kit.sky_environment = { type: 'hdri_lit_soft_backdrop', hdri_preset: 'overcast', hdri_asset_id: 'kloofendal_overcast_puresky', backdrop_mode: 'soft_clay', sun_enabled: false };
    const piece = (id, primitive, pos, scale, material) => ({ id, primitive, transform: { pos: pos.map(R4), scale: scale.map(R4) }, material });   // a window and a door on the walls: pieces, so the compiler leaves them where they are
    kit.modular_pieces = [piece('window_frame', 'box', [0, D / 2 - 0.04, 1.5], [W * 0.3, 0.06, 1.3], 'dark'), piece('window_glass', 'box', [0, D / 2 - 0.06, 1.5], [W * 0.3 - 0.2, 0.03, 1.1], 'glass'),
      piece('door_frame', 'box', [-W / 2 + 0.04, -D * 0.25, 1.05], [0.06, 1.0, 2.1], 'wood')];
  } else {
    kit.shell.walls = open('open_void');
    kit.shell.ceiling = { enabled: false, style: 'void' };
    kit.sky_environment = { type: 'procedural_starfield', asset_id: 'procedural', backdrop_mode: 'soft_clay', sun_enabled: false };
    kit.fog = { enabled: false };
    kit.lighting = { background: { color: [0.004, 0.005, 0.012, 1.0], strength: 1.0 } };
  }
  return kit;
}

/** The archetype template filled from a brief: its own recipes only (a street lamp is not a forest recipe), its plan unless the brief names another plan of the same archetype. */
export function compileArchetype(name, briefIn = {}, { seed } = {}) {
  const template = archetypeTemplate(name, briefIn), b = isObj(briefIn) ? briefIn : {};
  const planName = own(archetypePlans, b.plan) && archetypePlans[b.plan].archetype === name ? b.plan : ARCH[name].plan;
  const allowed = new Set(archetypePlans[planName].recipes), all = { ...kitRecipes, ...archetypeRecipes };
  const recipes = Object.fromEntries(Object.keys(all).filter((n) => allowed.has(n)).map((n) => [n, all[n]]));
  return compileKit({ ...b, plan: planName }, template, { seed, recipes, plans: archetypePlans });
}
