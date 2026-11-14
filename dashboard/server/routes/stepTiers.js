// CB9: model tier per step on top of the role router (askRole.js, KAN-550). askRole.js calls resolveStepTier for real calls; the daily cap lives in a file store so it survives restarts.
// Default is the cheapest model that passes; a stronger one is used only when the caller names a trigger from the
// table below, only for that one call, and only while the owner-set daily escalation cap has room (cap 0 = never) for the costly tiers Opus and Fable.
// The cheap Haiku -> Sonnet retry after a schema failure is not capped: Sonnet is the default tier of the other steps (owner can still see it, every call records its tier).
// The ask function is injected: this module starts no process, opens no network connection and holds no key.
// Token counts are copied from the usage the ask function reports; if it reports none, tokens is null (never estimated).

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_MODELS = Object.freeze({ haiku: 'haiku', sonnet: 'sonnet', opus: 'opus', fable: 'fable' });

// Fixed trusted tier -> model table. A caller (models option) may only pick another entry of the SAME tier's list, so a
// cheap tier can never be mapped to a dearer model. Changing this table is a code change, not a caller or env choice.
export const TRUSTED_MODELS = Object.freeze({
  haiku: Object.freeze(['haiku', 'claude-haiku-5-5']),
  sonnet: Object.freeze(['sonnet', 'claude-sonnet-5-5']),
  opus: Object.freeze(['opus', 'claude-opus-5-5']),
  fable: Object.freeze(['fable', 'claude-fable-5-2']),
});

function trustedModels(overrides) {
  if (overrides === undefined || overrides === null) return DEFAULT_MODELS;
  if (typeof overrides !== 'object' || Array.isArray(overrides)) throw new TypeError('model mapping must be an object');
  const out = { ...DEFAULT_MODELS };
  for (const [tierName, model] of Object.entries(overrides)) {
    if (!Object.hasOwn(TRUSTED_MODELS, tierName) || typeof model !== 'string' || !TRUSTED_MODELS[tierName].includes(model)) {
      throw new TypeError('model mapping must stay inside the trusted table for its tier');
    }
    out[tierName] = model;
  }
  return out;
}

const HAIKU_TRIGGERS = Object.freeze({ schema_failed_twice: 'sonnet' });

// step -> default tier and { trigger name: tier } (plan 2026-11-12-code-built-shorts-plan.md, section 4).
export const STEP_TIERS = Object.freeze({
  titles: Object.freeze({ default: 'haiku', triggers: HAIKU_TRIGGERS }),
  tags: Object.freeze({ default: 'haiku', triggers: HAIKU_TRIGGERS }),
  subtitle_text: Object.freeze({ default: 'haiku', triggers: HAIKU_TRIGGERS }),
  topic_dedup: Object.freeze({ default: 'haiku', triggers: HAIKU_TRIGGERS }),
  theme: Object.freeze({ default: 'sonnet', triggers: Object.freeze({}) }),
  script: Object.freeze({ default: 'sonnet', triggers: Object.freeze({ fact_check_rejected_twice: 'opus' }) }),
  // The shot list written after the voice is recorded (codebuilt/direction.js). Same tier as the script; never agy.
  direction: Object.freeze({ default: 'sonnet', triggers: Object.freeze({}) }),
  fact_check: Object.freeze({ default: 'sonnet', triggers: Object.freeze({ number_disagreement_after_round: 'opus' }) }),
  build: Object.freeze({
    default: 'sonnet',
    triggers: Object.freeze({ qa_failed_after_repair: 'opus', opus_failed: 'fable', unbuilt_kind_after_sonnet_failure: 'fable' }),
  }),
  review: Object.freeze({ default: 'sonnet', triggers: Object.freeze({}) }),
});

// KAN-930 (CB21): the light steps try agy first (cheapest tokens): Flash High, Flash Low, then Haiku, then Sonnet only on the
// schema_failed_twice trigger. agy models are a fixed table (a caller cannot name another one). agy never takes a script,
// a build or a build review: its build on the comparison brief was broken and its report said success. fact_check keeps its own rule.
export const LIGHT_STEPS = Object.freeze(new Set(['titles', 'tags', 'subtitle_text', 'topic_dedup']));
export const AGY_FORBIDDEN_STEPS = Object.freeze(new Set(['script', 'direction', 'build', 'review']));
export const AGY_LIGHT_MODELS = Object.freeze({ flash_high: 'gemini-3.8-flash-high', flash_low: 'gemini-3.8-flash-low' });
export const isLightStep = (step) => LIGHT_STEPS.has(step);

