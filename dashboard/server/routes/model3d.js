import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { askGemini, GEMINI_MID_MODEL } from './gemini.js';
import { sendGeneric5xx } from './redact.js';
import { figureModel } from './figures.js';
import { parseFigureProp } from './studioPlan.js';
import { getModelReference, referencePromptBlock } from './modelReference.js';
import { matchLibraryModel } from './libraryMatch.js';
import { matchRequirements, materialClass, motionKind } from './storyAssets.js';
import { readJson } from '../lib/objects.js';
import { buildWithSkills, skillBuildRoot } from './skillBuildModel.js';
import { skillsPrompt } from '../camera/knowledgeLoader.js'; // KAN-716: stage digests are enabled by policy.skills_in_prompt_v1

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.FORGEAI_ROOT || path.resolve(__dirname, '../../../');
export const modelsDir = () => process.env.FORGEAI_MODELS_DIR || path.join(REPO_ROOT, 'data/models3d');
const assets3dDir = () => process.env.FORGEAI_ASSETS3D_DIR || path.join(REPO_ROOT, 'data/assets3d');
export const propsDir = () => process.env.FORGEAI_PROPS_DIR || path.join(REPO_ROOT, 'data/props3d');
export const modelChecksDir = () => process.env.FORGEAI_MODEL_CHECKS_DIR || path.join(REPO_ROOT, 'output/temp/model-checks');
export const workerUrl = () => process.env.BLENDER_WORKER_URL || 'http://localhost:8190';

// 3D cutaway models (spec docs/superpowers/specs/2026-10-16-3d-cutaway-shorts-design.md, sections 1-2):
// Gemini writes a parts list, the host Blender worker (blender_worker/) builds and renders it.
export const MATERIALS = ['hull', 'metal', 'dark', 'glass', 'fuel', 'copper', 'rubber', 'accent'];
const MATERIALS_V2 = ['concrete', 'wood', 'fabric'];
// Required parameters per shape; blender_worker/shapes.py is the other side of this contract.
export const SHAPES = {
  lathe: ['profile'],
  extrude: ['outline', 'depth'],
  loft: ['sections'],
  box: ['size'],
  cylinder: ['r', 'h'],
  cone: ['r1', 'r2', 'h'],
  sphere: ['r'],
  torus: ['r', 'thickness'],
};
export const SHAPES_V2 = { tube: ['path', 'r'], panel: ['size', 'bevel'], truss: ['length', 'width', 'height', 'bays', 'member'], gear: ['r', 'thickness', 'teeth', 'tooth_depth'] };
export const MAX_PARTS = 120; // raised from 80 for detailed models (panels, bolt rings, pipes)
export const PASS_SCORE = 6;
export const DETAIL_VERSION = 2;

export const modelSlug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// KAN-746: the folder name under _skill_v1 comes from a planner-chosen name: cap it and never use a Windows device name (CON, NUL, COM1 ...). Flag off never calls this.
export const skillDirSlug = (slug) => { const s = String(slug).slice(0, 80).replace(/-+$/, ''); return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(-|$)/.test(s) ? `m-${s}` : s; };
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const triple = (v) => Array.isArray(v) && v.length === 3 && v.every(finite);
const AXES = ['x', 'y', 'z'];
const oneOf = (v, allowed) => v === undefined || allowed.includes(v); // undefined: the worker's default
export const instanceCount = (p) => Math.max(1, Math.round(Number(p?.repeat?.count) || 1)) * (p?.mirror === 'x' || p?.mirror === 'y' ? 2 : 1);

function paramOk(p, key) {
  const v = p[key];
  if (key === 'path') return Array.isArray(v) && v.length >= 2 && v.every((pt) => triple(pt)) && v.slice(1).every((pt,i) => pt.some((x,k) => x !== v[i][k]));
  if (key === 'sections') return Array.isArray(v) && v.length >= 2 && v.every((s) => finite(s?.at) && finite(s?.w) && finite(s?.h));
  if (key === 'profile' || key === 'outline') {
    return Array.isArray(v) && v.length >= (key === 'outline' ? 3 : 2) && v.every((pt) => Array.isArray(pt) && pt.length === 2 && pt.every(finite));
  }
  if (key === 'size') return triple(v) && v.every((n) => n > 0);
  return finite(v) && v >= 0;
}

const PART_ID_RE = /^[A-Za-z0-9_-]{1,60}$/;

// Everything the worker needs to build without crashing, plus the rules that make a cutaway worth watching.
export function validateModel(m, { requireInterior = true, shapesV2 = false } = {}) {
  const shapes = shapesV2 === true ? { ...SHAPES, ...SHAPES_V2 } : SHAPES;
  const materials = shapesV2 === true ? [...MATERIALS, ...MATERIALS_V2] : MATERIALS;
  if (!m || !Array.isArray(m.parts) || !m.parts.length) return ['"parts" must be a non-empty list'];
  const errors = [];
  const size = m.size_m || {};
  if (!['length', 'width', 'height'].every((k) => finite(size[k]) && size[k] > 0)) errors.push('"size_m" needs positive length, width and height in metres');
  const ids = new Set();
  for (const [i, p] of m.parts.entries()) {
    const where = `part ${i + 1} (${p?.id || 'no id'})`;
    if (!p?.id || typeof p.id !== 'string') {
      errors.push(`${where}: missing "id"`);
      continue;
    }
    if (!PART_ID_RE.test(p.id)) {
      errors.push(`${where}: invalid id "${p.id}" (must match ${PART_ID_RE})`);
      continue;
    }
    if (ids.has(p.id)) errors.push(`${where}: duplicate id`);
    ids.add(p.id);
    const need = shapes[p.shape];
    if (!need) {
      errors.push(`${where}: unknown shape "${p.shape}"`);
      continue;
    }
    for (const key of need) if (!paramOk(p, key)) errors.push(`${where}: "${key}" is missing or not numeric`);
    if (p.at !== undefined && !triple(p.at)) errors.push(`${where}: "at" must be [x, y, z]`);
    if (p.rot !== undefined && !triple(p.rot)) errors.push(`${where}: "rot" must be [x, y, z] degrees`);
    if (p.material !== undefined && !materials.includes(p.material)) errors.push(`${where}: material must be one of ${materials.join(', ')}`);
    if (p.stage !== undefined && (!Number.isInteger(p.stage) || p.stage < 1 || p.stage > 12)) errors.push(`${where}: stage must be an integer 1..12`);
    // Enum and shape fields shapes.py/shot_math.py index directly: a typo here would crash Blender instead of getting a repair.
    if (p.shape === 'extrude' && !oneOf(p.plane, ['xy', 'xz', 'yz'])) errors.push(`${where}: plane must be one of xy, xz, yz`);
    if (p.shape === 'gear' && p.teeth > 125)  /* a gear is 20 * teeth - 4 triangles: 125 teeth = 2496, 126 = 2516 */ errors.push(`${where}: teeth would exceed 2500 triangles`);
    if (p.shape === 'truss' && p.bays > 50) errors.push(`${where}: bays would exceed 2500 triangles`);
    if (p.shape === 'panel' && finite(p.bevel) && triple(p.size) && p.bevel >= Math.min(...p.size) / 2) errors.push(`${where}: bevel must be smaller than half the smallest side`);
    if (p.shape === 'truss' && (!Number.isInteger(p.bays) || p.bays < 1)) errors.push(`${where}: bays must be a positive integer`);
    if (p.shape === 'gear' && (!Number.isInteger(p.teeth) || p.teeth < 3)) errors.push(`${where}: teeth must be an integer >= 3`);
    if (p.shape === 'loft' && !oneOf(p.axis, AXES)) errors.push(`${where}: loft axis must be one of x, y, z`);
    if (p.mirror != null && !['x', 'y'].includes(p.mirror)) errors.push(`${where}: mirror must be "x", "y", or null`);
    const rep = p.repeat;
    if (rep != null) {
      // shapes.py: a "step" makes a row, otherwise a ring of "radius" around "axis"
      if (!(Number(rep.count) >= 1 && (rep.step !== undefined ? triple(rep.step) : finite(rep.radius) && rep.radius >= 0))) {
        errors.push(`${where}: repeat needs count >= 1 and either step [dx, dy, dz] or radius`);
      } else if (rep.step === undefined && !oneOf(rep.axis, AXES)) errors.push(`${where}: repeat axis must be one of x, y, z`);
    }
    const mo = p.motion;
    if (mo != null) {
      if (mo.type === 'spin') {
        if (!oneOf(mo.axis, AXES) || (mo.rpm != null && !(finite(mo.rpm) && mo.rpm > 0))) errors.push(`${where}: spin axis must be one of x, y, z and rpm a positive number`);
      } else if (mo.type === 'slide') {
        if (!triple(mo.to)) errors.push(`${where}: slide "to" must be [x, y, z]`);
      } else errors.push(`${where}: unknown motion type "${mo.type}"`);
    }
  }
  for (const p of m.parts) {
    if (p?.parent != null && !ids.has(p.parent)) errors.push(`part ${p.id}: parent "${p.parent}" does not exist`);
  }
  const parentOf = new Map(m.parts.map((p) => [p?.id, p?.parent]));
  for (const id of ids) {
    const seen = new Set();
    for (let cur = id; cur != null; cur = parentOf.get(cur)) {
      if (seen.has(cur)) {
        errors.push(`part ${id}: parent loop`);
        break;
      }
      seen.add(cur);
    }
  }
  const total = m.parts.reduce((n, p) => n + instanceCount(p), 0);
  if (total > MAX_PARTS) errors.push(`${total} parts after repeat/mirror; the limit is ${MAX_PARTS}`);
  if (requireInterior && !m.parts.some((p) => p?.interior === true)) errors.push('at least one part must be "interior": true (something to reveal inside)');
  return errors;
}

// The worker measures the built geometry; a misplaced part or wrong units shows up here.
// Widened tolerance window [0.5, 2.0] per sorted axis: catches 10x unit errors or misplaced parts,
// while tolerating builder estimates (e.g. 1.56x on an axis).
export const SIZE_TOLERANCE_MIN = 0.5;
export const SIZE_TOLERANCE_MAX = 2.0;

export function sizeMismatch(extents, size) {
  // the worker must report three finite positive extents; anything else is a failed measurement, not a pass
  if (!Array.isArray(extents) || extents.length !== 3 || extents.some((n) => !Number.isFinite(n) || n <= 0)) {
    return 'the Blender worker returned no valid size measurement for the model; rebuild it with simple, closed shapes';
  }
  const got = [...extents].sort((a, b) => b - a);
  const want = [size.length, size.width, size.height].sort((a, b) => b - a);
  const off = got.some((g, i) => g < want[i] * SIZE_TOLERANCE_MIN || g > want[i] * SIZE_TOLERANCE_MAX);
  if (!off) return null;

  const axisNames = ['longest axis', 'middle axis', 'shortest axis'];
  const reports = [];
  for (let i = 0; i < 3; i++) {
    const g = got[i];
    const w = want[i];
    const isOff = g < w * SIZE_TOLERANCE_MIN || g > w * SIZE_TOLERANCE_MAX;
    if (isOff) {
      const ratio = g >= w ? g / w : w / g;
      const rVal = Number(ratio.toFixed(1));
      const ratioStr = (rVal % 1 === 0 ? rVal.toString() : ratio.toFixed(1)) + 'x';
      const direction = g > w ? 'too big' : 'too small';
      const exactScale = w / g;
      const scaleFactor = exactScale.toPrecision(2).replace(/(?:\.0+|(?:(\.\d*?)0+))$/, '$1');
      reports.push(`${axisNames[i]}: measured ${g.toFixed(1)} m vs claimed ${w.toFixed(1)} m (${ratioStr} ${direction}); scale factor ${scaleFactor} along ${axisNames[i]}`);
    } else {
      reports.push(`${axisNames[i]}: measured ${g.toFixed(1)} m, claimed ${w.toFixed(1)} m (ok)`);
    }
  }

  return `${reports.join('; ')}: scale the parts on that axis so the model matches size_m, the real size`;
}

