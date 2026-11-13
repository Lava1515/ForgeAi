// KAN-756 (Skill Build SB8): every story location gets its own generated kit when policy.skill_build_v1 === true.
// Per location: scene brief (injected `ask`) -> kitCompiler -> validateKit -> <worlds>/generated_kits/gen_<key>.json. ANY failure keeps
// today's template kit and says why; nothing here throws and nothing here makes a network call of its own.
// The kit id comes from a hash of the sentences, the template file and the recipe names, never from the brief, so a hostile brief
// cannot name a path, and the same sentences + template reuse the file with no AI call.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { planSceneBrief } from './skillBuildScene.js';
import { compileKit, heroSpec, BRIEF_LIMITS } from './kitCompiler.js';
import { kitRecipes } from './kitRecipes.js';
import { validateKit, buildCatalogEntry, MAX_TOTAL_TRIANGLES } from './storyKits.js';
import { generatedKitPath, resolveWorldsDir } from './worldsDir.js';

export const skillBuildOn = (policy) => policy?.skill_build_v1 === true;
const KIT_ID = /^[A-Za-z0-9_-]+$/;
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const note = (e) => String(e?.message || e).slice(0, 160);
const RECIPES = Object.keys(kitRecipes);

class Fallback extends Error {}
const fail = (why) => { throw new Fallback(why); };

function readTemplate(id, worlds) {
  if (typeof id !== 'string' || !KIT_ID.test(id) || id.startsWith('gen_')) fail(`template kit id ${JSON.stringify(String(id).slice(0, 40))} is not a plain template id`);
  const file = [path.join(worlds, 'kits', `${id}.json`), path.join(worlds, 'kits', id, 'kit.json')].find((f) => fs.existsSync(f));
  if (!file) fail(`template kit "${id}" has no file in ${path.join(worlds, 'kits')}`);
  try { const text = fs.readFileSync(file, 'utf8'); return { text, kit: JSON.parse(text) }; } catch (e) { return fail(`template kit "${id}" unreadable: ${note(e)}`); }
}

// The scene brief is a story-level description; the compiler wants counted recipe items. Names that are not recipes are skipped (the brief's
// cluster items are free text for the model, only recipe names become geometry). ponytail: every named item counts once (repeats add up),
// the focal goes to the midground; leading_line waits for KAN-758. hero_prop names are built by buildHeroes (KAN-757).
function compilerBrief(b) {
  const items = [];
  const add = (recipe, zone) => {
    if (!own(kitRecipes, recipe)) return;
    const hit = items.find((i) => i.recipe === recipe && i.zone === zone);
    if (hit) hit.count++; else items.push({ recipe, count: 1, zone });
  };
  add(b.focal.recipe, 'midground');
  for (const c of b.clusters) for (const n of c.items) add(n, c.zone);
  return { items, structures: b.structures.map(({ module, side, floors }) => ({ module, side, floors })) };
}

// KAN-757: each hero_prop name in the brief (the focal's, then the clusters', unique by name, at most BRIEF_LIMITS.heroes) goes through getProp with the flag on.
// A prop that cannot be built or does not fit as a hero drops out with a WARN; it never fails the location.
async function buildHeroes(brief, { ask, policy, getProp, warn, label }) {
  const named = [];
  const add = (name, zone) => {
    if (typeof name !== 'string' || !name.trim()) return;
    const key = name.trim().toLowerCase();
    if (!named.some((n) => n.key === key)) named.push({ key, name: name.trim(), zone });
  };
  add(brief.focal?.hero_prop, 'midground');
  for (const c of brief.clusters || []) add(c.hero_prop, c.zone);
  const heroes = [];
  for (const { name, zone } of named.slice(0, BRIEF_LIMITS.heroes)) {
    try {
      const build = getProp || (await import('./model3d.js')).getProp;
      const prop = await build(name, { ask, policy });
      heroes.push(heroSpec(name, prop?.model, zone));
    } catch (e) { warn(`WARN skill_build_v1: hero "${name}" for ${label} dropped: ${note(e)}`); }
  }
  return heroes;
}

