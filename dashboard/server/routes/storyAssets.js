import { createHash } from 'node:crypto';

const finiteVector = (value, length = 3) => Array.isArray(value) && value.length === length && value.every((n) => typeof n === 'number' && Number.isFinite(n));

// An anchor is a finite [x, y, z] or a {part_id, anchor} reference followed through `anchorsOf(part_id)` until it reaches a point.
// Self, cyclic and dangling references resolve to null.
const resolveAnchor = (anchorsOf, value, seen = new Set()) => {
  if (finiteVector(value)) return value;
  if (!value || typeof value !== 'object' || typeof value.part_id !== 'string' || typeof value.anchor !== 'string') return null;
  const key = `${value.part_id}\u0000${value.anchor}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const targets = anchorsOf(value.part_id);
  if (!targets || typeof targets !== 'object' || !Object.hasOwn(targets, value.anchor)) return null;
  return resolveAnchor(anchorsOf, targets[value.anchor], seen);
};

export function validateAssetPlan(plan, { allowShotOverflow = false } = {}) {
  const errors = [];
  const assets = Array.isArray(plan?.assets) ? plan.assets : [];
  const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
  const ids = new Map();
  if (typeof plan?.script !== 'string' || !plan.script.trim()) errors.push('A script is required.');
  if (!assets.length) errors.push('At least one model or prop is required.');
  if (!scenes.length) errors.push('Scenes are required.');
  const addId = (id, type) => {
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(id)) errors.push(`Invalid ${type} ID: ${String(id)}.`);
    else if (ids.has(id)) errors.push(`ID collision: ${id}.`);
    else ids.set(id, type);
  };
  assets.forEach((asset) => addId(asset?.id, 'asset'));
  for (const asset of assets) for (const part of Array.isArray(asset?.parts) ? asset.parts : []) addId(part?.id, 'part');
  const assetById = new Map(assets.map((asset) => [asset?.id, asset]));
  const partById = new Map(assets.flatMap((asset) => (Array.isArray(asset?.parts) ? asset.parts : []).map((part) => [part?.id, part])));
  for (const [index, scene] of scenes.entries()) {
    if (!Number.isInteger(scene?.index) || scene.index !== index || typeof scene?.text !== 'string') errors.push(`Scene ${index} must have its exact index and narration.`);
    const targets = Array.isArray(scene?.action_targets) ? scene.action_targets : [];
    for (const target of targets) {
      const asset = assetById.get(target);
      if (!asset || !asset.parts?.length) errors.push(`Scene ${index} requires missing target part ${target}.`);
      else if (!asset.scenes?.includes(index) || !asset.narration?.some((line) => line === scene.text || (typeof line === 'string' && line.includes(scene.text)))) errors.push(`Asset ${target} does not reference scene ${index} narration.`);
    }
    const count = assets.filter((asset) => asset.scenes?.includes(index)).length;
    if (!allowShotOverflow && count > 3) errors.push(`Scene ${index} exceeds the three generated model limit.`);
  }
  for (const asset of assets) {
    if (typeof asset?.label !== 'string' || !asset.label.trim()) errors.push(`Asset ${asset?.id} needs a label.`);
    if (!Array.isArray(asset?.scenes) || !asset.scenes.length || asset.scenes.some((i) => !Number.isInteger(i) || !scenes[i])) errors.push(`Asset ${asset?.id} has unresolved scene references.`);
    if (!Array.isArray(asset?.narration) || !asset.narration.length || asset.narration.some((line) => !scenes.some((s) => s.text === line))) errors.push(`Asset ${asset?.id} has unresolved narration references.`);
    if (!Array.isArray(asset?.parts) || !asset.parts.length) errors.push(`Asset ${asset?.id} needs at least one named part.`);
    for (const part of asset?.parts || []) {
      if (typeof part?.name !== 'string' || !part.name.trim() || typeof part?.material !== 'string' || !part.material.trim()) errors.push(`Part ${part?.id} needs a name and material.`);
      if (!finiteVector(part?.dimensions_m) || part.dimensions_m.some((n) => n <= 0 || n > 10) || !finiteVector(part?.pivot_m) || part.pivot_m.some((n) => Math.abs(n) > 10)) errors.push(`Part ${part?.id} has invalid metre geometry or pivot (dimensions and pivots must stay within 10 metres).`);
      if (part.parent && !partById.has(part.parent)) errors.push(`Part ${part.id} has unresolved parent ${part.parent}.`);
      if (typeof part.motion !== 'string' || !part.motion.trim()) errors.push(`Part ${part.id} needs a motion relationship.`);
      if (!part.anchors || typeof part.anchors !== 'object' || !Object.keys(part.anchors).length) errors.push(`Part ${part.id} needs interaction anchors.`);
      for (const [name, anchor] of Object.entries(part.anchors || {})) {
        const point = resolveAnchor((id) => partById.get(id)?.anchors, anchor);
        if (point && point.every((n) => Math.abs(n) <= 10)) continue;
        errors.push(`Part ${part.id} has unresolved ${name} anchor.`);
      }
    }
  }
  const sceneRefs = scenes.map((scene) => ({ scene_index: scene.index, narration: scene.text, asset_ids: assets.filter((asset) => asset.scenes?.includes(scene.index)).map((asset) => asset.id) }));
  return { ok: errors.length === 0, assets: errors.length ? [] : assets, sceneRefs: errors.length ? [] : sceneRefs, errors };
}

export function assetPlanHash(plan, profile = {}) {
  return createHash('sha256').update(JSON.stringify({ script: plan?.script || '', scenes: plan?.scenes || [], assets: plan?.assets || [], profile })).digest('hex');
}

const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
export const assetRequirementsHash = (asset) => createHash('sha256').update(JSON.stringify(stable({ kind: asset?.kind, label: asset?.label, parts: asset?.parts || [] }))).digest('hex');
export const assetModelHash = (model) => createHash('sha256').update(JSON.stringify(stable(model))).digest('hex');

// ---- Physical requirement matching: verify a saved model.json against the script's asset spec ----
// Tolerance for requested metre sizes (relative, per sorted axis). Documented contract: 15%.
export const REQUIREMENT_TOLERANCE = 0.15;
// The model schema (model3d.js validateModel) has NO colour, pivot or anchor fields:
// - material: a palette class (hull|metal|dark|glass|fuel|copper|rubber|accent); script wording is mapped to a class below.
// - pivot: the part origin, `at` (shapes.py places every shape around `at`); only checked for parts that must move.
// - motion: part.motion.type spin|slide.
// - anchors: not in the schema; only a part that explicitly declares `anchors: {name: ...}` can satisfy one, else `anchor_unverifiable`.
const MATERIAL_CLASSES = {
  metal: ['metal', 'steel', 'iron', 'aluminium', 'aluminum', 'chrome', 'titanium', 'metallic'],
  copper: ['copper', 'brass', 'bronze'],
  glass: ['glass', 'transparent', 'window'],
  rubber: ['rubber', 'tire', 'tyre', 'silicone'],
  fuel: ['fuel', 'liquid'],
  dark: ['dark', 'black', 'carbon'],
  hull: ['hull', 'plastic', 'painted', 'paint', 'ceramic'],
  accent: ['accent'],
};
export const materialClass = (word) => { const w = String(word || '').toLowerCase().trim(); return Object.keys(MATERIAL_CLASSES).find((k) => MATERIAL_CLASSES[k].includes(w)) || null; };
// hinge is deliberately absent: a generic spin has no hinge limit, so a hinge has no supported kinematics and must fail closed.
const MOTION_TYPES = { spin: 'spin', rotate: 'spin', rotation: 'spin', turn: 'spin', slide: 'slide', translate: 'slide', push: 'slide', press: 'slide', pull: 'slide', lift: 'slide' };
const STATIC_MOTION = new Set(['', 'static', 'none', 'fixed', 'rigid']);
// 'static' | 'spin' | 'slide' for kinematics the model schema can express; null means no supported mechanism (needs review).
export const motionKind = (motion) => { const m = String(motion || '').toLowerCase().trim(); return STATIC_MOTION.has(m) ? 'static' : MOTION_TYPES[m] || null; };
const span = (values) => (values.length ? Math.max(...values) - Math.min(...values) : 0);

function rotateVec([x, y, z], [rx, ry, rz]) {
  const [a, b, c] = [rx, ry, rz].map((d) => (d * Math.PI) / 180);
  [y, z] = [y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
  [x, z] = [x * Math.cos(b) + z * Math.sin(b), -x * Math.sin(b) + z * Math.cos(b)];
  [x, y] = [x * Math.cos(c) - y * Math.sin(c), x * Math.sin(c) + y * Math.cos(c)];
  return [x, y, z];
}

// Axis-aligned local extents [x, y, z] in metres for one model part (single instance; repeat/mirror ignored), or null if unmeasurable.
export function partExtents(p) {
  let dims = null;
  if (p.shape === 'box' && Array.isArray(p.size)) dims = p.size.map(Number);
  else if (p.shape === 'cylinder') dims = [2 * p.r, 2 * p.r, p.h];
  else if (p.shape === 'cone') dims = [2 * Math.max(p.r1, p.r2), 2 * Math.max(p.r1, p.r2), p.h];
  else if (p.shape === 'sphere') dims = [2 * p.r, 2 * p.r, 2 * p.r];
  else if (p.shape === 'torus') dims = [2 * (p.r + p.thickness), 2 * (p.r + p.thickness), 2 * p.thickness];
  else if (p.shape === 'tube' && Array.isArray(p.path)) { const xyz=[0,1,2].map((k)=>span(p.path.map((q)=>q[k]))+2*p.r); dims=xyz; }
  else if (p.shape === 'panel' && Array.isArray(p.size)) dims=p.size.map(Number);
  else if (p.shape === 'truss') dims=[p.length+p.member,p.width+p.member,p.height+p.member];
  else if (p.shape === 'gear') dims=[2*(p.r+p.tooth_depth),2*(p.r+p.tooth_depth),p.thickness];
  else if (p.shape === 'lathe' && Array.isArray(p.profile)) { const d = 2 * Math.max(...p.profile.map((q) => Math.abs(q[0]))); dims = [d, d, span(p.profile.map((q) => q[1]))]; }
  else if (p.shape === 'extrude' && Array.isArray(p.outline)) {
    const a = span(p.outline.map((q) => q[0])); const b = span(p.outline.map((q) => q[1]));
    dims = { xy: [a, b, p.depth], xz: [a, p.depth, b], yz: [p.depth, a, b] }[p.plane || 'xy'];
  } else if (p.shape === 'loft' && Array.isArray(p.sections)) {
    const len = span(p.sections.map((q) => q.at)); const w = Math.max(...p.sections.map((q) => q.w)); const h = Math.max(...p.sections.map((q) => q.h));
    dims = { x: [len, w, h], y: [w, len, h], z: [w, h, len] }[p.axis || 'x'];
  }
  if (!dims || dims.length !== 3 || dims.some((v) => !Number.isFinite(v))) return null;
  if (Array.isArray(p.rot) && p.rot.some((d) => d)) {
    const corners = [-1, 1].flatMap((i) => [-1, 1].flatMap((j) => [-1, 1].map((k) => rotateVec([i * dims[0] / 2, j * dims[1] / 2, k * dims[2] / 2], p.rot))));
    dims = [0, 1, 2].map((axis) => span(corners.map((c) => c[axis])));
  }
  return dims.map((v) => +v.toFixed(6));
}

// id -> { id, label, dims (x,y,z metres or null), material, motion, parent, at, anchors }
export function measureModelParts(model) {
  return new Map((Array.isArray(model?.parts) ? model.parts : []).filter((p) => p && typeof p.id === 'string').map((p) => [p.id, {
    id: p.id, label: p.label || null, dims: partExtents(p), material: p.material ?? null, motion: p.motion?.type ?? null,
    parent: p.parent ?? null, at: Array.isArray(p.at) ? p.at : [0, 0, 0], anchors: p.anchors && typeof p.anchors === 'object' ? p.anchors : {},
  }]));
}

// A named anchor matches when both sides resolve to points within the pivot tolerance of the requested metre point. A part reference
// must also name the same reference the model has, and its chain must resolve. Presence alone is not a match.
const anchorMatches = (want, have, tol, anchorsOf) => {
  if (!finiteVector(want) && !(want && typeof want.part_id === 'string' && have?.part_id === want.part_id && have?.anchor === want.anchor)) return false;
  const wantPoint = resolveAnchor(anchorsOf, want);
  const havePoint = resolveAnchor(anchorsOf, have);
  return Boolean(wantPoint && havePoint && wantPoint.every((n, i) => Math.abs(n - havePoint[i]) <= tol));
};

// -> { ok, mismatches[] }. Codes: part_missing, dimension, material, material_unverifiable, motion_missing, motion_unsupported, pivot, parent, anchor_unverifiable, anchor_mismatch.
// `parts` is the builder's required-part-id -> model-part-id mapping (optional); otherwise parts are found by id, then by label == name.
export function matchRequirements(asset, model, { parts = {}, tolerance = REQUIREMENT_TOLERANCE } = {}) {
  const measured = measureModelParts(model);
  const mismatches = [];
  const resolve = (req) => {
    const mapped = parts[req.id];
    const byLabel = [...measured.values()].find((m) => m.label && String(req.name || '').toLowerCase() === m.label.toLowerCase());
    return measured.get(typeof mapped === 'string' ? mapped : mapped?.id) || measured.get(req.id) || byLabel || null;
  };
  for (const req of asset?.parts || []) {
    const got = resolve(req);
    if (!got) { mismatches.push(`part_missing:${req.id}`); continue; }
    if (!got.dims) mismatches.push(`dimension:${req.id} (not measurable from its shape)`);
    else {
      const want = [...req.dimensions_m].sort((a, b) => b - a); const have = [...got.dims].sort((a, b) => b - a);
      if (want.some((w, i) => Math.abs(have[i] - w) > w * tolerance)) mismatches.push(`dimension:${req.id} (measured ${have.join('×')} m vs required ${want.join('×')} m, ±${tolerance * 100}%)`);
    }
    const wantClass = materialClass(req.material);
    if (!wantClass) mismatches.push(`material_unverifiable:${req.id} ("${req.material}" has no model material class)`);
    else if (wantClass !== got.material) mismatches.push(`material:${req.id} (required ${wantClass}, model has ${got.material ?? 'none'})`);
    const motion = String(req.motion || '').toLowerCase().trim();
    const tol = Math.max(0.02, tolerance * Math.max(...req.dimensions_m));
    if (!STATIC_MOTION.has(motion)) {
      const wantType = MOTION_TYPES[motion];
      if (motion === 'hinge') mismatches.push(`motion_unsupported:${req.id} (hinge has no supported kinematics; needs review)`);
      else if (!got.motion || (wantType && wantType !== got.motion)) mismatches.push(`motion_missing:${req.id} (required ${motion})`);
      if (Array.isArray(req.pivot_m) && req.pivot_m.some((v, i) => Math.abs(v - got.at[i]) > tol)) mismatches.push(`pivot:${req.id} (model origin ${got.at.join(',')} vs required ${req.pivot_m.join(',')})`);
    }
    if (req.parent) {
      const parentReq = (asset.parts || []).find((q) => q.id === req.parent);
      const parentGot = parentReq && resolve(parentReq);
      if (!parentGot || got.parent !== parentGot.id) mismatches.push(`parent:${req.id} (required ${req.parent})`);
    }
    for (const [name, want] of Object.entries(req.anchors || {})) {
      if (!Object.hasOwn(got.anchors, name)) mismatches.push(`anchor_unverifiable:${req.id}.${name}`);
      else if (!anchorMatches(want, got.anchors[name], tol, (id) => measured.get(id)?.anchors)) mismatches.push(`anchor_mismatch:${req.id}.${name}`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

const cacheGet = (cache, key) => cache instanceof Map ? cache.get(key) : cache?.[key];
const cacheSet = (cache, key, value) => { if (cache instanceof Map) cache.set(key, value); else if (cache && typeof cache === 'object') cache[key] = value; };
// Reuse needs an exact hash and an exact re-match. A structurally repaired entry (no vision check) is reusable only in that form.
const validCachedAsset = (entry, asset) => Boolean((entry?.verified === true || entry?.structural_verified === true) && entry.model && /^[a-f0-9]{64}$/i.test(entry.hash || '') && entry.hash === assetModelHash(entry.model) && entry.requirements_hash === assetRequirementsHash(asset) && asset.parts.every((part) => entry.parts?.[part.id]) && matchRequirements(asset, entry.model, { parts: entry.parts }).ok);
const libraryInfo = (value) => ({ version: value?.version ?? null, library_slug: value?.library_slug ?? null });

export async function resolveScriptAssets(assetPlan, { strategy = 'reuse_or_generate', selectedAssetIds = [], buildModel, detailModel, loadProp, cache = new Map(), emit = () => {} } = {}) {
  const checked = validateAssetPlan(assetPlan, { allowShotOverflow: true });
  if (!checked.ok) return { status: 'needs_review', reasons: checked.errors, models: [], sceneMap: [] };
  const selected = new Set(selectedAssetIds);
  const models = [];
  const reasons = [];
  const versions = new Map();
  const sceneMap = checked.sceneRefs.map((scene) => ({ ...scene, model_ids: [...scene.asset_ids] }));
  for (const asset of checked.assets) {
    const requirementsHash = assetRequirementsHash(asset);
    const existing = cacheGet(cache, asset.id);
    const regenerate = strategy === 'regenerate_selected' && selected.has(asset.id);
    if (!regenerate && validCachedAsset(existing, asset)) {
      const model = { id: asset.id, hash: existing.hash, model: existing.model, parts: { ...existing.parts }, status: 'reused', requirements_hash: requirementsHash, needs_review: existing.needs_review === true, acceptance: existing.acceptance || 'vision', ...libraryInfo(existing) };
      models.push(model); emit('reused', model); continue;
    }
    let status = 'new'; let value;
    try {
      // Opt-in library keys (model3d.js): reuse only on an exact requirements hash; a selected regeneration builds a new version beside the original.
      const options = { strategy, requirementsHash, forceRebuild: regenerate, versionTag: regenerate ? `regen-${requirementsHash.slice(0, 8)}` : undefined };
      if (asset.kind === 'prop' && typeof loadProp === 'function') value = await loadProp(asset, options);
      else if (typeof buildModel === 'function') value = await buildModel(asset, options);
      else throw Object.assign(new Error('No compatible 3D builder is available.'), { unavailable: true });
      if (!value || value.rejected || value.check?.score < 6) throw new Error(value?.error || 'Model rejected by quality gate.');
      let modelValue = value.model || value;
      const parts = { ...(value.parts || Object.fromEntries((modelValue.parts || []).map((part) => [part.id, part.id]))) };
      // Each detail call returns the model with every part added so far; only the last one's commit is kept, so a single write happens at the end.
      let commit = null;
      let changed = false;
      for (const required of asset.parts) {
        if (parts[required.id]) continue;
        if (typeof detailModel !== 'function') throw new Error(`Required named part ${required.id} is missing and no detail builder is available.`);
        const detailed = await detailModel(modelValue, { ...asset, required_part: required, library_slug: value.library_slug, requirements_hash: requirementsHash });
        const detailedModel = detailed?.model || detailed || modelValue;
        const found = (detailed?.parts && detailed.parts[required.id]) || (detailedModel.parts || []).find((part) => part.id === required.id);
        if (!found) throw new Error(`Required named part ${required.id} was not produced.`);
        parts[required.id] = typeof found === 'string' ? found : found.id;
        modelValue = detailedModel;
        commit = detailed?.commit || null;
        changed = true;
      }
      const match = matchRequirements(asset, modelValue, { parts });
      if (!match.ok) throw new Error(`Built model does not satisfy the script requirements: ${match.mismatches.join('; ')}`);
      const hash = assetModelHash(modelValue);
      if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Builder did not return a valid model hash.');
      // Library writes happen only now, after every required part and the whole asset matched.
      const written = changed && commit ? await commit() : null;
      // A repaired model is new and structural-only: no check was run on it, so it inherits no vision check and needs review.
      // A stored structural version (model3d.js structuralReuse, no check) is structural too: it never claims a vision pass.
      const structural = changed || value.structural === true;
      const info = changed ? { version: written?.version ?? null, library_slug: written?.libSlug ?? null } : libraryInfo(value);
      const resolved = { id: asset.id, hash, parts, model: modelValue, status: changed ? 'new' : (value.reused === true ? 'reused' : status), requirements_hash: requirementsHash, needs_review: structural, acceptance: structural ? 'structural' : 'vision', ...info };
      models.push(resolved); emit(resolved.status, resolved);
      if (existing) {
        let version = versions.get(asset.id) || 1;
        while (cacheGet(cache, `${asset.id}@${version}`)) version++;
        cacheSet(cache, `${asset.id}@${version}`, existing);
        versions.set(asset.id, version + 1);
      }
      cacheSet(cache, asset.id, changed
        ? { ...value, ...info, check: undefined, model: modelValue, hash, requirements_hash: requirementsHash, verified: false, structural_verified: true, needs_review: true, acceptance: 'structural', parts }
        : { ...value, model: modelValue, hash, requirements_hash: requirementsHash, verified: value.verified === true || Boolean(value.check && value.check.score >= 6), ...(structural && { structural_verified: true, needs_review: true, acceptance: 'structural' }), parts });
    } catch (error) {
      status = error.unavailable ? 'unavailable' : 'failed';
      const result = { id: asset.id, hash: null, parts: {}, status, requirements_hash: requirementsHash, error: error.message };
      models.push(result); emit(status, result); reasons.push(`${asset.id}: ${error.message}`);
    }
  }
  for (const model of models) if (model.needs_review) reasons.push(`${model.id}: structural verification only; needs visual review`);
  for (const scene of sceneMap) {
    scene.parts = Object.fromEntries(models.filter((model) => scene.asset_ids.includes(model.id)).map((model) => [model.id, model.parts]));
  }
  for (const scene of sceneMap) {
    const generatedCount = scene.asset_ids.filter((id) => models.find((model) => model.id === id)?.status === 'new').length;
    if (generatedCount > 3) reasons.push(`Scene ${scene.scene_index} exceeds the three generated model limit; continuity-preserving partition requires review.`);
  }
  if (models.some((model) => model.status === 'failed' || model.status === 'unavailable') || reasons.length) return { status: 'needs_review', reasons, models, sceneMap };
  return { models, sceneMap };
}

export function computePlanInvalidation({ narrationChanged = false, partsChanged = [], captionStyleChanged = false } = {}) {
  if (narrationChanged) return ['voice', 'timing', 'performance'];
  const invalidated = [];
  for (const id of [...new Set(partsChanged)]) invalidated.push(`assets:${id}`, `takes:${id}`);
  if (captionStyleChanged) invalidated.push('edit');
  return invalidated;
}