// ---- Host Blender worker (blender_worker/server.py) ----
// The worker's HTTP server is single-threaded, so one /status probe can time out right after a render ends;
// a single retry stops that from failing a whole run start with "worker is offline" (seen 2026-11-12 20:52).
export async function workerStatus({ retryDelayMs = 1500 } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(`${workerUrl()}/status`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return await res.json();
    } catch {
      // fall through to the retry
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  return null;
}

export async function callWorker(route, body, { timeoutMs = 10 * 60000, binary = false, includeHeaders = false, signal } = {}) {
  const url = new URL(`${workerUrl()}${route}`);
  const client = url.protocol === 'https:' ? https : http;
  const payload = JSON.stringify(body ?? {});

  return new Promise((resolve, reject) => {
    let timedOut = false;
    const req = client.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: Math.round(timeoutMs),
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          try {
            const e = JSON.parse(buf.toString('utf8'));
            reject(new Error(`Blender worker ${route} failed: ${e.error || res.statusCode}`));
          } catch {
            reject(new Error(`Blender worker ${route} failed: ${res.statusCode}`));
          }
          return;
        }
        if (binary) {
          resolve(includeHeaders ? { data: buf, headers: res.headers } : buf);
        } else {
          try {
            resolve(JSON.parse(buf.toString('utf8')));
          } catch (err) {
            reject(new Error(`Blender worker ${route} returned invalid JSON: ${err.message}`));
          }
        }
      });
    });

    if (signal) {
      if (signal.aborted) {
        req.destroy();
        reject(signal.reason || new Error('Aborted'));
        return;
      }
      signal.addEventListener('abort', () => {
        req.destroy();
        reject(signal.reason || new Error('Aborted'));
      }, { once: true });
    }

    req.on('timeout', () => {
      timedOut = true;
      req.destroy();
      reject(new Error(`Blender worker timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${route}`));
    });

    req.on('error', (err) => {
      if (timedOut) return;
      reject(new Error(`Blender worker unreachable at ${workerUrl()} (${err.code || err.message}). Start it on the host: cd c:\\code\\ForgeAi ; python blender_worker/server.py`));
    });

    req.write(payload);
    req.end();
  });
}

// ---- Gemini prompts ----
export const SHAPE_RULES = `- Shapes and their exact parameters:
  lathe: "profile": [[radius, z], ...] spun around the part's local z axis; start and end with radius 0 for a closed solid. Lay it sideways with "rot" (e.g. [0, 90, 0] points it along x).
  extrude: "outline": [[u, v], ...] (3+ points, a flat outline), "depth", "plane": "xy" | "xz" | "yz".
  loft: "axis": "x" | "y" | "z", "sections": [{"at": position along the axis, "w": width, "h": height, "shape": "ellipse" | "rect"}, ...] (2+ sections) for fuselages, car bodies, hulls.
  box: "size": [x, y, z]. cylinder: "r", "h" (along z). cone: "r1" bottom, "r2" top, "h". sphere: "r". torus: "r", "thickness".
- Optional: "rot": [x, y, z] degrees; "mirror": "x" | "y" (adds the mirrored twin, e.g. the other wing); "repeat": {"count", "radius", "axis"} for a ring or {"count", "step": [dx, dy, dz]} for a row.
- "material": one of ${MATERIALS.join(', ')}.`;
export const SHAPE_RULES_V2 = `${SHAPE_RULES}
  tube: path of 2+ [x,y,z] points and r; panel: size and bevel; truss: length, width, height, bays, member; gear: r, thickness, teeth, tooth_depth. Materials: concrete, wood, fabric.`;

// Vocabulary for objects the builder tends to draw as toys (KAN-171).
const UNUSUAL_OBJECT_RULES = 'For antique/historical mechanisms, include gear repeats, weathered copper and metal parts, and dark frame. For ground-effect / unconventional aerodynamic vehicles (ekranoplans, flarecraft), model stumpy wide-chord wings, multi-engine forward canards/spans, boat-hull bottom profile, T-tail, duck-bill nose. For heavy machinery (bucket-wheel excavators, cranes, draglines), model crawler track pairs under a wide base, a lattice boom with a long counter-boom, a bucket wheel as a ring of repeated buckets on a hub, conveyor booms, and a small operator cabin that is tiny next to the machine.';

const MOVING_PART_VERBS = /\b(spins?|spinning|spun|rotates?|rotating|rotated|pumps?|pumping|pumped|slides?|sliding|slid|oscillates?|oscillating|oscillated)\b/i;
const SPECIALIZED_GEOMETRY_RULES = 'Also use object-specific geometry instead of a generic body: antique mechanisms need gear trains and readable dials; marine and aerospace craft need a shaped hull, sponsons where present, and arranged engine banks; mining equipment needs truss arms and bucket wheels built from repeated buckets around a hub.';

// ---- Antique mechanisms (KAN-155, flag model_antique_vocab_v1, default off) ----
// The builder has no bronze or wood material and the scorer keeps asking for them, and the model is drawn several times
// too big. With the flag on, an antique subject gets a vocabulary mapped onto the real MATERIALS, a size anchor, and the
// same reminder in every repair.
export const antiqueVocabOn = (opt) => opt ?? ['1', 'true'].includes(process.env.MODEL_ANTIQUE_VOCAB_V1);
export const ANTIQUE_SUBJECT = /antikythera|astrolabe|orrery|clockwork|astronomical (?:clock|calculator)|ancient (?:gear|mechanism|calculator)/i;
const ANTIQUE_RULES = 'ANTIQUE MECHANISM: it is a hand-sized device in a flat case, not a machine. Use "size_m" of the real case (a fraction of a metre; no part may stick out of it). Material mapping: bronze or brass gears and dials are "copper", the wooden case and frame are "dark", steel pins and axles are "metal", inscriptions are thin "accent" bands. Build the gear train as separate flat cylinders on a shared axle, each tooth ring a "repeat" of small boxes around the gear rim, with different radii so they mesh. Put round dials as flat torus rings on the front and back faces with a "repeat" ring of small tick boxes, and a pointer box on each. Keep the case, the gear train and the dials as separate parts; the interior gears sit inside the case.';
const ANTIQUE_REPAIR_NOTE = 'The builder cannot draw bronze, wood or inscriptions as textures: keep gears and dials "copper", the case "dark", inscriptions as thin "accent" bands, and keep every part inside the real case size. Add or fix gears and dials by editing their parts, do not enlarge the model.';

// ---- Ground-effect craft (KAN-158, flag model_ground_effect_vocab_v1, default off) ----
// An ekranoplan is drawn like an airliner: a tall tail makes the shortest axis about 2.5x the claimed height, the size guard
// fails without a vision call, and the repair rebuilds the same extents. With the flag on, a ground-effect subject gets
// low-and-wide proportions in the first prompt and the same reminder in every repair. The size guard and PASS_SCORE are untouched.
export const groundEffectVocabOn = (opt) => opt ?? ['1', 'true'].includes(process.env.MODEL_GROUND_EFFECT_VOCAB_V1);
export const GROUND_EFFECT_SUBJECT = /ekranoplan|flarecraft|wing.in.ground|ground.effect (?:vehicle|craft|aircraft)/i;
const GROUND_EFFECT_RULES = 'GROUND-EFFECT CRAFT: it is long, wide and LOW, not an airliner. Set "size_m" from the real craft and keep these proportions: the height (from the keel to the top of the tail) is about a quarter of the length, the wing span about 0.6 of the length. The tail fin and the engine pods are what usually make it too tall: the top of the T-tail is the highest point, it must stay under "height", and no single part may be taller than "height". Build the hull as a "loft" along its length with a flat bottom and a boat-shaped keel; the wings are short, stubby and broad ("extrude" or flat boxes at mid-hull height, with their twin from "mirror" and small end plates at the tips); put the engines as a "repeat" row on short pylons over the forward hull; the T-tail is a thin fin with a horizontal stabilizer box on top. Materials: hull "hull", engines and pylons "metal", cockpit "glass", stripes and markings "accent". Keep hull, wings, engine row and tail as separate parts, and keep the interior parts inside the hull.';
const GROUND_EFFECT_REPAIR_NOTE = 'It is a long, wide and low craft: keep every part inside the real size. If the height is too big, shorten the tail fin, lower the engine pods and flatten the hull first, by editing those parts, and do not change "size_m". Keep the wings short and stubby, not long and thin like an airliner.';

export const modelPrompt = (story, options = {}) => {
  const script = typeof options === 'string' ? options : (options?.script || story?.script || '');
  const style = typeof options === 'object' ? (options?.style || story?.style || '') : (story?.style || '');
  const isViral = style === 'viral_v1';
  const requireMotion = isViral && Boolean(script) && MOVING_PART_VERBS.test(script);
  const objectContext = [story?.name, ...(story?.facts || []), ...(story?.components || [])].join(' ');
  const unusualObjectRules = /antikythera|mechanism|gear|clock|ekranoplan|ground.effect|flarecraft|aerodynamic|excavator|crane|dragline|mining|bucket.wheel|marine|aerospace|ship|aircraft|submarine/i.test(objectContext)
    ? ` ${SPECIALIZED_GEOMETRY_RULES}`
    : '';
  const antiqueRules = antiqueVocabOn(options?.antiqueVocab) && ANTIQUE_SUBJECT.test(objectContext) ? `
- ${ANTIQUE_RULES}` : '';
  const groundEffectRules = groundEffectVocabOn(options?.groundEffectVocab) && GROUND_EFFECT_SUBJECT.test([story?.name, story?.wiki_title].join(' ')) ? `
- ${GROUND_EFFECT_RULES}` : '';
  const motionRule = requireMotion
    ? '- "motion" (REQUIRED for moving parts; the script describes moving parts such as spinning, rotating, pumping, sliding, oscillating): {"type": "spin", "axis": "x"|"y"|"z", "rpm": n} for fans, wheels, propellers; {"type": "slide", "to": [dx, dy, dz]} for doors, pistons. You MUST define "motion" for any part that moves.'
    : '- "motion" (optional): {"type": "spin", "axis": "x"|"y"|"z", "rpm": n} for fans, wheels, propellers; {"type": "slide", "to": [dx, dy, dz]} for doors, pistons.';

  return `You are a technical 3D modeller. Describe "${story.name}" as a parts list that code turns into a stylized Blender model for an engineering cutaway video.
${story.facts?.length ? `Facts:\n${story.facts.map((f) => `- ${f}`).join('\n')}\n` : ''}${story.dimensions ? `Real size (metres): ${JSON.stringify(story.dimensions)}\n` : ''}${story.components?.length ? `Components to include: ${story.components.join(', ')}\n` : ''}${referencePromptBlock(options?.reference)}
Return ONLY this JSON, no commentary:
{"name": "...", "size_m": {"length": m, "width": m, "height": m}, "up": "z", "parts": [{"id": "snake_case", "label": "short name", "parent": null, "stage": 1, "shape": "...", ...shape parameters, "material": "...", "interior": false}]}

RULES
- "stage": integer 1..12 giving the construction/build order. Assign a stage to every part (1 = foundation/structural frame built first, up to 12 = final fixtures/details).
- Metres, z up, the object's own frame. "at": [x, y, z] is the part's absolute position (NOT relative to its parent).
${SHAPE_RULES}
- "interior": true for parts hidden inside the body (tanks, engines inside a fuselage, crew cabin, machinery). At least 3 interior parts, each fully inside the shell around it.
- "parent": the id of the part it belongs to (a tank's parent is the stage shell); null for top-level parts.
${motionRule}
- Add recognizable details: panels and seams where they really are, bolt or rivet rings (use repeat rings), pipes/conduits, hatches, antennas, paint markings and stripes using accent materials so the model looks detailed and authentic, not like a generic toy. Each one must sit on a real surface of the object, not float. ${UNUSUAL_OBJECT_RULES}${unusualObjectRules}
- 40-100 parts after repeats (hard limit ${MAX_PARTS}). Get the silhouette and proportions right first: "size_m" is the real size and the parts must fill it.${antiqueRules}${groundEffectRules}${skillsPrompt('model_build', { policy: typeof options === 'object' ? (options?.policy ?? story?.policy) : story?.policy })}`;
};