async function generate({ location, sentences, ask, policy, worlds, getProp, warn = () => {}, label }) {
  const template = readTemplate(location.kit, worlds);
  const key = sha({ v: 1, sentences, template: sha(template.text), recipes: [...RECIPES].sort() }).slice(0, 12);
  const id = `gen_${key}`, file = generatedKitPath(id, worlds);
  if (!file) fail('generated kit path refused');
  if (fs.existsSync(file)) {                                   // same sentences and template: reuse, no AI call
    try {
      const have = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (have.kit_id === id && !validateKit(have, { worldsDir: worlds }).length) return { id, entry: buildCatalogEntry(have, id), template: location.kit, reused: true };
    } catch { /* unreadable or stale file: generate again */ }
  }
  const brief = await planSceneBrief({ ask, sentences, template: location.kit, recipeNames: RECIPES, policy: { ...policy, skills_in_prompt_v1: true } }); // the digests are the point of this flag
  if (!brief) fail('no valid scene brief from the planner');
  let kit;
  const heroes = await buildHeroes(brief, { ask, policy, getProp, warn, label });
  try { kit = compileKit({ ...compilerBrief(brief), ...(heroes.length && { heroes }) }, template.kit, { seed: key }); } catch (e) { fail(`compile failed: ${note(e)}`); }
  for (const [hid, why] of Object.entries(kit.compiler_report?.heroes?.dropped_by_id || {})) warn(`WARN skill_build_v1: hero "${hid}" for ${label} dropped: ${why === 'budget' ? 'over the triangle budget' : why}`);
  const tris = kit.compiler_report?.total_triangles;
  if (!(tris <= MAX_TOTAL_TRIANGLES)) fail(`over budget: ${tris} triangles (cap ${MAX_TOTAL_TRIANGLES})`);
  kit.kit_id = id;
  const errors = validateKit(kit, { worldsDir: worlds });
  if (errors.length) fail(`kit invalid: ${errors.slice(0, 3).join('; ')}`);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`; // unique per write: two plans making the same kit must not share a temp file
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(kit, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ } fail(`write failed: ${note(e)}`); }
  return { id, entry: buildCatalogEntry(kit, id), template: location.kit, reused: false };
}

/**
 * @returns {{locations: object[], catalog: object, scenery: object|null}} flag off: the SAME locations array, catalog {}, scenery null.
 * Flag on: locations with kit = gen id and template_kit where generated, the catalog entries of the new kits, and per location id
 * scenery[id] = { source: 'generated', kit, template_kit, reused } or { source: 'template', reason }.
 */
export async function planGeneratedKits({ locations, sentences = [], ask, policy, worldsDir, warn = () => {}, getProp } = {}) {
  if (!skillBuildOn(policy) || !Array.isArray(locations)) return { locations, catalog: {}, scenery: null };
  const worlds = worldsDir || resolveWorldsDir();
  const catalog = {}, scenery = {};
  const out = [];
  for (const [i, loc] of locations.entries()) {
    const label = loc?.id ?? `#${i}`;
    try {
      if (!loc || typeof loc !== 'object') fail('location is not an object');
      const from = Math.max(0, Number(loc.from_scene) || 0), to = Math.max(from, Number(loc.to_scene) || from);
      const text = sentences.slice(from, to + 1).map(String);
      const g = await generate({ location: loc, sentences: text.length ? text : sentences.map(String), ask, policy, worlds, getProp, warn, label });
      catalog[g.id] = g.entry;
      scenery[label] = { source: 'generated', kit: g.id, template_kit: g.template, reused: g.reused };
      out.push({ ...loc, kit: g.id, template_kit: g.template });
    } catch (e) {
      const reason = e instanceof Fallback ? e.message : `unexpected: ${note(e)}`;
      warn(`WARN skill_build_v1: location ${label} (${String(loc?.kit).slice(0, 40)}) keeps its template kit: ${reason}`);
      scenery[label] = { source: 'template', reason };
      out.push(loc);
    }
  }
  return { locations: out, catalog, scenery };
}

/** Catalog entries of the generated kits a story names (read from the files by id), so later validation knows them. {} when none. */
export function generatedCatalogFor(story, worldsDir) {
  const out = {};
  const worlds = worldsDir || resolveWorldsDir();
  for (const loc of Array.isArray(story?.locations) ? story.locations : []) {
    const file = typeof loc?.kit === 'string' ? generatedKitPath(loc.kit, worlds) : null;
    if (!file || out[loc.kit]) continue;
    try { out[loc.kit] = buildCatalogEntry(JSON.parse(fs.readFileSync(file, 'utf8')), loc.kit); } catch { /* no file: the story validator reports the unknown kit */ }
  }
  return out;
}

/** Writes the record onto a finished story block: story.scenery_source, and template_kit on a location that kept its generated kit. */
export function stampScenery(story, scenery) {
  if (!scenery || !story || typeof story !== 'object') return story;
  for (const loc of Array.isArray(story.locations) ? story.locations : []) {
    const s = scenery[loc?.id];
    if (s?.source === 'generated' && loc.kit === s.kit) loc.template_kit = s.template_kit;
  }
  story.scenery_source = scenery;
  return story;
}
