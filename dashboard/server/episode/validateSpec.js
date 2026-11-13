// Shot Spec validator: the gate between model output and the Blender runner.
// Structure problems are errors. An unknown verb, asset or set is NOT an error: it goes to `needs` (never to generated code).
// Returns { valid, executable, errors, needs }. executable = valid and nothing in `needs`. Never throws.
// Assets and sets are only checked against a catalogue that lists them: without one, `executable` says nothing about them.
// The per-verb argument contract of the Blender runner is verbArgs.js (validateShotArgs); here args are only bounded in shape and size.
export const PATHS = Object.freeze(['breakdown', 'whatif', 'story']);
export const ASPECTS = Object.freeze(['9:16', '16:9']);
export const ENGINES = Object.freeze(['blender', 'comfyui', 'motion', 'svg']);
export const VERBS = Object.freeze(['establish', 'push_in', 'xray', 'extract', 'explode', 'spotlight', 'run']);
export const LIMITS = Object.freeze({ shots: 60, lines: 200, cues: 20, overlays: 20, string: 2000, id: 64, word: 100000, errors: 100, args: 32, argItems: 16 });
const LOOK_KEYS = ['wireframe', 'normalColours', 'xray'];
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const BAD_IDS = new Set(['__proto__', 'constructor', 'prototype']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.length <= LIMITS.string;
const isNonBlank = (v) => isStr(v) && /\S/.test(v);
const isId = (v) => typeof v === 'string' && ID.test(v) && !BAD_IDS.has(v);
// An argument value is what the runner registry can take: a scalar, or a short flat list of scalars (vec3). No nested objects, no null.
const isScalar = (v) => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || isStr(v);
const isArgValue = (v) => isScalar(v) || (Array.isArray(v) && v.length <= LIMITS.argItems && Array.from(v).every(isScalar));
const words = (text) => (isStr(text) ? text.trim().split(/\s+/).filter(Boolean).length : 0);

export function validateSpec(spec, catalogue) {
  const errors = [];
  const needs = [];
  const issue = (path, message) => { if (errors.length < LIMITS.errors) errors.push({ path, message }); };
  const done = () => ({ valid: errors.length === 0, executable: errors.length === 0 && needs.length === 0, errors, needs });
  try {
    if (!isObj(spec)) { issue('$', 'must be an object'); return done(); }
    const cat = isObj(catalogue) ? catalogue : {};
    for (const key of ['verbs', 'assets', 'sets']) {
      if (cat[key] !== undefined && cat[key] !== null && !Array.isArray(cat[key])) issue(`catalogue.${key}`, 'must be an array');
    }
    const list = (key, fallback) => (Array.isArray(cat[key]) ? cat[key] : fallback);
    const unknownKeys = (obj, allowed, path) => {
      for (const k of Object.keys(obj)) if (!allowed.includes(k)) issue(`${path}.${k}`.replace(/^\./, ''), 'unknown key');
    };

    unknownKeys(spec, ['path', 'sub', 'aspect', 'style', 'audience', 'lines', 'shots'], '');
    if (!PATHS.includes(spec.path)) issue('path', 'unsupported path');
    if (!ASPECTS.includes(spec.aspect)) issue('aspect', 'unsupported aspect');
    for (const field of ['sub', 'style', 'audience']) if (!isNonBlank(spec[field])) issue(field, 'must be a non-blank string (max 2000 chars)');

    const lineWords = new Map();
    if (!Array.isArray(spec.lines)) issue('lines', 'must be an array');
    else {
      if (spec.lines.length > LIMITS.lines) issue('lines', `at most ${LIMITS.lines} lines`);
      Array.from(spec.lines.slice(0, LIMITS.lines)).forEach((line, i) => { // Array.from: a hole in a sparse array is checked like any other bad entry
        const p = `lines[${i}]`;
        if (!isObj(line)) return issue(p, 'must be an object');
        unknownKeys(line, ['id', 'text', 'claim'], p);
        if (!isId(line.id) || lineWords.has(line.id)) issue(`${p}.id`, 'must be a unique id (A-Z a-z 0-9 _ -, max 64)');
        else lineWords.set(line.id, words(line.text));
        if (!isNonBlank(line.text)) issue(`${p}.text`, 'must be a non-blank string (max 2000 chars)');
        if (line.claim !== undefined && !isStr(line.claim)) issue(`${p}.claim`, 'must be a string (max 2000 chars)');
      });
    }

    if (!Array.isArray(spec.shots) || !spec.shots.length) issue('shots', 'must be a non-empty array');
    else {
      if (spec.shots.length > LIMITS.shots) issue('shots', `at most ${LIMITS.shots} shots`);
      const ids = new Set();
      Array.from(spec.shots.slice(0, LIMITS.shots)).forEach((shot, i) => {
        const p = `shots[${i}]`;
        if (!isObj(shot)) return issue(p, 'must be an object');
        unknownKeys(shot, ['id', 'engine', 'set', 'asset', 'verb', 'args', 'camera', 'cues', 'overlays', 'look', 'anchor'], p);
        if (!isId(shot.id) || ids.has(shot.id)) issue(`${p}.id`, 'must be a unique id (A-Z a-z 0-9 _ -, max 64)');
        else ids.add(shot.id);
        if (!ENGINES.includes(shot.engine)) issue(`${p}.engine`, 'unsupported engine');
        for (const field of ['set', 'asset', 'verb']) if (!isNonBlank(shot[field])) issue(`${p}.${field}`, 'must be a non-blank string (max 2000 chars)');
        for (const [field, key, fallback] of [['verb', 'verbs', VERBS], ['asset', 'assets', undefined], ['set', 'sets', undefined]]) {
          if (!isNonBlank(shot[field])) continue;
          const allowed = list(key, fallback);
          if (allowed && !allowed.includes(shot[field])) needs.push({ shotId: isId(shot.id) ? shot.id : null, type: field, value: shot[field] });
        }
        if (!isObj(shot.args)) issue(`${p}.args`, 'must be an object');
        else {
          const argKeys = Object.keys(shot.args);
          if (argKeys.length > LIMITS.args) issue(`${p}.args`, `at most ${LIMITS.args} arguments`);
          for (const k of argKeys.slice(0, LIMITS.args)) {
            if (!isId(k)) issue(`${p}.args`, 'argument names must be ids (A-Z a-z 0-9 _ -, max 64)');
            else if (!isArgValue(shot.args[k])) issue(`${p}.args.${k}`, `must be a boolean, a finite number, a string (max 2000 chars) or a list of at most ${LIMITS.argItems} of them`);
          }
        }
        if (!isObj(shot.camera)) issue(`${p}.camera`, 'must be an object');
        else {
          unknownKeys(shot.camera, ['move', 'target'], `${p}.camera`);
          for (const k of ['move', 'target']) if (!isStr(shot.camera[k])) issue(`${p}.camera.${k}`, 'must be a string (max 2000 chars)');
        }
        for (const [field, allowed, required] of [['cues', ['on', 'do', 'part'], ['on', 'do']], ['overlays', ['type', 'part'], ['type']]]) {
          if (!Array.isArray(shot[field])) { issue(`${p}.${field}`, 'must be an array'); continue; }
          if (shot[field].length > LIMITS[field]) issue(`${p}.${field}`, `at most ${LIMITS[field]} entries`);
          Array.from(shot[field].slice(0, LIMITS[field])).forEach((entry, j) => {
            const ep = `${p}.${field}[${j}]`;
            if (!isObj(entry)) return issue(ep, 'must be an object');
            unknownKeys(entry, allowed, ep);
            for (const k of required) if (!isNonBlank(entry[k])) issue(`${ep}.${k}`, 'must be a non-blank string (max 2000 chars)');
            if (entry.part !== undefined && !isStr(entry.part)) issue(`${ep}.part`, 'must be a string (max 2000 chars)');
          });
        }
        if (shot.look !== undefined) {
          if (!isObj(shot.look)) issue(`${p}.look`, 'must be an object');
          else {
            unknownKeys(shot.look, LOOK_KEYS, `${p}.look`);
            for (const k of LOOK_KEYS) if (shot.look[k] !== undefined && typeof shot.look[k] !== 'boolean') issue(`${p}.look.${k}`, 'must be a boolean');
          }
        }
        if (shot.anchor !== undefined) {
          if (!isObj(shot.anchor)) issue(`${p}.anchor`, 'must be an object');
          else {
            unknownKeys(shot.anchor, ['line', 'word'], `${p}.anchor`);
            if (!lineWords.has(shot.anchor.line)) issue(`${p}.anchor.line`, 'must reference an existing line id');
            const { word } = shot.anchor;
            const count = lineWords.has(shot.anchor.line) ? lineWords.get(shot.anchor.line) : 0;
            if (!Number.isInteger(word) || word < 0 || word > LIMITS.word) issue(`${p}.anchor.word`, 'must be an integer 0..100000');
            else if (lineWords.has(shot.anchor.line) && word >= count) issue(`${p}.anchor.word`, 'beyond the last word of the line');
          }
        }
      });
    }
  } catch (error) {
    issue('$', `validator failure: ${String(error && error.message).slice(0, 120)}`);
  }
  return done();
}