export const propPrompt = (prop) => {
  const name = typeof prop === 'string' ? prop : (prop?.name || '');
  return `You are a technical 3D modeller. Describe the prop "${name}" as a parts list that code turns into a stylized Blender model for a 3D scene background.
Props are things like a launch tower, a pier or a road, built in the same shape language as models.
Return ONLY this JSON, no commentary:
{"name": "${name}", "size_m": {"length": m, "width": m, "height": m}, "up": "z", "parts": [{"id": "snake_case", "label": "short name", "parent": null, "stage": 1, "shape": "...", ...shape parameters, "material": "...", "interior": false}]}

RULES
- "stage": integer 1..12 giving the construction/build order. Assign a stage to every part (1 = foundation/structural frame built first, up to 12 = final fixtures/details).
- Metres, z up, the object's own frame. "at": [x, y, z] is the part's absolute position (NOT relative to its parent).
${SHAPE_RULES}
- "interior": false (props do not require interior parts).
- "parent": the id of the part it belongs to; null for top-level parts.
- "motion" (optional): {"type": "spin", "axis": "x"|"y"|"z", "rpm": n}; {"type": "slide", "to": [dx, dy, dz]}.
- Add recognizable architectural or structural details so the prop looks detailed and authentic, not like a generic toy.
- 5-80 parts after repeats (hard limit ${MAX_PARTS}). Get the silhouette and proportions right first: "size_m" is the real size and the parts must fill it.`;
};

