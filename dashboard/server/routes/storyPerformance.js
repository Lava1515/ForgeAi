// Story performance v1 contract. JS mirror of blender_worker/performance.py; both are tested against
// tests/fixtures/storyPerformanceV1.json so the two validators cannot drift apart. Pure: no I/O.
export const PERFORMANCE_SCHEMA_VERSION = 1;
const ASSETS = ['quaternius_standard'];
const PROP_KINDS = ['table', 'button', 'lamp', 'box', 'hinged_box'];
const ACTIONS = ['walk_to', 'point_at', 'press', 'pick_up', 'carry_to', 'place', 'open', 'close', 'react', 'idle'];
const TARGET_ACTIONS = ['walk_to', 'point_at', 'press', 'pick_up', 'carry_to', 'place', 'open', 'close']; // react/idle reject a supplied target_id
const EVENTS = ['contact'];
const EFFECTS = { set_light: ['lamp', ['off', 'white', 'blue']], set_hinge: ['hinged_box', ['open', 'closed']] }; // kind -> [target prop kind, states]
const MAX_PROPS = 8;
const MAX_CUES = 32;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isIndex = (v) => isNum(v) && Number.isInteger(v) && v >= 0;
const isVec = (v, positive = false) => Array.isArray(v) && v.length === 3 && v.every((c) => isNum(c) && (!positive || c > 0));
const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const oneOf = (v, allowed) => typeof v === 'string' && allowed.includes(v);

// Strict allowlist: unknown keys (including caller-supplied paths or commands) are rejected, never dropped.
function only(obj, allowed, where, errs) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errs.push(`${where}: unknown field ${JSON.stringify(k)}`);
}

function items(v, cap, where, errs) {
  if (!Array.isArray(v)) {
    errs.push(`${where} must be a list`);
    return [];
  }
  if (v.length > cap) errs.push(`${where} exceeds ${cap} items`);
  return v;
}

function check(spec, errs) {
  if (!isObj(spec)) {
    errs.push('spec must be an object');
    return;
  }
  only(spec, ['version', 'actor', 'props', 'cues'], 'spec', errs);
  if (!(isNum(spec.version) && spec.version === PERFORMANCE_SCHEMA_VERSION)) errs.push(`unsupported version ${JSON.stringify(spec.version)}`);

  const ids = new Set();
  const claim = (v, where) => {
    if (!isId(v)) errs.push(`${where}: id must match [A-Za-z0-9_-]{1,64}`);
    else if (ids.has(v)) errs.push(`duplicate id ${JSON.stringify(v)}`);
    else ids.add(v);
  };

  let actor = spec.actor;
  if (!isObj(actor)) {
    errs.push('actor must be exactly one object');
    actor = {};
  } else {
    only(actor, ['id', 'asset', 'at_m', 'yaw_deg'], 'actor', errs);
    claim(actor.id, 'actor');
    if (!oneOf(actor.asset, ASSETS)) errs.push(`unknown asset ${JSON.stringify(actor.asset)}`);
    if (!isVec(actor.at_m)) errs.push('actor.at_m must be 3 finite numbers');
    if (!isNum(actor.yaw_deg)) errs.push('actor.yaw_deg must be a finite number');
  }

  const kinds = new Map();
  for (const p of items(spec.props, MAX_PROPS, 'props', errs)) {
    if (!isObj(p)) {
      errs.push('prop must be an object');
      continue;
    }
    only(p, ['id', 'kind', 'at_m', 'size_m'], 'prop', errs);
    claim(p.id, 'prop');
    if (!oneOf(p.kind, PROP_KINDS)) errs.push(`unknown prop kind ${JSON.stringify(p.kind)}`);
    if (!isVec(p.at_m)) errs.push(`prop ${JSON.stringify(p.id)} at_m must be 3 finite numbers`);
    if (!isVec(p.size_m, true)) errs.push(`prop ${JSON.stringify(p.id)} size_m must be 3 positive finite numbers`);
    if (isId(p.id)) kinds.set(p.id, p.kind);
  }

  for (const c of items(spec.cues, MAX_CUES, 'cues', errs)) {
    if (!isObj(c)) {
      errs.push('cue must be an object');
      continue;
    }
    const label = JSON.stringify(c.id);
    only(c, ['id', 'actor_id', 'action', 'target_id', 'scene_index', 'word_index', 'event', 'prepare_s', 'recover_s', 'effect'], 'cue', errs);
    claim(c.id, 'cue');
    if (!isId(actor.id) || c.actor_id !== actor.id) errs.push(`cue ${label}: unresolved actor_id`);
    if (!oneOf(c.action, ACTIONS)) errs.push(`unknown action ${JSON.stringify(c.action)}`);
    else if (TARGET_ACTIONS.includes(c.action)) {
      if (!(isId(c.target_id) && kinds.has(c.target_id))) errs.push(`cue ${label}: unresolved target_id`);
    } else if ('target_id' in c) errs.push(`cue ${label}: ${c.action} takes no target_id`);
    if (!oneOf(c.event, EVENTS)) errs.push(`unknown event ${JSON.stringify(c.event)}`);
    if (!isIndex(c.scene_index)) errs.push(`cue ${label}: scene_index must be a non-negative integer`);
    if (!isIndex(c.word_index)) errs.push(`cue ${label}: word_index must be a non-negative integer`);
    for (const k of ['prepare_s', 'recover_s']) {
      if (!(isNum(c[k]) && c[k] >= 0)) errs.push(`cue ${label}: ${k} must be a finite number >= 0`);
    }
    if ('effect' in c) {
      const eff = c.effect;
      if (!isObj(eff)) {
        errs.push(`cue ${label}: effect must be an object`);
        continue;
      }
      only(eff, ['kind', 'target_id', 'state'], 'effect', errs);
      if (!oneOf(eff.kind, Object.keys(EFFECTS))) {
        errs.push(`unknown effect kind ${JSON.stringify(eff.kind)}`);
        continue;
      }
      const [needKind, states] = EFFECTS[eff.kind];
      if (!(isId(eff.target_id) && kinds.get(eff.target_id) === needKind)) errs.push(`effect ${eff.kind} needs an existing ${needKind} target`);
      if (!oneOf(eff.state, states)) errs.push(`effect state ${JSON.stringify(eff.state)} not allowed for ${eff.kind}`);
    }
  }
}

export function validateStoryPerformance(value) {
  const errors = [];
  check(value, errors);
  return errors.length ? { ok: false, errors } : { ok: true, value, errors };
}
