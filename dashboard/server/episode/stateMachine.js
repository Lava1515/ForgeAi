// KAN-824: the Episode state machine.
// An Episode is a folder (output/episodes/<id>/) holding artifacts and one state.json. Stages run in a fixed order; the animatic is a GATE:
// the shot renders do not start until an admin approves the animatic that exists on disk right now.
//  - Each stage has an injected engine: async ({ stage, episode, inputs }) => { '<artifact>.json': value }. The machine, not the engine, writes the files.
//  - A stage's input hash = sha256 of (stage, engine version, its input artifacts; for the brief also the topic and path).
//    A stage whose hash is unchanged and whose artifacts are present and untouched is SKIPPED. A stage that re-runs resets every later stage and gate.
//  - state.json is validated on every load; anything that does not fit is refused (invalid_state), never trusted and never rewritten.
//  - Everything that changes one Episode goes through one promise chain per folder, so two runs can never interleave their writes.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { validateSpec, PATHS } from './validateSpec.js';
import { runBriefStage } from './brief.js';
import { checkDisk as checkEpisodeDisk } from './retention.js';
import {
  EpisodeError, validEpisodeId, resolveEpisodeDir, createEpisodeDir, removeEmptyEpisodeDir, listEpisodeIds,
  readArtifact, writeArtifact, writeStateFile, sha256, STATE_FILE, MAX_ARTIFACT_BYTES,
} from './artifacts.js';

export { EpisodeError, validEpisodeId };
export const STATE_VERSION = 1;
export const STAGES = Object.freeze(['brief', 'spec', 'look', 'animatic', 'shots', 'finish', 'draft']);
export const GATES = Object.freeze(['animatic']);
export const GATE_AFTER = Object.freeze({ animatic: 'animatic' }); // the gate sits after this stage; the next stage waits for approval
export const STAGE_ARTIFACTS = Object.freeze({
  brief: ['plan.json', 'brief.json', 'sources.json'], spec: ['spec.json'], look: ['look.json'], animatic: ['animatic.json'],
  shots: ['shots.json'], finish: ['finish.json'], draft: ['draft.json'],
});
export const STAGE_INPUTS = Object.freeze({
  brief: [], spec: ['plan.json', 'brief.json', 'sources.json'], look: ['spec.json'], animatic: ['spec.json', 'look.json'],
  shots: ['spec.json', 'animatic.json'], finish: ['shots.json', 'spec.json'], draft: ['finish.json'],
});
const RENDER_STAGES = new Set(['look', 'animatic', 'shots']);
export const STATUSES = Object.freeze(['idle', 'ready', 'running', 'awaiting_gate', 'failed', 'complete']);
export const LIMITS = Object.freeze({ topic: 2000, error: 300 });

const STAGE_STATUSES = ['pending', 'running', 'complete', 'failed'];
const GATE_STATUSES = ['pending', 'approved', 'rejected'];
const HASH = /^[0-9a-f]{64}$/;
const TIME = /^\d{4}-\d\d-\d\dT[\d:.]{8,16}Z$/;
export const MAX_JSON_DEPTH = 32;
const DEFAULT_MAX_EPISODES = 500;
const MAX_EPISODES_CAP = 100000;
const DEFAULT_STAGE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STAGE_TIMEOUT_MS = 60 * 60 * 1000;
function boundedEnvInt(value, fallback, min, max) {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  return Math.min(max, Math.max(min, Number(value)));
}
const gateBefore = (stage) => GATES.find((gate) => STAGES.indexOf(stage) === STAGES.indexOf(GATE_AFTER[gate]) + 1) || null;
const stageIndex = (stage) => STAGES.indexOf(stage);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const digestOf = (outputs) => sha256(JSON.stringify(Object.keys(outputs).sort().map((name) => [name, outputs[name]])));

// One chain per folder, shared by every machine in this process.
const chains = new Map();
function serialised(key, task) {
  const previous = chains.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  chains.set(key, run);
  const clear = () => { if (chains.get(key) === run) chains.delete(key); };
  run.then(clear, clear);
  return run;
}