export const visionPrompt = (name, context = '') => {
  let objectName = typeof name === 'string' ? name : (name?.wiki_title || name?.name || '');
  let factsContext = context;
  if (typeof name === 'object' && name !== null && !factsContext) {
    if (Array.isArray(name.facts) && name.facts.length) {
      factsContext = name.facts.slice(0, 2).map((f) => String(f).trim()).filter(Boolean).join(' ');
    }
  }
  // facts come from Wikipedia: strip quotes and control characters so they cannot break the quoted target
  factsContext = String(factsContext || '').replace(/["\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200).trim();
  const target = factsContext ? `Object: ${objectName}. Context: ${factsContext}` : objectName;
  return `These are 3 renders (front three-quarter, side, high three-quarter) of a simple code-built 3D model meant to be "${target}". It is a stylized technical model: judge silhouette, proportions, and whether it is detailed, not toy-like.\nReturn ONLY this JSON: {"score": 0-10 (scores detailed, not toy-like: how clearly a viewer would recognize it as ${objectName}), "recognizable": true|false, "fixes": ["up to 5 concrete fixes naming the part and what to change: size, position or shape"]}`;
};

const withFeedback = (model, heading, items) => `\n\nYour previous JSON:\n${JSON.stringify(model)}\n${heading}\n${items.map((i) => `- ${i}`).join('\n')}\nReturn the full corrected JSON.`;

// ---- Building and checking a model ----
async function draftModel(story, ask, emit, extra = '', { requireInterior = true, prompt = null, tag = 'MODEL', script = '', style = '', reference = null, antiqueVocab, groundEffectVocab, policy } = {}) {
  const write = async (more) => {
    const p = prompt ?? modelPrompt(story, { script: script || story?.script, style: style || story?.style, reference, antiqueVocab, groundEffectVocab, policy: policy ?? story?.policy });
    const raw = await ask(p + more, { model: GEMINI_MID_MODEL, maxTokens: 8192 });
    if (!raw) throw new Error('Gemini is unavailable (no Antigravity CLI and no API key).');
    return raw;
  };
  let model = await write(extra);
  let errors = validateModel(model, { requireInterior });
  if (errors.length) {
    emit(tag, `Parts list has ${errors.length} problem(s); asking Gemini to fix them.`);
    model = await write(withFeedback(model, 'It has these problems:', errors));
    errors = validateModel(model, { requireInterior });
  }
  if (errors.length) throw new Error(`${tag === 'PROP' ? 'Prop' : 'Model'} rejected: the parts list is still invalid (${errors.slice(0, 3).join('; ')}).`);
  return model;
}

const SCORE_VALID = Symbol('score-valid');

async function score(name, images, ask, emit, facts = '') {
  try {
    const raw = await ask(visionPrompt(name, facts), { images: images.map((data) => ({ mime: 'image/png', data })), model: GEMINI_MID_MODEL });
    if (!raw) return null;
    const modelUsed = raw._gemini_model_used || raw.scoring_model;
    return {
      score: Number(raw.score) || 0,
      [SCORE_VALID]: Number.isFinite(Number(raw.score)) && Number(raw.score) >= 0 && Number(raw.score) <= 10,
      recognizable: raw.recognizable === true,
      fixes: Array.isArray(raw.fixes) ? raw.fixes.map(String).slice(0, 5) : [],
      ...(modelUsed ? { _gemini_model_used: modelUsed, scoring_model: modelUsed } : {}),
    };
  } catch (err) {
    emit('WARN', `Vision check failed (${err.message}).`);
    return null;
  }
}

// Renders the 3 stills and judges them: a size mismatch fails without spending a vision call.
// focus: a part id, the worker frames that part's box. reject(shot): a problem string fails the check the same way.
// A preview waits behind a take render: the worker runs one Blender job at a time (blender_worker LOCK),
// and the longest take (60 s, with its retry) has a ~77 min timeout.
const PREVIEW_TIMEOUT_MS = 90 * 60000;

async function inspect(model, name, { ask, worker, emit }, { focus, reject, facts = '' } = {}) {
  const shot = await worker('/preview', { model, ...(focus && { focus }) }, { timeoutMs: PREVIEW_TIMEOUT_MS });
  if (!Array.isArray(shot?.images) || shot.images.length !== 3) throw new Error('Blender worker returned no preview images.');
  const problem = sizeMismatch(shot.extents_m, model.size_m) || reject?.(shot);
  const check = problem ? { score: 0, recognizable: false, fixes: [problem] } : await score(name, shot.images, ask, emit, facts);
  return { shot, check };
}

async function consensusScore(check, images, name, ask, emit, facts) {
  if (!check || check.score < 5 || check.score > 7) return check;
  const checks = [check];
  checks.push(await score(name, images, ask, emit, facts));
  checks.push(await score(name, images, ask, emit, facts));
  if (checks.some((item) => !Number.isFinite(item?.score) || item?.[SCORE_VALID] === false || item.score < 0 || item.score > 10)) return check;
  const median = [...checks].sort((a, b) => a.score - b.score)[1];
  const recognizable = checks.filter((item) => item.recognizable === true).length >= 2;
  const medianChecks = checks.filter((item) => item.score === median.score);
  const representative = medianChecks.find((item) => item.recognizable === recognizable)
    || checks.find((item) => item.recognizable === recognizable)
    || median;
  return {
    ...representative,
    score: median.score,
    recognizable,
    fixes: representative.fixes || [],
  };
}

const repairFeedback = (model, fixes, sizeFacts = '') => {
  const items = [...(fixes || [])];
  if (model?.size_m) {
    items.push(`Keep size_m exactly as ${JSON.stringify(model.size_m)}; do not change overall dimensions.`);
  }
  if (sizeFacts) items.push(sizeFacts);
  return withFeedback(model, 'A reviewer looked at renders of it and asked for these fixes:', items);
};

// ---- Repair scale (KAN-399, flag model_repair_scale_v1, default off) ----
// The size guard names a scale factor but the redraft often keeps the same extents. With the flag on, the factor is
// also applied in code (once per repair draft) and the exact numbers go into the repair prompt.
export const repairScaleOn = (opt) => opt ?? ['1', 'true'].includes(process.env.MODEL_REPAIR_SCALE_V1);

const validExtents = (e) => Array.isArray(e) && e.length === 3 && e.every((n) => Number.isFinite(n) && n > 0);
const offTolerance = (g, w) => g < w * SIZE_TOLERANCE_MIN || g > w * SIZE_TOLERANCE_MAX;
const geoMean = (...f) => f.reduce((a, b) => a * b, 1) ** (1 / f.length);

// Per model axis (x, y, z): the factor that brings it to the claimed size, matched the way sizeMismatch matches them
// (sorted longest first). 1 for an axis inside tolerance.
export function axisFactors(extents, size) {
  const factors = [1, 1, 1];
  const rows = [];
  if (!validExtents(extents) || !size) return { factors, rows };
  const order = [0, 1, 2].sort((a, b) => extents[b] - extents[a] || a - b);
  const want = [size.length, size.width, size.height].sort((a, b) => b - a);
  order.forEach((k, i) => {
    const off = offTolerance(extents[k], want[i]);
    if (off) factors[k] = want[i] / extents[k];
    rows.push({ rank: ['longest', 'middle', 'shortest'][i], axis: AXES[k], measured_m: Number(extents[k].toFixed(2)), claimed_m: Number(want[i].toFixed(2)), factor: Number((want[i] / extents[k]).toFixed(3)), within_tolerance: !off });
  });
  return { factors, rows };
}

// The guard numbers as structured text for the repair prompt; '' when the guard passes.
const sizeFactsText = (shot, model) => {
  const { factors, rows } = axisFactors(shot?.extents_m, model?.size_m);
  return factors.some((f) => f !== 1) ? `Size guard numbers (measured, claimed, factor to multiply that axis by): ${JSON.stringify(rows)}` : '';
};

// Model axis hit by each local axis of a part, or null when "rot" is not a multiple of 90 degrees.
function localAxes(rot) {
  const r = rot || [0, 0, 0];
  if (!r.every((a) => Math.abs(a / 90 - Math.round(a / 90)) < 1e-6)) return null;
  const [rx, ry, rz] = r.map((a) => (a * Math.PI) / 180);
  return [0, 1, 2].map((j) => {
    let [x, y, z] = [j === 0 ? 1 : 0, j === 1 ? 1 : 0, j === 2 ? 1 : 0];
    [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)]; // same order as blender_worker/shapes.py rotate()
    [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
    [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
    const a = [x, y, z].map(Math.abs);
    return a.indexOf(Math.max(...a));
  });
}

// A copy of the model with every part stretched by the per-axis factors, ids and counts untouched.
// Positions scale about the model origin: that keeps "mirror" (which flips about the origin) intact, and the worker
// re-centres the layout, so the shape is the same as scaling about the centre.
// ponytail: a part rotated off the 90-degree grid is scaled by the geometric mean of the three factors, a ring repeat's radius by the mean of its two cross axes.
export function rescaleParts(model, factors) {
  const out = structuredClone(model);
  for (const p of out.parts) {
    const lf = (localAxes(p.rot) || [null, null, null]).map((a) => (a === null ? geoMean(...factors) : factors[a]));
    const cross = geoMean(lf[0], lf[1]);
    const all = geoMean(...lf);
    if (p.at) p.at = p.at.map((c, k) => c * factors[k]);
    if (p.shape === 'box') p.size = p.size.map((s, k) => s * lf[k]);
    else if (p.shape === 'panel') { p.size = p.size.map((s,k) => s * lf[k]); p.bevel *= Math.min(...lf); }
    else if (p.shape === 'tube') { p.path = p.path.map((pt) => pt.map((x,k) => x*factors[k])); p.r *= geoMean(factors[0], factors[1]); }
    else if (p.shape === 'truss') { p.length *= lf[0]; p.width *= lf[1]; p.height *= lf[2]; p.member *= geoMean(...lf); }
    else if (p.shape === 'gear') { p.r *= cross; p.thickness *= lf[2]; p.tooth_depth *= cross; }
    else if (p.shape === 'cylinder') [p.r, p.h] = [p.r * cross, p.h * lf[2]];
    else if (p.shape === 'cone') [p.r1, p.r2, p.h] = [p.r1 * cross, p.r2 * cross, p.h * lf[2]];
    else if (p.shape === 'sphere') p.r *= all;
    else if (p.shape === 'torus') [p.r, p.thickness] = [p.r * cross, p.thickness * all];
    else if (p.shape === 'lathe') p.profile = p.profile.map(([r, z]) => [r * cross, z * lf[2]]);
    else if (p.shape === 'extrude') {
      const [u, v, d] = { xy: [0, 1, 2], xz: [0, 2, 1], yz: [1, 2, 0] }[p.plane || 'xy'];
      p.outline = p.outline.map(([a, b]) => [a * lf[u], b * lf[v]]);
      p.depth *= lf[d];
    } else if (p.shape === 'loft') {
      const axis = AXES.indexOf(p.axis || 'x');
      const [w, h] = [0, 1, 2].filter((k) => k !== axis);
      p.sections = p.sections.map((s) => ({ ...s, at: s.at * lf[axis], w: s.w * lf[w], h: s.h * lf[h] }));
    }
    if (p.repeat?.step) p.repeat.step = p.repeat.step.map((s, k) => s * factors[k]);
    else if (p.repeat?.radius !== undefined) {
      const [a, b] = [0, 1, 2].filter((k) => k !== AXES.indexOf(p.repeat.axis || 'z'));
      p.repeat.radius *= geoMean(factors[a], factors[b]);
    }
    if (p.motion?.type === 'slide') p.motion.to = p.motion.to.map((s, k) => s * factors[k]);
  }
  return out;
}

// After a repair draft: if the guard still reports an axis out of tolerance, rescale that axis in code and run the guard once more.
// A guard that passes changes nothing; a model that still fails is returned as is (no second rescale).
async function rescaleIfOversize(model, shot, check, name, deps, facts, tag) {
  const { factors } = axisFactors(shot?.extents_m, model?.size_m);
  if (!factors.some((f) => f !== 1)) return { model, shot, check };
  const rescaled = rescaleParts(model, factors);
  deps.emit(tag, `Repair draft is out of size; rescaled the parts by ${AXES.map((a, k) => `${a} x${factors[k].toFixed(3)}`).join(', ')} (${rescaled.parts.length} parts, ids kept) and re-checking the guard.`);
  deps.onPhase?.('checking');
  const next = await inspect(rescaled, name, deps, { facts });
  return { model: rescaled, ...next };
}


// KAN-544: the usage file lives next to the library folder (data/models3d_usage.json), never inside it, so directory
// listings of the library (requirements versions, matchLibraryModel, tests) only ever see model folders.
export const modelUsageFile = (dir = modelsDir()) => path.join(path.dirname(dir), `${path.basename(dir)}_usage.json`);

export function recordModelUsage(slug, date = new Date(), dir = modelsDir()) {
  if (!slug) return;
  try {
    const file = modelUsageFile(dir);
    const cur = readJson(file) || {};
    cur[slug] = typeof date === 'string' ? date : date.toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cur, null, 2));
  } catch {
    // write failure never changes control flow
  }
}

let draftsUsageCache = null;
let draftsUsageCacheTime = 0;
let draftsUsageCacheDir = null;
const DRAFTS_USAGE_TTL_MS = 60_000;

function getDraftsUsage() {
  const draftsDir = process.env.FORGEAI_DRAFTS_DIR || path.join(REPO_ROOT, 'data/drafts');
  const now = Date.now();
  if (draftsUsageCache && draftsUsageCacheDir === draftsDir && (now - draftsUsageCacheTime) < DRAFTS_USAGE_TTL_MS) {
    return draftsUsageCache;
  }
  const draftsUsage = {};
  try {
    if (fs.existsSync(draftsDir)) {
      for (const entry of fs.readdirSync(draftsDir)) {
        const planFile = path.join(draftsDir, entry, 'plan.json');
        if (fs.existsSync(planFile)) {
          const plan = readJson(planFile);
          const obj = plan?.story?.object || plan?.story?.name || plan?.object || plan?.title;
          const slug = modelSlug(obj);
          if (slug && !draftsUsage[slug]) {
            const stat = fs.statSync(planFile);
            draftsUsage[slug] = stat.mtime.toISOString();
          }
        }
      }
    }
  } catch {}
  draftsUsageCache = draftsUsage;
  draftsUsageCacheTime = now;
  draftsUsageCacheDir = draftsDir;
  return draftsUsage;
}

export function getModelUsage(dir = modelsDir()) {
  const usage = readJson(modelUsageFile(dir)) || {};
  const draftsUsage = getDraftsUsage();
  for (const [slug, mtime] of Object.entries(draftsUsage)) {
    if (!usage[slug]) usage[slug] = mtime;
  }
  return usage;
}

export function listVerifiedModels(dir = modelsDir()) {
  const slugs = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  return slugs
    .map((slug) => {
      const model = readJson(path.join(dir, slug, 'model.json'));
      const check = readJson(path.join(dir, slug, 'check.json'));
      return { slug, model, check };
    })
    .filter(({ model, check }) => model && check && check.rejected !== true && !checkFailureReason(check))
    .map(({ slug, model, check }) => ({
      slug,
      name: model.name,
      score: check.score,
      check,
      model,
    }));
}

export function isRecentlyRejected(name, { modelsDirectory = modelsDir(), maxAgeMs = 7 * 24 * 3600 * 1000 } = {}) {
  const slug = modelSlug(name);
  if (!slug) return false;
  const check = readJson(path.join(modelsDirectory, slug, 'check.json'));
  if (!check) return false;
  const isRejected = check.rejected === true || (Number.isFinite(check.score) && check.score < PASS_SCORE) || Boolean(checkFailureReason(check));
  if (!isRejected) return false;
  const dateStr = check.date || check.timestamp;
  if (!dateStr) return false;
  const age = Date.now() - new Date(dateStr).getTime();
  return age >= 0 && age < maxAgeMs;
}

// Shared inspect -> repair -> reject -> save flow for 3D models and props.
async function checkRepairSave({ dir, model, saved, name, redraft, deps, tag = 'MODEL', facts = '', slug = '', building = false, rq = null, repairScale, antiqueVocab, groundEffectVocab, libraryRoot = modelsDir() }) {
  const { emit } = deps;
  const scaleOn = repairScaleOn(repairScale);
  const groundEffectNote = groundEffectVocabOn(groundEffectVocab) && GROUND_EFFECT_SUBJECT.test(name) ? GROUND_EFFECT_REPAIR_NOTE : '';
  const CapitalNoun = tag === 'PROP' ? 'Prop' : 'Model';
  const noun = tag === 'PROP' ? 'prop' : 'model';

  deps.onPhase?.('checking');
  let { shot, check } = await inspect(model, name, deps, { facts });
  check = await consensusScore(check, shot.images, name, deps.ask, emit, facts);
  let repairs = 0;
  const initialScore = check?.score;
  const initialFixes = check?.fixes || [];
  const scoreOf = (c) => (Number.isFinite(c?.score) ? c.score : -1);
  let best = { model, shot, check };

  if (check && check.score < PASS_SCORE) {
    const modelTag = check._gemini_model_used ? ` (via ${check._gemini_model_used})` : '';
    emit(tag, `${CapitalNoun} scored ${check.score}/10${modelTag}; repairing: ${check.fixes.join('; ')}`);
    deps.onPhase?.('repairing');
    model = await redraft(repairFeedback(model, check.fixes, [scaleOn ? sizeFactsText(shot, model) : '', antiqueVocabOn(antiqueVocab) && ANTIQUE_SUBJECT.test(name) ? ANTIQUE_REPAIR_NOTE : '', groundEffectNote].filter(Boolean).join(' ')));
    if (!model.name) model.name = name;
    deps.onPhase?.('checking');
    ({ shot, check } = await inspect(model, name, deps, { facts }));
    if (scaleOn) ({ model, shot, check } = await rescaleIfOversize(model, shot, check, name, deps, facts, tag));
    if (scoreOf(check) >= scoreOf(best.check)) {
      best = { model, shot, check };
    }

    repairs = 1;
    if (check && check.score < PASS_SCORE && check.score > initialScore && Math.abs(PASS_SCORE - check.score) < Math.abs(PASS_SCORE - initialScore)) {
      repairs = 2;
      const secondModelTag = check._gemini_model_used ? ` (via ${check._gemini_model_used})` : '';
      emit(tag, `${CapitalNoun} scored ${check.score}/10${secondModelTag}; repairing: ${check.fixes.join('; ')}`);
      deps.onPhase?.('repairing');
      model = await redraft(repairFeedback(model, check.fixes, [scaleOn ? sizeFactsText(shot, model) : '', groundEffectNote].filter(Boolean).join(' ')));
      if (!model.name) model.name = name;
      deps.onPhase?.('checking');
      ({ shot, check } = await inspect(model, name, deps, { facts }));
      if (scaleOn) ({ model, shot, check } = await rescaleIfOversize(model, shot, check, name, deps, facts, tag));
      if (scoreOf(check) >= scoreOf(best.check)) {
        best = { model, shot, check };
      }
    }
  }

  model = best.model;
  shot = best.shot;
  check = best.check;
  if (check && checkFailureReason(check)) {
    try {
      const checkSlug = slug || modelSlug(name) || path.basename(dir);
      const checksDir = modelChecksDir();
      fs.mkdirSync(checksDir, { recursive: true });
      const checkRecord = {
        slug: checkSlug,
        name,
        score: check.score,
        fixes: check.fixes,
        repair_count: repairs,
        first_score: initialScore,
        first_fixes: initialFixes,
        timestamp: new Date().toISOString(),
        ...(check._gemini_model_used ? { _gemini_model_used: check._gemini_model_used } : {}),
      };
      fs.writeFileSync(path.join(checksDir, `${checkSlug}.json`), JSON.stringify(checkRecord, null, 2));
    } catch {
      // write failure never changes control flow
    }
    // A requirements_hash version is never deleted: it is an immutable library entry (KAN-334).
    if (saved && !saved.requirements_hash) {
      fs.rmSync(dir, { recursive: true, force: true });
    } else if (tag === 'MODEL' && !saved && !building && !rq) {
      try {
        const checkSlug = slug || modelSlug(name) || path.basename(dir);
        const libraryFolder = path.join(libraryRoot, checkSlug);
        if (!fs.existsSync(path.join(libraryFolder, 'model.json'))) {
          fs.mkdirSync(libraryFolder, { recursive: true });
          const rejectionCheck = {
            name,
            score: check.score,
            date: new Date().toISOString(),
            fixes: check.fixes || [],
            repair_count: repairs,
            rejected: true,
          };
          fs.writeFileSync(path.join(libraryFolder, 'check.json'), JSON.stringify(rejectionCheck, null, 2));
        }
      } catch {
        // write failure never changes control flow
      }
    }
    throw new Error(`${CapitalNoun} rejected: "${name}" scored ${check.score}/10 after ${repairs === 2 ? 'two repairs' : repairs === 1 ? 'one repair' : 'no repairs'} (${check.fixes.slice(0, 2).join('; ')}).`);
  }
  if (!check) emit('WARN', `No vision check for "${name}" (Gemini was unavailable); it will be checked the next time it's used.`);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(model, null, 2));
  shot.images.forEach((b64, i) => fs.writeFileSync(path.join(dir, `preview_${i + 1}.png`), Buffer.from(b64, 'base64')));
  fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify(check, null, 2));
  recordModelUsage(slug || modelSlug(model.name || name));
  const saveModelTag = check?._gemini_model_used ? ` via ${check._gemini_model_used}` : '';
  emit(tag, `New 3D ${noun} "${model.name || name}" (${model.parts.length} parts${check ? `, scored ${check.score}/10${saveModelTag}` : ''}) saved to the library.`);
  return { model, check };
}