// Providers to try, in order, for one light-step call. A trigger (Sonnet) skips agy: agy already had its chance.
export function lightChain(pick) {
  if (!isLightStep(pick.step)) throw new TypeError(`Not a light step: ${pick.step}`);
  if (pick.escalated) return [{ provider: 'claude', tier: pick.tier, model: pick.model }];
  return [
    { provider: 'agy', tier: 'agy_flash_high', model: AGY_LIGHT_MODELS.flash_high },
    { provider: 'agy', tier: 'agy_flash_low', model: AGY_LIGHT_MODELS.flash_low },
    { provider: 'claude', tier: pick.tier, model: pick.model },
  ];
}

const COSTLY = new Set(['opus', 'fable']);
const isCount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Reported usage only; anything else is "unknown", not a guess.
function readUsage(reply) {
  const usage = reply && typeof reply === 'object' ? reply.usage : null;
  const input = usage?.input_tokens;
  const output = usage?.output_tokens;
  return isCount(input) && isCount(output) ? { input, output } : null;
}

const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

// Lock helpers. The lock file holds its owner's token. A lock older than staleLockMs (a crashed holder) is reclaimed by an
// atomic rename to a unique name, so only one process can win a given stale lock; the winner is confirmed from the moved
// file (same token and mtime we judged stale). If the rename caught a live lock instead, it is put back without overwriting.
export function reclaimStaleLock(lock, { staleLockMs = 30000, now = Date.now, beforeRename } = {}) {
  let seen;
  try {
    const stat = fs.statSync(lock);
    if (now() - stat.mtimeMs <= staleLockMs) return false;
    seen = { mtimeMs: stat.mtimeMs, token: fs.readFileSync(lock, 'utf8') };
  } catch { return false; }
  const moved = `${lock}.stale.${randomUUID()}`;
  if (typeof beforeRename === 'function') beforeRename();
  try { fs.renameSync(lock, moved); } catch { return false; }
  let won = false;
  try { won = fs.statSync(moved).mtimeMs === seen.mtimeMs && fs.readFileSync(moved, 'utf8') === seen.token; } catch { /* unreadable: not ours to call */ }
  if (!won) { try { fs.linkSync(moved, lock); } catch { /* lock was retaken: nothing to restore */ } }
  try { fs.unlinkSync(moved); } catch { /* gone */ }
  return won;
}

// Releases only a lock that still holds this caller's own token.
export function releaseLock(lock, token) {
  try {
    if (fs.readFileSync(lock, 'utf8') !== token) return false;
    fs.unlinkSync(lock);
    return true;
  } catch { return false; }
}