function redact(message) {
  return String(message ?? 'stage failed')
    .replace(/[A-Za-z]:[\\/][^\s'"]*/g, '<path>')
    .replace(/\\\\[^\s'"]+/g, '<path>')
    .replace(/(?:\/[\w.@~+-]+){2,}\/?/g, '<path>')
    .replace(/\s+/g, ' ')
    .slice(0, LIMITS.error);
}

function emptyStage() { return { status: 'pending', inputHash: null, outputs: {}, startedAt: null, finishedAt: null, error: null }; }
function newState({ id, topic, path: episodePath }, now) {
  return {
    version: STATE_VERSION, id, topic, path: episodePath, createdAt: now, updatedAt: now, status: 'idle',
    stages: Object.fromEntries(STAGES.map((stage) => [stage, emptyStage()])),
    gates: Object.fromEntries(GATES.map((gate) => [gate, { status: 'pending', approvedHash: null, at: null }])),
  };
}

function bad() { throw new EpisodeError('invalid_state'); }
function jsonDepthOk(value, limit = MAX_JSON_DEPTH) {
  const stack = [[value, 0]];
  while (stack.length) {
    const [item, depth] = stack.pop();
    if (depth > limit) return false;
    if (item && typeof item === 'object') for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
  return true;
}

// Shape and consistency check for a state.json read from disk. Throws invalid_state; returns the same object when it fits.
export function validateState(state, id) {
  if (!sameKeys(state, ['version', 'id', 'topic', 'path', 'createdAt', 'updatedAt', 'status', 'stages', 'gates'])) bad();
  if (state.version !== STATE_VERSION || state.id !== id) bad();
  if (typeof state.topic !== 'string' || !state.topic.trim() || state.topic.length > LIMITS.topic || !PATHS.includes(state.path)) bad();
  for (const key of ['createdAt', 'updatedAt']) if (typeof state[key] !== 'string' || !TIME.test(state[key])) bad();
  if (!STATUSES.includes(state.status)) bad();
  if (!sameKeys(state.stages, STAGES) || !sameKeys(state.gates, GATES)) bad();
  let blocked = false;
  for (const stage of STAGES) {
    const rec = state.stages[stage];
    if (!sameKeys(rec, ['status', 'inputHash', 'outputs', 'startedAt', 'finishedAt', 'error'])) bad();
    if (!STAGE_STATUSES.includes(rec.status)) bad();
    if (rec.inputHash !== null && !(typeof rec.inputHash === 'string' && HASH.test(rec.inputHash))) bad();
    for (const key of ['startedAt', 'finishedAt']) if (rec[key] !== null && !(typeof rec[key] === 'string' && TIME.test(rec[key]))) bad();
    if (rec.error !== null && !(typeof rec.error === 'string' && rec.error.length <= LIMITS.error)) bad();
    if (!isObject(rec.outputs)) bad();
    if (rec.status === 'complete') {
      if (blocked || rec.inputHash === null || rec.startedAt === null || rec.finishedAt === null || !sameKeys(rec.outputs, STAGE_ARTIFACTS[stage])) bad();
      for (const hash of Object.values(rec.outputs)) if (!(typeof hash === 'string' && HASH.test(hash))) bad();
    } else {
      blocked = true;
      if (Object.keys(rec.outputs).length) bad();
    }
  }
  for (const gate of GATES) {
    const rec = state.gates[gate];
    if (!sameKeys(rec, ['status', 'approvedHash', 'at']) || !GATE_STATUSES.includes(rec.status)) bad();
    if (rec.approvedHash !== null && !(typeof rec.approvedHash === 'string' && HASH.test(rec.approvedHash))) bad();
    if (rec.at !== null && !(typeof rec.at === 'string' && TIME.test(rec.at))) bad();
    if (rec.status === 'approved' && (rec.at === null || rec.approvedHash === null || state.stages[GATE_AFTER[gate]].status !== 'complete')) bad();
    if (rec.status === 'rejected' && rec.at === null) bad();
    if (rec.status !== 'approved' && rec.approvedHash !== null) bad();
    const next = STAGES[stageIndex(GATE_AFTER[gate]) + 1];
    if (next && rec.status !== 'approved' && state.stages[next].status !== 'pending') bad(); // nothing past a closed gate may have started
  }
  return state;
}

function deriveStatus(state) {
  const stages = STAGES.map((stage) => state.stages[stage]);
  if (stages.some((rec) => rec.status === 'failed')) return 'failed';
  if (stages.every((rec) => rec.status === 'complete')) return 'complete';
  if (stages.some((rec) => rec.status === 'running')) return 'running';
  for (const gate of GATES) {
    const rec = state.gates[gate];
    if (state.stages[GATE_AFTER[gate]].status === 'complete' && rec.status !== 'approved') return 'awaiting_gate';
  }
  return stages.some((rec) => rec.status === 'complete') || GATES.some((gate) => state.gates[gate].status !== 'pending') ? 'ready' : 'idle';
}

function resetFrom(state, stage) { // this stage and every later stage and gate go back to pending
  for (const name of STAGES.slice(stageIndex(stage))) state.stages[name] = emptyStage();
  for (const gate of GATES) if (stageIndex(GATE_AFTER[gate]) >= stageIndex(stage)) state.gates[gate] = { status: 'pending', approvedHash: null, at: null };
}

function checkInputs(input, { requireId }) {
  if (!isObject(input)) throw new EpisodeError('bad_request');
  const allowed = requireId ? ['id', 'topic', 'path'] : ['topic', 'path'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new EpisodeError('bad_request');
  const { topic, path: episodePath } = input;
  if (typeof topic !== 'string' || !topic.trim() || topic.length > LIMITS.topic || !PATHS.includes(episodePath)) throw new EpisodeError('bad_request');
  return { topic: topic.trim(), path: episodePath };
}

export function createEpisodeMachine({ root, engines = {}, clock = () => new Date(), fsApi = fs, maxEpisodes, stageTimeoutMs, checkDiskFn = checkEpisodeDisk } = {}) {
  if (typeof root !== 'string' || !root) throw new Error('episode machine needs a root folder');
  const now = () => clock().toISOString();
  const key = (id) => path.resolve(root, id.toLowerCase());
  const episodeLimit = maxEpisodes ?? boundedEnvInt(process.env.EPISODE_MAX_COUNT, DEFAULT_MAX_EPISODES, 1, MAX_EPISODES_CAP);
  const timeoutMs = stageTimeoutMs ?? boundedEnvInt(process.env.EPISODE_STAGE_TIMEOUT_MS, DEFAULT_STAGE_TIMEOUT_MS, 1000, MAX_STAGE_TIMEOUT_MS);

  const loadState = (dir, id) => {
    let text;
    try { text = readArtifact(dir, STATE_FILE, fsApi); } catch { bad(); }
    if (text === null) throw new EpisodeError('not_found');
    let parsed;
    try { parsed = JSON.parse(text); } catch { bad(); }
    validateState(parsed, id);
    for (const stage of STAGES) if (parsed.stages[stage].status === 'running') parsed.stages[stage] = emptyStage(); // a crash mid-stage: redo it
    parsed.status = deriveStatus(parsed);
    return parsed;
  };
  const saveState = (dir, state, status) => {
    state.updatedAt = now();
    state.status = status || deriveStatus(state);
    writeStateFile(dir, `${JSON.stringify(state, null, 2)}\n`, fsApi);
  };
  const withEpisode = (id, task) => {
    const dir = resolveEpisodeDir(root, id, fsApi); // throws invalid_id / not_found before anything is queued
    return serialised(key(id), () => task(dir));
  };

  function inputTexts(dir, stage) {
    const texts = {};
    for (const name of STAGE_INPUTS[stage]) {
      const text = readArtifact(dir, name, fsApi);
      if (text === null) throw new Error('an input artifact is missing');
      texts[name] = text;
    }
    return texts;
  }
  const hashFor = (stage, state, texts) => sha256(JSON.stringify([
    stage, engines[stage]?.version ?? 'v0', ...(stage === 'brief' ? [state.topic, state.path] : []),
    STAGE_INPUTS[stage].map((name) => [name, sha256(texts[name])]),
  ]));

  // The stage's artifacts are all there, parse, are untouched since they were written, and (for the spec) still pass the validator.
  function outputsIntact(dir, stage, rec) {
    try {
      for (const name of STAGE_ARTIFACTS[stage]) {
        const text = readArtifact(dir, name, fsApi);
        if (text === null || sha256(text) !== rec.outputs[name]) return false;
        const value = JSON.parse(text);
        if (!jsonDepthOk(value)) return false;
        if (name === 'spec.json' && !validateSpec(value).valid) return false;
      }
      return true;
    } catch { return false; }
  }

  async function runStage(dir, state, stage, texts) {
    let warning = null;
    try {
      const engine = engines[stage];
      if (typeof engine !== 'function') throw new Error('no engine is configured for this stage');
      const inputs = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, JSON.parse(text)]));
      if (RENDER_STAGES.has(stage)) {
        let diskTimeout;
        try {
          const disk = await Promise.race([
            Promise.resolve().then(() => checkDiskFn({ path: root })),
            new Promise(resolve => { diskTimeout = setTimeout(resolve, 1000); }),
          ]);
          if (disk?.ok === false && typeof disk.message === 'string' && disk.message) warning = redact(disk.message);
        } catch { /* A disk-stat failure must not prevent a render. */ }
        finally { clearTimeout(diskTimeout); }
      }
      const controller = new AbortController();
      let timeout;
      const timedOut = new Promise((resolve) => { timeout = setTimeout(() => { controller.abort(); resolve({ timeout: true }); }, timeoutMs); });
      const execution = Promise.resolve().then(() => engine({ stage, episode: { id: state.id, topic: state.topic, path: state.path }, inputs, signal: controller.signal }));
      const result = await Promise.race([execution.then((value) => ({ value }), (error) => ({ error })), timedOut]);
      clearTimeout(timeout);
      if (result.timeout) return { ok: false, error: 'stage timed out', ...(warning ? { warning } : {}) };
      if (result.error) throw result.error;
      const produced = result.value;
      if (!sameKeys(produced, STAGE_ARTIFACTS[stage])) throw new Error('the engine returned the wrong artifacts');
      const files = {};
      for (const name of STAGE_ARTIFACTS[stage]) {
        if (!jsonDepthOk(produced[name])) throw new Error(`${name} is too deeply nested`);
        const text = `${JSON.stringify(produced[name], null, 2)}\n`;
        if (Buffer.byteLength(text) > MAX_ARTIFACT_BYTES) throw new Error(`${name} is too large`);
        files[name] = text;
      }
      if (stage === 'spec') {
        const verdict = validateSpec(produced['spec.json']);
        if (!verdict.valid) throw new Error(`the Shot Spec is invalid: ${verdict.errors[0].path} ${verdict.errors[0].message}`);
      }
      for (const [name, text] of Object.entries(files)) writeArtifact(dir, name, text, fsApi);
      return { ok: true, outputs: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256(text)])), ...(warning ? { warning } : {}) };
    } catch (error) {
      return { ok: false, error: redact(error && error.message), ...(warning ? { warning } : {}) };
    }
  }

  async function execute(dir, id) {
    const state = loadState(dir, id);
    const ran = []; const skipped = []; const warnings = [];
    const finish = (extra = {}) => ({ status: state.status, ran, skipped, warnings, ...extra, state });
    for (const stage of STAGES) {
      const gate = gateBefore(stage);
      if (gate) {
        const gateRec = state.gates[gate];
        const stageRec = state.stages[GATE_AFTER[gate]];
        const open = gateRec.status === 'approved' && stageRec.status === 'complete' && gateRec.approvedHash === digestOf(stageRec.outputs);
        if (!open) {
          if (gateRec.status === 'approved') state.gates[gate] = { status: 'pending', approvedHash: null, at: null }; // an approval for another animatic is void
          resetFrom(state, stage);
          saveState(dir, state);
          return finish({ gate });
        }
      }
      let texts;
      try { texts = inputTexts(dir, stage); } catch { texts = null; }
      const rec = state.stages[stage];
      if (texts) {
        const hash = hashFor(stage, state, texts);
        if (rec.status === 'complete' && rec.inputHash === hash && outputsIntact(dir, stage, rec)) { skipped.push(stage); continue; }
        resetFrom(state, stage);
        const fresh = state.stages[stage];
        Object.assign(fresh, { status: 'running', startedAt: now() });
        saveState(dir, state, 'running');
        const outcome = await runStage(dir, state, stage, texts);
        if (outcome.warning) warnings.push({ stage, message: outcome.warning });
        fresh.finishedAt = now();
        if (outcome.ok) {
          Object.assign(fresh, { status: 'complete', inputHash: hash, outputs: outcome.outputs, error: null });
          ran.push(stage);
          saveState(dir, state, 'running');
          continue;
        }
        Object.assign(fresh, { status: 'failed', error: outcome.error });
      } else {
        resetFrom(state, stage);
        Object.assign(state.stages[stage], { status: 'failed', startedAt: now(), finishedAt: now(), error: 'an input artifact is missing' });
      }
      saveState(dir, state);
      return finish({ stage });
    }
    saveState(dir, state);
    return finish();
  }

  return {
    hasEngines: Object.keys(engines).length > 0,
    list: async () => listEpisodeIds(root, fsApi),
    getState: async (id) => loadState(resolveEpisodeDir(root, id, fsApi), id),

    async create(input) {
      if (!isObject(input)) throw new EpisodeError('bad_request');
      if (Object.hasOwn(input, 'id') && input.id !== undefined && !validEpisodeId(input.id)) throw new EpisodeError('invalid_id');
      const fields = checkInputs(Object.fromEntries(Object.entries(input).filter(([k, v]) => !(k === 'id' && v === undefined))), { requireId: true });
      const id = input.id !== undefined ? input.id : `ep-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
      return serialised(path.resolve(root, '.__episode_create__'), async () => {
        // Single-process server; EPISODE_ROOT is trusted local disk. The count check is cheap, but is not a cross-process lock.
        if (listEpisodeIds(root, fsApi).length >= episodeLimit) throw new EpisodeError('conflict');
        const dir = createEpisodeDir(root, id, fsApi);
        const state = newState({ id, ...fields }, now());
        try { saveState(dir, state); }
        catch (error) { removeEmptyEpisodeDir(root, id, fsApi); throw error; }
        return state;
      });
    },

    async setInputs(id, input) {
      const fields = checkInputs(input, { requireId: false });
      return withEpisode(id, async (dir) => {
        const state = loadState(dir, id);
        Object.assign(state, fields);
        saveState(dir, state);
        return state;
      });
    },

    async run(id) { return withEpisode(id, (dir) => execute(dir, id)); },

    async approveGate(id, gate) {
      if (!GATES.includes(gate)) { resolveEpisodeDir(root, id, fsApi); throw new EpisodeError('not_found'); }
      return withEpisode(id, async (dir) => {
        const state = loadState(dir, id);
        const stageRec = state.stages[GATE_AFTER[gate]];
        if (stageRec.status !== 'complete' || state.gates[gate].status !== 'pending') throw new EpisodeError('conflict');
        if (!outputsIntact(dir, GATE_AFTER[gate], stageRec)) throw new EpisodeError('conflict'); // approve only what is on disk now
        state.gates[gate] = { status: 'approved', approvedHash: digestOf(stageRec.outputs), at: now() };
        saveState(dir, state);
        return state;
      });
    },

    async rejectGate(id, gate) {
      if (!GATES.includes(gate)) { resolveEpisodeDir(root, id, fsApi); throw new EpisodeError('not_found'); }
      return withEpisode(id, async (dir) => {
        const state = loadState(dir, id);
        if (state.stages[GATE_AFTER[gate]].status !== 'complete') throw new EpisodeError('conflict');
        resetFrom(state, GATE_AFTER[gate]);
        state.gates[gate] = { status: 'rejected', approvedHash: null, at: now() };
        saveState(dir, state);
        return state;
      });
    },
  };
}

// The real brief stage (KAN-839) as an engine: it asks the planner role and returns the three artifacts. Tests pass a stub askRoleFn.
export function createBriefEngine({ root, askRoleFn, onCallRecord } = {}) {
  const engine = async ({ episode }) => {
    const result = await runBriefStage({ episodeDir: episode.id, episodesRoot: root, topic: episode.topic, path: episode.path, askRoleFn, onCallRecord });
    return { 'plan.json': result.plan, 'brief.json': result.brief, 'sources.json': result.sources };
  };
  engine.version = 'episode-brief-v1';
  return engine;
}