export const checkFailureReason = (check) => {
  if (!Number.isFinite(check?.score) || check.score < PASS_SCORE) return `summary score ${check?.score ?? 'missing'} is below PASS_SCORE ${PASS_SCORE}`;
  if (Object.hasOwn(check, 'recognizable') && check.recognizable !== true) return 'summary recognizable flag is not true';
  if (Object.hasOwn(check, 'measurements')) {
    if (!Array.isArray(check.measurements)) return 'retained measurements are not an array';
    const failedMeasurementIndex = check.measurements.findIndex((measurement) => (
      !measurement || typeof measurement !== 'object' || Array.isArray(measurement)
      || !Number.isFinite(measurement.score) || measurement.score < PASS_SCORE
      || (Object.hasOwn(measurement, 'recognizable') && measurement.recognizable !== true)
    ));
    if (failedMeasurementIndex !== -1) {
      const failedMeasurement = check.measurements[failedMeasurementIndex];
      const detail = Number.isFinite(failedMeasurement?.score) ? `score ${failedMeasurement.score}` : 'invalid score or recognizable flag';
      return `a retained measurement failed (${detail})`;
    }
  }
  return null;
};

// A stored version with a structural receipt, or a requirements_hash version with no check.json (KAN-334), is reused as-is:
// never inspected, redrafted or deleted, and never certified by vision. Legacy models without requirements_hash are unaffected.
const structuralReuse = (saved, savedCheck) => Boolean(saved && (savedCheck ? savedCheck.acceptance === 'structural' : saved.requirements_hash));

// ---- Opt-in requirements-keyed library (KAN-301) ----
// getModel/getProp accept { requirementsHash, forceRebuild, versionTag }. Without requirementsHash nothing below runs and
// the name-only library behaves exactly as before. With it:
// - a saved model.json is reused only if its recorded `requirements_hash` equals requirementsHash (the base slug dir or any <slug>__v<n>);
// - otherwise (or with forceRebuild) a NEW version is built: the base dir if the slug is entirely unused, else <slug>__v<n>, n = highest + 1;
// - builds go to a temp dir that is renamed into place only after the quality gate passes, so an existing dir is never overwritten
//   and a failed rebuild leaves the library untouched. `versionTag` is stored as model.version_tag.
function pickRequirementsTarget(root, slug, { requirementsHash, forceRebuild }) {
  const base = path.join(root, slug);
  const versions = (fs.existsSync(root) ? fs.readdirSync(root) : [])
    .map((d) => [d, d.startsWith(`${slug}__v`) ? /^\d+$/.test(d.slice(slug.length + 3)) && Number(d.slice(slug.length + 3)) : false])
    .filter(([, n]) => n >= 2).sort((a, b) => a[1] - b[1]);
  const candidates = [[slug, 1], ...versions];
  if (!forceRebuild) {
    const hit = candidates.find(([d]) => readJson(path.join(root, d, 'model.json'))?.requirements_hash === requirementsHash);
    if (hit) return { reuse: true, dir: path.join(root, hit[0]), libSlug: hit[0], version: hit[1] };
  }
  const unused = !fs.existsSync(base) && !versions.length;
  const version = unused ? 1 : Math.max(1, ...versions.map(([, n]) => n)) + 1;
  const libSlug = version === 1 ? slug : `${slug}__v${version}`;
  return { reuse: false, dir: path.join(root, libSlug), libSlug, version };
}

const stampRequirements = (m, rq) => {
  if (rq) {
    m.requirements_hash = rq.requirementsHash;
    if (rq.versionTag) m.version_tag = rq.versionTag;
  }
  return m;
};

// building=false: run in place (legacy). building=true: run in a temp dir beside the target, rename it in only on success.
async function buildInto(building, target, run) {
  if (!building) return run(target);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    const out = await run(tmp);
    fs.renameSync(tmp, target);
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// KAN-746 (policy.skill_build_v1 === true): the four-pass chain; any failure runs today's draftModel instead.
const skillBuildOn = (policy) => policy?.skill_build_v1 === true;
async function skillOrFallback(story, { ask, emit, tag, requireInterior, reference, policy }, fallback) {
  try {
    const { build_passes: passes, ...model } = await buildWithSkills(story, { ask, emit, tag, requireInterior, reference, policy });
    return { model: { ...model, build_source: 'skill_build_v1', build_passes: passes }, build_source: 'skill_build_v1', build_passes: passes };
  } catch (err) {
    emit('WARN', `Skill build failed (${err.message}); using the standard model builder.`);
    return { model: { ...(await fallback()), build_source: 'fallback', build_passes: [] }, build_source: 'fallback', build_passes: [] };
  }
}

// Library hit -> reuse. Miss -> Gemini parts list -> Blender stills -> vision check -> repair (up to 2 if showing progress towards PASS_SCORE) -> save.
// reference (channel setting model_reference, default off): add a real Wikipedia/Wikidata reference to the builder prompt.
export async function getModel(story, { ask = askGemini, worker = callWorker, emit = () => {}, onPhase = () => {}, script = '', style = '', reference = false, getReference = getModelReference, requirementsHash, forceRebuild = false, versionTag, repairScale, antiqueVocab, groundEffectVocab, look_preset, policy } = {}) {
  const disambiguatedName = story.wiki_title || story.name;
  const slug = modelSlug(disambiguatedName);
  if (!slug) throw new Error('A 3D model needs an object name.');
  if (look_preset === 'real_v1' && !requirementsHash && !forceRebuild) {
    const topic = story.topic || story.name;
    const topicSlug = modelSlug(topic);
    try {
      const entries = fs.readdirSync(assets3dDir(), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[a-z0-9_-]+$/.test(entry.name)) continue;
        const spec = readJson(path.join(assets3dDir(), entry.name, 'asset.json'));
        if (!spec || spec.id !== entry.name) continue;
        const tags = Array.isArray(spec.tags) ? spec.tags : [];
        if (!tags.includes(topicSlug) && !tags.includes(topic)) continue;
        const parts = Array.isArray(spec.parts)
          ? spec.parts
          : Object.keys(spec.parts && typeof spec.parts === 'object' ? spec.parts : {}).map((id) => ({ id, label: id, interior: false }));
        const model = {
          // Older manifests may omit a display name or dimensions; fall back to the asset id and unit size.
          name: typeof spec.name === 'string' && spec.name.trim() ? spec.name : entry.name,
          size_m: Array.isArray(spec.size_m) && spec.size_m.length === 3 ? spec.size_m : [1, 1, 1],
          up: typeof spec.up === 'string' ? spec.up : (typeof spec.up_axis === 'string' ? spec.up_axis : '+Z'),
          parts,
        };
        return { slug: topicSlug, reused: true, model_source: 'library_mesh', asset_id: entry.name, model, check: null };
      }
    } catch {
      // A missing or unreadable asset library leaves the established procedural path unchanged.
    }
  }
  const skillBuild = skillBuildOn(policy ?? story?.policy);
  const libRoot = skillBuild ? skillBuildRoot(modelsDir()) : modelsDir();
  const dirSlug = skillBuild ? skillDirSlug(slug) : slug;
  const rq = requirementsHash ? pickRequirementsTarget(libRoot, dirSlug, { requirementsHash, forceRebuild }) : null;
  const building = Boolean(rq && !rq.reuse);
  const matched = rq || skillBuild ? null : matchLibraryModel(story, story.topic, { root: modelsDir(), slug, emit, checkFailureReason, detailVersion: DETAIL_VERSION });
  const dir = rq ? rq.dir : (matched?.dir ?? path.join(libRoot, dirSlug));
  const saved = building ? null : readJson(path.join(dir, 'model.json'));
  const savedCheck = building ? null : readJson(path.join(dir, 'check.json'));
  const rqInfo = rq ? { requirements_hash: requirementsHash, library_slug: rq.libSlug, version: rq.version } : {};
  const detail = Number(saved?.detail) || 1;
  const librarySlug = matched?.slug || slug;
  if (structuralReuse(saved, savedCheck)) {
    emit('MODEL', `Reusing the 3D model "${saved.name}" from the library structurally; it needs review.`);
    return { slug: librarySlug, model: saved, reused: true, structural: true, needs_review: true, check: null, ...rqInfo };
  }
  const cachedFailure = savedCheck && (saved || isRecentlyRejected(disambiguatedName, { modelsDirectory: libRoot }))
    ? checkFailureReason(savedCheck)
    : null;
  if (cachedFailure) {
    throw new Error(`Model rejected: "${savedCheck?.name || saved?.name || disambiguatedName}" has a failed cached check (${cachedFailure}).`);
  }
  if (saved && savedCheck && detail >= DETAIL_VERSION) {
    emit('MODEL', `Reusing the 3D model "${saved.name}" from the library.`);
    recordModelUsage(librarySlug);
    return { slug: librarySlug, model: saved, reused: true, check: savedCheck, ...rqInfo };
  }
  const needsDetailUpgrade = saved && detail < DETAIL_VERSION;
  if (needsDetailUpgrade) {
    emit('MODEL', `"${saved.name}" is in the library with older detail (${detail}); rebuilding with detailed features.`);
  } else if (saved) {
    // Saved while Gemini vision was unavailable (or check.json lost): check it now instead of trusting it forever.
    emit('MODEL', `"${saved.name}" is in the library but was never checked; checking it now.`);
  }

  const factsSnippet = Array.isArray(story.facts) && story.facts.length
    ? story.facts.slice(0, 2).map((f) => String(f).trim().replace(/\s+/g, ' ')).filter(Boolean).join(' ').slice(0, 200).trim()
    : '';

  const redraftStory = disambiguatedName !== story.name ? { ...story, name: disambiguatedName } : story;
  const deps = { ask, worker, emit, onPhase };
  if (!saved || needsDetailUpgrade) onPhase('drafting');
  let ref = null;
  if (reference && (!saved || needsDetailUpgrade)) {
    try {
      ref = await getReference(disambiguatedName);
      if (!ref) emit('MODEL', `No reference found for "${disambiguatedName}"; building from the facts alone.`);
    } catch (err) {
      emit('WARN', `Reference lookup failed (${err.message}); building from the facts alone.`);
    }
  }
  const draftOpts = { requireInterior: true, tag: 'MODEL', script: script || story?.script, style: style || story?.style, reference: ref, antiqueVocab, groundEffectVocab, policy: policy ?? story?.policy };
  let build = null;
  let model;
  if (saved && !needsDetailUpgrade) model = saved;
  else if (skillBuild) {
    build = await skillOrFallback(redraftStory, { ask, emit, tag: 'MODEL', requireInterior: true, reference: ref, policy: policy ?? story?.policy }, () => draftModel(redraftStory, ask, emit, '', draftOpts));
    model = build.model;
  } else model = await draftModel(redraftStory, ask, emit, '', draftOpts);
  model.detail = DETAIL_VERSION;
  const stamp = (m) => stampRequirements(m, rq && { requirementsHash, versionTag });
  stamp(model);

  const redraft = async (feedback) => {
    const m = await draftModel(redraftStory, ask, emit, feedback, draftOpts);
    m.detail = DETAIL_VERSION;
    return stamp(m);
  };

  const { model: finalModel, check } = await buildInto(building, dir, (buildDir) => checkRepairSave({
    dir: buildDir,
    model,
    // A failed detail upgrade keeps the old checked model on disk; only a never-checked one is deleted.
    saved: savedCheck ? null : saved,
    name: disambiguatedName,
    redraft,
    deps,
    tag: 'MODEL',
    facts: factsSnippet,
    slug,
    building,
    rq,
    repairScale,
    antiqueVocab,
    groundEffectVocab,
    libraryRoot: libRoot,
  }));

  return { slug, model: finalModel, reused: false, check, ...(skillBuild ? { build_source: finalModel.build_source ?? build?.build_source, build_passes: finalModel.build_passes ?? build?.build_passes } : {}), ...rqInfo };
}