// Daily escalation counter kept in one small job-owned file ({ day, used }) so a restart or a second process cannot
// reset it. Each reservation runs under an exclusive lock file; any problem (unreadable or corrupt record, lock not
// obtained, write failure) answers "no room", so the caller stays on the default tier. Nothing here grows: one record.
export function createFileCapStore(file, { jobRoot, lockWaitMs = 2000, staleLockMs = 30000 } = {}) {
  const badPath = () => { throw new TypeError('cap record path must be inside job root'); };
  if (typeof file !== 'string' || !path.isAbsolute(file) || typeof jobRoot !== 'string' || !path.isAbsolute(jobRoot)) badPath();
  let root;
  try { root = fs.realpathSync(jobRoot); } catch { badPath(); }
  file = path.resolve(file);
  const validate = () => {
    const rel = path.relative(root, file);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) badPath();
    let current = root;
    for (const part of rel.split(path.sep)) {
      current = path.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) badPath(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  validate();
  const lock = `${file}.lock`;
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  function acquire(token) {
    const deadline = Date.now() + lockWaitMs;
    for (;;) {
      try {
        validate(); fs.mkdirSync(path.dirname(file), { recursive: true });
        const fd = fs.openSync(lock, 'wx');
        try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); }
        return true;
      } catch (error) {
        if (error.code !== 'EEXIST') { releaseLock(lock, token); return false; }
        if (reclaimStaleLock(lock, { staleLockMs })) continue;
        if (Date.now() >= deadline) return false;
        pause(10);
      }
    }
  }
  return {
    // true = one escalation reserved for `today`; false = cap reached or the record could not be trusted.
    reserve(today, cap) {
      if (typeof today !== 'string' || !Number.isInteger(cap) || cap <= 0) return false;
      const token = randomUUID();
      if (!acquire(token)) return false;
      let tmp;
      try {
        validate();
        let record = { day: today, used: 0 };
        if (fs.existsSync(file)) {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!parsed || typeof parsed.day !== 'string' || !Number.isInteger(parsed.used) || parsed.used < 0) return false;
          if (parsed.day === today) record = parsed;
        }
        if (record.used >= cap) return false;
        record.used += 1;
        tmp = `${file}.${randomUUID()}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(record), { flag: 'wx' });
        if (fs.readFileSync(lock, 'utf8') !== token) return false; // our lock was taken from us: do not write
        fs.renameSync(tmp, file);
        return true;
      } catch { return false; } finally {
        if (tmp) { try { fs.unlinkSync(tmp); } catch { /* renamed or absent */ } }
        releaseLock(lock, token);
      }
    },
  };
}

// Picks the model for one call. Costly tiers (opus, fable) need cap > 0 AND a cap store that reserves a slot;
// without a store the answer is the default tier, never an unmetered escalation.
// A forcedTier sets the tier directly without counting against the daily escalation cap and without further trigger escalation.
export function resolveStepTier(step, trigger, { capStore, dailyEscalationCap = 0, models = DEFAULT_MODELS, now = Date.now, forcedTier } = {}) {
  if (!Object.hasOwn(STEP_TIERS, step)) throw new TypeError(`Unknown step: ${step}`);
  if (!Number.isInteger(dailyEscalationCap) || dailyEscalationCap < 0) throw new TypeError('dailyEscalationCap must be a whole number, 0 or more');
  const resolvedModels = trustedModels(models);
  if (forcedTier !== undefined && forcedTier !== null) {
    if (!Object.hasOwn(TRUSTED_MODELS, forcedTier)) throw new TypeError(`Unknown forced tier: ${forcedTier}`);
    return { step, tier: forcedTier, model: resolvedModels[forcedTier], escalated: false, trigger: trigger ?? null, forced: true };
  }
  const config = STEP_TIERS[step];
  let tier = config.default;
  let escalated = false;
  let denied = null;
  if (trigger !== undefined && trigger !== null) {
    if (!Object.hasOwn(config.triggers, trigger)) throw new TypeError(`Trigger ${String(trigger)} is not named for step ${step}`);
    const target = config.triggers[trigger];
    if (COSTLY.has(target)) {
      if (dailyEscalationCap > 0 && capStore && capStore.reserve(dayKey(now()), dailyEscalationCap) === true) { tier = target; escalated = true; } else denied = 'cap';
    } else { tier = target; escalated = true; }
  }
  return { step, tier, model: resolvedModels[tier], escalated, trigger: trigger ?? null, ...(denied ? { escalation_denied: denied } : {}) };
}

export const usageOf = readUsage;

export function createStepRouter({ askFn, onCallRecord, dailyEscalationCap = 0, capStore, models = DEFAULT_MODELS, now = Date.now, forcedTier, forcedStepTiers } = {}) {
  if (typeof askFn !== 'function') throw new TypeError('askFn is required');
  if (!Number.isInteger(dailyEscalationCap) || dailyEscalationCap < 0) throw new TypeError('dailyEscalationCap must be a whole number, 0 or more');

  async function ask(step, instruction, { trigger, forcedTier: callForcedTier } = {}) {
    const effectiveForced = callForcedTier ?? forcedStepTiers?.[step] ?? (step === 'build' ? forcedTier : undefined);
    const pick = resolveStepTier(step, trigger, { capStore, dailyEscalationCap, models, now, forcedTier: effectiveForced });
    const started = now();
    const record = (status, reply, error) => {
      const entry = { ...pick, started_at: new Date(started).toISOString(), wall_s: (now() - started) / 1000, tokens: readUsage(reply), status, ...(error ? { error: error.message } : {}) };
      try { if (typeof onCallRecord === 'function') onCallRecord(entry); } catch { /* a recorder failure must not break the call */ }
      return entry;
    };
    let reply;
    try {
      reply = await askFn(instruction, { model: pick.model });
    } catch (error) {
      record('error', null, error);
      throw error;
    }
    const answer = reply && typeof reply === 'object' && 'text' in reply ? reply.text : reply;
    return { answer, record: record('ok', reply) };
  }

  return { ask };
}