// Props library: launch tower, pier, road, etc. built in the same shape language as models.
export async function getProp(name, {
  ask = askGemini,
  worker = callWorker,
  emit = () => {},
  pose: explicitPose,
  action: explicitAction,
  role: explicitRole,
  figures_v2,
  characters_v1,
  policy,
  requirementsHash,
  forceRebuild = false,
  versionTag,
} = {}) {
  const propName = (typeof name === 'string' ? name : (name?.name || '')).trim();
  const slug = modelSlug(propName);
  if (!slug) throw new Error('A 3D prop needs a name.');

  const figure = parseFigureProp(propName);
  if (figure.isFigure) {
    const poseObj = typeof explicitPose === 'object' && explicitPose !== null ? explicitPose : {};
    const pose = (typeof explicitPose === 'string' ? explicitPose : null)
      || poseObj.pose
      || (typeof name === 'object' && name?.pose)
      || figure.pose
      || 'stand';
    const action = explicitAction
      ?? poseObj.action
      ?? (typeof name === 'object' ? name?.action : undefined);
    const role = explicitRole
      ?? poseObj.role
      ?? (typeof name === 'object' ? name?.role : undefined)
      ?? figure.role;
    const isFiguresV2 = figures_v2 === true || policy?.figures_v2 === true || poseObj.figures_v2 === true;
    const isCharactersV1 = characters_v1 === true || policy?.characters_v1 === true || poseObj.characters_v1 === true;

    const figOpts = { pose };
    if (isFiguresV2) {
      figOpts.figures_v2 = true;
      if (role) figOpts.role = role;
    }
    if (isCharactersV1) {
      figOpts.characters_v1 = true;
      if (action !== undefined) figOpts.action = action;
    }

    const model = figureModel(figOpts);
    emit('PROP', `Using 3D clay figure (${pose}) for "${propName}".`);
    return {
      slug,
      model,
      reused: true,
      check: { score: 10, recognizable: true, fixes: [] },
    };
  }

  const skillBuild = skillBuildOn(policy);
  const propRoot = skillBuild ? skillBuildRoot(propsDir()) : propsDir();
  const dirSlug = skillBuild ? skillDirSlug(slug) : slug;
  const rq = requirementsHash ? pickRequirementsTarget(propRoot, dirSlug, { requirementsHash, forceRebuild }) : null;
  const building = Boolean(rq && !rq.reuse);
  const dir = rq ? rq.dir : path.join(propRoot, dirSlug);
  const saved = building ? null : readJson(path.join(dir, 'model.json'));
  const savedCheck = building ? null : readJson(path.join(dir, 'check.json'));
  const rqInfo = rq ? { requirements_hash: requirementsHash, library_slug: rq.libSlug, version: rq.version } : {};
  if (structuralReuse(saved, savedCheck)) {
    emit('PROP', `Reusing the 3D prop "${saved.name || propName}" from the library structurally; it needs review.`);
    return { slug, model: saved, reused: true, structural: true, needs_review: true, check: null, ...rqInfo };
  }
  if (saved && savedCheck) {
    emit('PROP', `Reusing the 3D prop "${saved.name || propName}" from the library.`);
    return { slug, model: saved, reused: true, check: savedCheck, ...rqInfo };
  }
  if (saved) {
    emit('PROP', `"${saved.name || propName}" is in the library but was never checked; checking it now.`);
  }

  const deps = { ask, worker, emit };
  const draftOpts = { requireInterior: false, prompt: propPrompt(propName), tag: 'PROP' };
  let build = null;
  let model = saved;
  if (!model && skillBuild) {
    build = await skillOrFallback({ name: propName }, { ask, emit, tag: 'PROP', requireInterior: false, policy }, () => draftModel({ name: propName }, ask, emit, '', draftOpts));
    model = build.model;
  } else if (!model) model = await draftModel({ name: propName }, ask, emit, '', draftOpts);
  if (!model.name) model.name = propName;
  const stamp = (m) => stampRequirements(m, rq && { requirementsHash, versionTag });
  stamp(model);

  const redraft = async (feedback) => {
    const m = await draftModel({ name: propName }, ask, emit, feedback, draftOpts);
    if (!m.name) m.name = propName;
    return stamp(m);
  };

  const { model: finalModel, check } = await buildInto(building, dir, (buildDir) => checkRepairSave({
    dir: buildDir,
    model,
    saved,
    name: propName,
    redraft,
    deps,
    tag: 'PROP',
  }));

  return { slug, model: finalModel, reused: false, check, ...(skillBuild ? { build_source: finalModel.build_source ?? build?.build_source, build_passes: finalModel.build_passes ?? build?.build_passes } : {}), ...rqInfo };
}

// ---- Detail pass: 3-8 real pieces inside the 1-2 parts the story is about, so they can be taken apart ----
const detailPrompt = (model, story, policy) => `You are a technical 3D modeller adding detail to the model "${model.name || story.name}" for a video about "${story.name}".
${story.facts?.length ? `Facts:\n${story.facts.map((f) => `- ${f}`).join('\n')}\n` : ''}Current parts: ${JSON.stringify(model.parts)}

Pick the 1-2 existing parts the story is about (not the whole body) and add 3-8 real pieces inside them, so the viewer can watch them being taken apart.
Return ONLY this JSON, no commentary: {"parts": [{"id": "new_snake_case_id", "label": "short real name", "parent": "<id of the chosen existing part>", "stage": 1, "shape": "...", ...shape parameters, "at": [x, y, z], "material": "..."}]}

RULES
- Only new parts, 3-8 in total, on at most 2 different chosen parents. Every "parent" is an existing part id. New ids must not exist yet.
- Metres, z up. "at" is absolute (NOT relative to the parent). Each piece lies inside its parent's box (at most 10% over its edges).
- "label" is the piece's real name, shown as text in the video.
- Pick a compact part that can hold its pieces (a thrust cone, a pump, a cockpit), not a long plain hull. Put the pieces on or just under its surface so a close-up of the part shows them.
${SHAPE_RULES}${skillsPrompt('model_build', { policy: policy ?? story?.policy })}`;

const outsideParent = (boxes, added) => added.filter((k) => {
  const [pl, ph] = boxes[k.parent];
  const [cl, ch] = boxes[k.id];
  return [0, 1, 2].some((i) => cl[i] < pl[i] - 0.1 * (ph[i] - pl[i]) || ch[i] > ph[i] + 0.1 * (ph[i] - pl[i]));
}).map((k) => `part ${k.id}: lies outside the box of its parent "${k.parent}"; move or shrink it to sit inside`);

// ---- Required named part (KAN-334): the one part an asset spec names exactly. Structural checks only (no render, no vision score).
// It throws instead of returning the model, so a missing part can never pass as a detail pass. Nothing is saved until every check passes.
const REQUIRED_PART_ATTEMPTS = 2;
const PIVOT_TOLERANCE_M = 0.001; // the pivot is exact: the requested origin, to within 1 mm
const ANCHOR_NAME = /^[a-z][a-z0-9_]{0,31}$/;

const requiredPartPrompt = (model, story, required, { material, motion, policy }) => `You are a technical 3D modeller adding ONE named part to the model "${model.name || story.name}" for a video about "${story.name}".
${story.facts?.length ? `Facts:\n${story.facts.map((f) => `- ${f}`).join('\n')}\n` : ''}Current parts: ${JSON.stringify(model.parts)}

The part is required exactly as written. Return ONLY this JSON, no commentary: {"parts": [{"id": ${JSON.stringify(required.id)}, "label": ${JSON.stringify(required.name)}, "parent": ${JSON.stringify(required.parent ?? null)}, "stage": 1, "shape": "...", ...shape parameters, "at": ${JSON.stringify(required.pivot_m)}, "material": ${JSON.stringify(material)}, "anchors": ${JSON.stringify(required.anchors)}${motion === 'static' ? '' : ', "motion": {...}'}}]}

RULES
- Exactly one part, with id "${required.id}". Add no other part.
- Real size: the part's measured extents must equal ${required.dimensions_m.join(' × ')} m, in any axis order, within 15%.
- "at" is the pivot and must be exactly ${JSON.stringify(required.pivot_m)}. Metres, z up, absolute.
- "material" must be "${material}".
- "anchors" must be exactly ${JSON.stringify(required.anchors)}: copy each named point as given. They are metre positions in the same frame as "at".
- ${motion === 'static' ? 'The part does not move: give no "motion" field.' : `"motion" must have "type": "${motion}" (spin: "axis" and "rpm"; slide: "to": [dx, dy, dz]).`}
${SHAPE_RULES}${skillsPrompt('model_build', { policy: policy ?? story?.policy })}`;

const anchorProblems = (part) => {
  const anchors = part.anchors;
  if (!anchors || typeof anchors !== 'object' || Array.isArray(anchors)) return [`part ${part.id}: anchors must be an object of named anchors`];
  const entries = Object.entries(anchors);
  if (!entries.length || entries.length > 8) return [`part ${part.id}: give 1-8 named anchors`];
  return entries.flatMap(([name, value]) => {
    if (!ANCHOR_NAME.test(name)) return [`part ${part.id}: anchor name "${name}" must be lowercase snake_case`];
    if (triple(value) && value.every((n) => Math.abs(n) <= 10)) return [];
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2 && typeof value.part_id === 'string' && typeof value.anchor === 'string') return [];
    return [`part ${part.id}: anchor ${name} must be [x, y, z] in metres (within 10 m) or {part_id, anchor}`];
  });
};

// Exact identity, parent, material, pivot, motion and anchor schema of the one generated part. Geometry is checked by matchRequirements.
function requiredPartProblems(added, required, { material, motion }) {
  if (added.length !== 1 || added[0]?.id !== required.id) return [`return exactly one part whose id is "${required.id}"`];
  const [part] = added;
  const problems = [];
  if ((part.parent ?? null) !== (required.parent ?? null)) problems.push(`part ${required.id}: parent must be ${required.parent ?? 'null'}`);
  if (part.material !== material) problems.push(`part ${required.id}: material must be "${material}"`);
  if (!triple(part.at) || part.at.some((n, i) => Math.abs(n - required.pivot_m[i]) > PIVOT_TOLERANCE_M)) problems.push(`part ${required.id}: "at" (its pivot) must be ${required.pivot_m.join(', ')}`);
  if (motion === 'static' ? part.motion != null : part.motion?.type !== motion) problems.push(`part ${required.id}: motion must be ${motion === 'static' ? 'absent (static)' : motion}`);
  return [...problems, ...anchorProblems(part)];
}

// Library names are modelSlug output with an optional __v<n> suffix; the resolved target must stay inside the library root.
const LIBRARY_NAME = /^[a-z0-9][a-z0-9-]{0,80}$/;
function libraryBase(root, slug) {
  const base = String(slug).replace(/__v\d+$/, '');
  const inside = path.resolve(root, slug).startsWith(path.resolve(root) + path.sep);
  if (!LIBRARY_NAME.test(base) || !inside) throw new Error(`"${slug}" is not a valid library entry name.`);
  return base;
}

// The repaired model becomes a new immutable library version (never an overwrite). Its only receipt is structural: nothing here certifies it.
async function saveRequiredVersion(root, base, model, requirementsHash) {
  const rq = pickRequirementsTarget(root, base, { requirementsHash, forceRebuild: true });
  const saved = { ...model, ...(requirementsHash && { requirements_hash: requirementsHash }) };
  fs.mkdirSync(root, { recursive: true });
  await buildInto(true, rq.dir, (tmp) => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'model.json'), JSON.stringify(saved, null, 2));
    fs.writeFileSync(path.join(tmp, 'check.json'), JSON.stringify({ acceptance: 'structural', score: null, needs_review: true }, null, 2));
  });
  return { libSlug: rq.libSlug, version: rq.version };
}

// Gemini writes one part -> exact checks -> model schema -> measured dimensions, material, pivot, anchors. Returns { model, commit }:
// nothing is written here; the caller runs commit() only after every required part of the asset has matched.
export async function addRequiredPart(model, story, { ask = askGemini, emit = () => {}, librarySlug, kind, requirementsHash, policy } = {}) {
  const required = story.required_part;
  const material = materialClass(required.material);
  const motion = motionKind(required.motion);
  if (!material) throw new Error(`Required named part ${required.id} needs a material the model has no class for ("${required.material}"); needs review.`);
  if (!motion) throw new Error(`Required named part ${required.id} has motion "${required.motion}", which has no supported kinematics (static, spin or slide); needs review.`);
  const root = kind === 'prop' ? propsDir() : modelsDir();
  const base = librarySlug ? libraryBase(root, librarySlug) : null;
  let feedback = '';
  let problems = [];
  for (let attempt = 0; attempt < REQUIRED_PART_ATTEMPTS; attempt++) {
    const raw = await ask(requiredPartPrompt(model, story, required, { material, motion, policy }) + feedback, { model: GEMINI_MID_MODEL, maxTokens: 4096 });
    if (!raw) throw new Error('Gemini is unavailable (no Antigravity CLI and no API key).');
    const added = Array.isArray(raw.parts) ? raw.parts : [];
    problems = requiredPartProblems(added, required, { material, motion });
    const merged = { ...model, parts: [...model.parts, ...added] };
    if (!problems.length) problems = validateModel(merged, { requireInterior: false });
    if (!problems.length) problems = matchRequirements({ parts: [{ ...required, parent: undefined }] }, merged, { parts: { [required.id]: required.id } }).mismatches;
    if (!problems.length) {
      emit('MODEL', `Added the required part "${required.name}" (${required.id}); dimensions, material, pivot, parent and anchors verified.`);
      return { model: merged, commit: () => (base ? saveRequiredVersion(root, base, merged, requirementsHash) : null) };
    }
    feedback = withFeedback({ parts: added }, 'It has these problems:', problems);
  }
  throw new Error(`Required named part ${required.id} could not be built: ${problems.slice(0, 3).join('; ')}`);
}

// Gemini picks the parts -> validate -> close-up vision check -> at most one repair -> save to the library. Any failure skips the pass.
// librarySlug (optional): save into this library dir (e.g. a requirements version <slug>__v2) instead of the name-derived base dir.
// story.required_part: a named part the asset spec demands; delegates to addRequiredPart, which never early-returns and never skips.
export async function addDetail(model, story, { ask = askGemini, worker = callWorker, emit = () => {}, librarySlug, kind, requirementsHash, policy } = {}) {
  if (story?.required_part) return addRequiredPart(model, story, { ask, emit, librarySlug, kind, requirementsHash, policy });
  const children = new Map();
  for (const p of model.parts) if (p.parent) children.set(p.parent, (children.get(p.parent) || 0) + 1);
  if ([...children.values()].filter((n) => n >= 2).length >= 2) return model; // already has sub-assemblies to take apart

  const deps = { ask, worker, emit };
  const ids = new Set(model.parts.map((p) => p.id));
  const label = (id) => model.parts.find((p) => p.id === id)?.label || id;
  let feedback = '';
  let problems = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await ask(detailPrompt(model, story, policy) + feedback, { model: GEMINI_MID_MODEL, maxTokens: 8192 });
    if (!raw) throw new Error('Gemini is unavailable (no Antigravity CLI and no API key).');
    const added = Array.isArray(raw.parts) ? raw.parts : [];
    const merged = { ...model, parts: [...model.parts, ...added] };
    problems = validateModel(merged, { requireInterior: false });
    if (added.length < 3 || added.length > 8) problems.push(`add 3-8 new parts, not ${added.length}`);
    const parents = [...new Set(added.map((k) => k.parent))];
    if (parents.length > 2) problems.push('use at most 2 different parents');
    for (const k of added) if (!ids.has(k.parent)) problems.push(`part ${k.id}: parent "${k.parent}" must be an existing part`);
    let shots = [];
    if (!problems.length) {
      const reject = (shot) => {
        if (!shot.boxes) throw new Error('Blender worker returned no part boxes.');
        return outsideParent(shot.boxes, added).join('; ') || null;
      };
      for (const focus of parents) {
        const { shot, check } = await inspect(merged, `the ${label(focus)} of ${story.name}`, deps, { focus, reject });
        shots.push(shot);
        if (!check) emit('WARN', `No vision check for the detail of "${label(focus)}" (Gemini was unavailable).`);
        else if (check.score < PASS_SCORE) {
          problems = check.fixes;
          break;
        }
      }
    }
    if (!problems.length) {
      const dir = path.join(modelsDir(), librarySlug || modelSlug(story.wiki_title || story.name));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(merged, null, 2));
      shots.forEach((shot, n) => shot.images.forEach((b64, i) => fs.writeFileSync(path.join(dir, `detail_${n + 1}_${i + 1}.png`), Buffer.from(b64, 'base64'))));
      emit('MODEL', `Added ${added.length} pieces to ${parents.map(label).join(' and ')}; saved to the library.`);
      return merged;
    }
    feedback = withFeedback({ parts: added }, 'It has these problems:', problems);
  }
  emit('WARN', `Detail pass skipped: ${problems.slice(0, 3).join('; ')}`);
  return model;
}

export const partList = (model) => model.parts.map((p) => ({ id: p.id, label: p.label || p.id, interior: Boolean(p.interior), motion: Boolean(p.motion), ...(p.parent && { parent: p.parent }) }));

// ---- Routes: library list, and building one model by hand (phase-1 milestone) ----
export function listModelsHandler(req, res) {
  const dir = modelsDir();
  const slugs = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  res.json(slugs.map((slug) => ({ slug, model: readJson(path.join(dir, slug, 'model.json')), check: readJson(path.join(dir, slug, 'check.json')) }))
    .filter((m) => m.model)
    .map(({ slug, model, check }) => ({
      slug,
      name: model.name,
      parts: model.parts.length,
      score: check?.score ?? null,
      fixes: check?.fixes || [],
      previews: [1, 2, 3].map((n) => `/api/models3d/${slug}/preview_${n}.png`),
    })));
}

export function deleteModelHandler(req, res) {
  const slug = modelSlug(req.params.slug);
  if (!slug) return res.status(400).json({ error: 'Invalid model slug.' });
  const folder = path.join(modelsDir(), slug);
  if (!fs.existsSync(folder)) return res.status(404).json({ error: 'Model not found.' });
  try {
    fs.rmSync(folder, { recursive: true, force: true });
    res.json({ ok: true, deleted: slug });
  } catch (err) {
    sendGeneric5xx(req, res, 500, err);
  }
}

export function getModelMediaHandler(req, res) {
  const slug = modelSlug(req.params.slug);
  const filename = path.basename(req.params.filename || '');
  if (!slug || !filename) return res.status(400).end();
  const file = path.join(modelsDir(), slug, filename);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
}

export async function buildModelHandler(req, res) {
  if (typeof req.body?.name !== 'string' || !req.body.name.trim()) {
    return res.status(400).json({ error: 'Give the object a name.' });
  }
  if (req.body?.wiki_title !== undefined && typeof req.body.wiki_title !== 'string') {
    return res.status(400).json({ error: 'wiki_title must be a string' });
  }
  const name = req.body.name.trim().slice(0, 120);
  const story = {
    name,
    wiki_title: typeof req.body?.wiki_title === 'string' ? req.body.wiki_title : name,
    facts: Array.isArray(req.body?.facts) ? req.body.facts.map(String).slice(0, 12) : [],
    dimensions: req.body?.dimensions || null,
    components: Array.isArray(req.body?.components) ? req.body.components.map(String).slice(0, 10) : [],
  };
  try {
    const out = await getModel(story, { emit: (source, message) => console.log(`[${source}] ${message}`) });
    res.json({ slug: out.slug, reused: out.reused, score: out.check?.score ?? null, parts: out.model.parts.length });
  } catch (err) {
    if (err.message && err.message.startsWith('Model rejected')) {
      return res.status(422).json({ error: err.message });
    }
    return sendGeneric5xx(req, res, 502, err);
  }
}

// ---- KAN-777 (semantic_explainer_v1): an existing registered model explained in Studio --------------------------------------------------------
// Node-side mirror of the checks blender_worker/semantic_explanation.py makes before it launches Blender: a hostile asset id or a malformed envelope
// is refused here, before anything is queued. The worker still owns everything that needs the reviewed explanation.json (parts, joints, ranges, order).
export const SEMANTIC_ASSET_ID = /^[a-z0-9_-]+$/; // worker ID_FULL, fullmatch: JS `$` (no m flag) does not accept a trailing newline either
export const SEMANTIC_LIMITS = Object.freeze({ idLen: 64, rows: 256, frames: 1800, depth: 12, bodyBytes: 64 * 1024, fps: 120, resolutions: [25, 100] });
// KAN-777: the worker's own timeout rule (blender_worker/semantic_explanation.py timeout_seconds / MAX_TIMEOUT_SECONDS): the same formula, so a job it is certain to
// refuse is refused here before the worker is asked. A test pins the two together.
export const SEMANTIC_WORKER_TIMEOUT = Object.freeze({ startupSeconds: 600, secondsPerFrame: Object.freeze({ 25: 3, 100: 12 }), maxSeconds: 3600 });
export const semanticTimeoutSeconds = (frames, resolution) => SEMANTIC_WORKER_TIMEOUT.startupSeconds + frames * SEMANTIC_WORKER_TIMEOUT.secondsPerFrame[resolution];
export const semanticWorkerAccepts = (frames, resolution) => semanticTimeoutSeconds(frames, resolution) <= SEMANTIC_WORKER_TIMEOUT.maxSeconds;
const SEMANTIC_ENVELOPE_KEYS = ['version', 'asset', 'stage', 'fps', 'frames', 'removals', 'operations', 'shots'];
const SEMANTIC_REVEAL_MODES = ['transparent', 'cutaway'];

export function semanticAssetId(asset) {
  if (typeof asset !== 'string' || asset.length === 0 || asset.length > SEMANTIC_LIMITS.idLen || !SEMANTIC_ASSET_ID.test(asset)) {
    throw new Error(`asset must be a registered asset id matching ${SEMANTIC_ASSET_ID.source} (max ${SEMANTIC_LIMITS.idLen} chars), never a path or a topic tag`);
  }
  return asset;
}

const sInt = (v) => Number.isInteger(v);
const sNum = (v) => typeof v === 'number' && Number.isFinite(v);
const sVec = (v) => Array.isArray(v) && v.length === 3 && v.every(sNum);
const sStr = (v) => typeof v === 'string';
const sPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function sDepth(v) { return v !== null && typeof v === 'object' ? 1 + Math.max(0, ...Object.values(v).map(sDepth)) : 0; }

// Envelope (worker POST /semantic semantic_explanation) -> a copy with the same keys, or an Error listing every problem. Frames are one-based inclusive.
export function validateSemanticEnvelope(env) {
  const bad = [];
  const add = (m) => bad.push(m);
  if (!sPlain(env)) throw new Error('semantic envelope must be an object');
  if (sDepth(env) > SEMANTIC_LIMITS.depth) add(`envelope is nested deeper than ${SEMANTIC_LIMITS.depth}`);
  if (env.version !== 1) add('version must be 1');
  if (env.stage !== 'inspect' && env.stage !== 'render') add('stage must be one of inspect, render');
  try { semanticAssetId(env.asset); } catch (err) { add(err.message); }
  const allowed = env.stage === 'inspect' ? ['version', 'asset', 'stage'] : SEMANTIC_ENVELOPE_KEYS;
  const extra = Object.keys(env).filter((k) => !allowed.includes(k));
  if (extra.length) add(env.stage === 'inspect' ? 'inspect envelope takes only version, asset, stage' : `unknown envelope keys ${JSON.stringify(extra)}`);
  if (env.stage === 'render') {
    const { fps, frames } = env;
    if (!sInt(fps) || fps < 1 || fps > SEMANTIC_LIMITS.fps) add(`fps must be an integer 1..${SEMANTIC_LIMITS.fps}`);
    if (!sInt(frames) || frames < 2 || frames > SEMANTIC_LIMITS.frames) add(`frames must be an integer 2..${SEMANTIC_LIMITS.frames}`);
    const okFrames = sInt(frames) && frames >= 2 && frames <= SEMANTIC_LIMITS.frames;
    const only = (row, keys, what) => { const x = Object.keys(row).filter((k) => !keys.includes(k)); if (x.length) add(`${what}: unknown fields ${JSON.stringify(x)}`); };
    const listed = (name) => {
      const rows = env[name] ?? [];
      if (!Array.isArray(rows) || rows.length > SEMANTIC_LIMITS.rows || !rows.every(sPlain)) { add(`${name} must be a list of at most ${SEMANTIC_LIMITS.rows} objects`); return []; }
      return rows;
    };
    const window = (row, what) => {
      if (!sInt(row.start) || !sInt(row.end)) add(`${what}: start and end must be integers`);
      else if (okFrames) { if (!(row.start < row.end)) add(`${what}: start < end required`); if (row.start < 1 || row.end > frames) add(`${what}: must lie inside 1..frames`); }
    };
    const partId = (row, what) => { if (!sStr(row.part_id) || !row.part_id || row.part_id.length > SEMANTIC_LIMITS.idLen) add(`${what}: part_id must be a non-empty string of at most ${SEMANTIC_LIMITS.idLen} chars`); };
    const seen = { removals: new Set(), operations: new Set() };
    const removals = listed('removals');
    for (const r of removals) {
      const what = `removal ${r.part_id}`;
      only(r, ['part_id', 'start', 'end'], what); window(r, what); partId(r, what);
      if (seen.removals.has(r.part_id)) add(`${what}: removed twice`); else seen.removals.add(r.part_id);
    }
    const starts = removals.map((r) => r.start).filter(sInt);
    if (starts.some((s, i) => i && s < starts[i - 1])) add('removals must be listed in start order');
    for (const o of listed('operations')) {
      const what = `operation ${o.part_id}`;
      only(o, ['part_id', 'start', 'end', 'amount'], what); window(o, what); partId(o, what);
      if (seen.operations.has(o.part_id)) add(`${what}: operated twice`); else seen.operations.add(o.part_id);
      if (!sNum(o.amount) || o.amount === 0) add(`${what}: amount must be a non-zero finite number`);
    }
    const shots = listed('shots');
    if (!shots.length) add('shots missing');
    const ids = new Set();
    let expect = 1;
    for (const s of shots) {
      const what = `shot ${s.id}`;
      only(s, ['id', 'start', 'end', 'camera', 'target_parts', 'reveal'], what);
      if (!sStr(s.id) || !s.id || s.id.length > SEMANTIC_LIMITS.idLen || ids.has(s.id)) add(`${what}: shot ids must be unique non-empty strings of at most ${SEMANTIC_LIMITS.idLen} chars`);
      if (sStr(s.id)) ids.add(s.id);
      window(s, what);
      if (sInt(s.start)) { if (s.start !== expect) add(`${what}: shots must cover the timeline contiguously (starts at ${s.start}, expected ${expect})`); expect = sInt(s.end) ? s.end + 1 : expect; }
      const cam = sPlain(s.camera) ? s.camera : (add(`${what}: camera missing`), {});
      only(cam, ['position', 'end_position', 'target', 'lens'], `${what} camera`);
      for (const k of ['position', 'target', ...('end_position' in cam ? ['end_position'] : [])]) if (!sVec(cam[k])) add(`${what}: camera ${k} must be 3 finite numbers`);
      if (sVec(cam.target) && ['position', 'end_position'].some((k) => sVec(cam[k]) && Math.hypot(...cam[k].map((x, i) => x - cam.target[i])) < 1e-6)) add(`${what}: camera at its target`);
      const lens = cam.lens ?? 50;
      if (!sNum(lens) || lens < 1 || lens > 500) add(`${what}: camera lens must be 1..500 mm`);
      if (s.target_parts !== undefined && (!Array.isArray(s.target_parts) || !s.target_parts.length || s.target_parts.length > SEMANTIC_LIMITS.rows || !s.target_parts.every((x) => sStr(x) && x && x.length <= SEMANTIC_LIMITS.idLen))) add(`${what}: target_parts must be a non-empty list of part ids`);
      if (s.reveal !== undefined) {
        const rv = sPlain(s.reveal) ? s.reveal : (add(`${what}: reveal must be an object`), {});
        only(rv, ['part_id', 'mode', 'alpha', 'plane_point', 'plane_normal'], `${what} reveal`);
        if (!sStr(rv.part_id) || !rv.part_id || rv.part_id.length > SEMANTIC_LIMITS.idLen) add(`${what}: reveal part_id must be a part id`);
        if (!SEMANTIC_REVEAL_MODES.includes(rv.mode)) add(`${what}: reveal mode must be one of ${SEMANTIC_REVEAL_MODES.join(', ')}`);
        else if (rv.mode === 'transparent' && !(sNum(rv.alpha ?? 0.15) && (rv.alpha ?? 0.15) >= 0 && (rv.alpha ?? 0.15) <= 1)) add(`${what}: reveal alpha must lie in 0..1`);
        else if (rv.mode === 'cutaway') {
          if (!sVec(rv.plane_point)) add(`${what}: reveal plane_point must be 3 finite numbers`);
          if (!sVec(rv.plane_normal) || Math.hypot(...rv.plane_normal) < 1e-9) add(`${what}: reveal plane_normal must be a non-zero 3-vector`);
        }
      }
    }
    if (okFrames && shots.length && expect !== frames + 1) add(`shots end at frame ${expect - 1}; they must cover frame ${frames}`);
  }
  if (bad.length) throw new Error(`semantic envelope rejected:\n${bad.map((p) => `- ${p}`).join('\n')}`);
  return JSON.parse(JSON.stringify(env));
}

export const semanticAssetsDir = assets3dDir;

// <root>/<rel> proved to lie under the real root with no component a symlink or Windows junction (lstat reports both as links). Plain relative paths only.
function semanticConfined(root, rel) {
  const parts = String(rel).replace(/\\/g, '/').split('/');
  if (!rel || parts.some((p) => p === '' || p === '.' || p === '..' || p.includes(':') || p.includes('\0'))) throw new Error(`path ${JSON.stringify(rel)} is not a plain relative path`);
  let current = root;
  if (fs.lstatSync(current).isSymbolicLink()) throw new Error('the assets root is a symlink or junction');
  for (const part of parts) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`${JSON.stringify(part)} is a symlink or junction: registrations that point elsewhere are refused`);
  }
  const real = fs.realpathSync(current);
  const rootReal = fs.realpathSync(root);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error(`path ${JSON.stringify(rel)} escapes the assets root`);
  return real;
}
const sha256Stream = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
});

// The registered source as it stands on disk right now: asset.json, explanation.json and the model file, each hashed (the worker reports the same hashes in its
// result), plus one combined hash. Refuses an unregistered asset, a missing explanation.json or any link on the way. No topic-tag lookup, ever.
export async function semanticSourceIdentity(asset, { assetsRoot = assets3dDir() } = {}) {
  semanticAssetId(asset);
  let specFile;
  try { specFile = semanticConfined(assetsRoot, `${asset}/asset.json`); } catch (err) { throw new Error(`asset ${JSON.stringify(asset)} is not registered under data/assets3d (${err.code || err.message})`); }
  const spec = readJson(specFile);
  if (!sPlain(spec)) throw new Error(`asset ${JSON.stringify(asset)}: asset.json is not a JSON object`);
  const name = spec.file ?? 'model.glb';
  if (!sStr(name)) throw new Error('asset.json file must be a string');
  const rels = { 'asset.json': 'asset.json', 'explanation.json': 'explanation.json', [name]: name };
  const files = {};
  for (const [label, rel] of Object.entries(rels)) {
    let real;
    try { real = semanticConfined(assetsRoot, `${asset}/${rel}`); } catch (err) { throw new Error(`asset ${JSON.stringify(asset)}: ${label} is not usable (${err.code || err.message})`); }
    if (!fs.statSync(real).isFile()) throw new Error(`asset ${JSON.stringify(asset)}: ${label} is not a file`);
    files[label] = await sha256Stream(real);
  }
  const source_sha256 = crypto.createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)))).digest('hex');
  return { asset, model_file: name, files, source_sha256 };
}
