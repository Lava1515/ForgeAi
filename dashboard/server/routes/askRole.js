import { askAgy } from './antigravityCli.js';
import { askAgyVision } from './agyVision.js';
import { askClaude } from './claudeCli.js';
import { resolveStepTier, usageOf, isLightStep, lightChain, AGY_FORBIDDEN_STEPS } from './stepTiers.js';
import { callRecorder } from '../perf/stageTimings.js';

const FALLBACK_ORDER = Object.freeze({
  planner: ['agy', 'claude'],
  writer: ['claude', 'agy'],
  checker: ['agy', 'claude'],
  image_review: ['agy_vision'],
});

const MAX_JSON_SCAN = 1024 * 1024;

function extractBalancedJson(text) {
  const limit = Math.min(text.length, MAX_JSON_SCAN);
  for (let start = 0; start < limit; start++) {
    const first = text[start];
    if (first !== '{' && first !== '[') continue;
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < limit; index++) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        const opening = stack.pop();
        if ((char === '}' && opening !== '{') || (char === ']' && opening !== '[')) break;
        if (!stack.length) return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

const parseAnswer = (answer) => {
  if (answer && typeof answer === 'object') return answer;
  const text = String(answer ?? '').trim();
  let originalError;
  try { return JSON.parse(text); } catch (error) { originalError = error; }
  const fenced = text.match(/```(?:[^\s`]*)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced !== undefined) {
    try { return JSON.parse(fenced); } catch { /* Try prose extraction below. */ }
  }
  const extracted = extractBalancedJson(text);
  if (extracted !== null) return JSON.parse(extracted);
  throw originalError;
};

const QUOTA_PATTERNS = Object.freeze([
  /resource has been exhausted/i,
  /resource_exhausted/i,
  /quota/i,
  /rate limit/i,
  /too many requests/i,
  /\b429\b/i,
  /overloaded/i,
  /temporarily unavailable/i,
  /try again later/i,
  /usage limit/i,
]);
const UNAVAILABLE_PATTERNS = Object.freeze([/service unavailable/i, /provider unavailable/i]);

function fallbackReason(error) {
  const messages = [error?.message, error?.stderr, error?.stdout]
    .filter((value) => typeof value === 'string');
  if (messages.some((message) => /no capacity/i.test(message))) return 'no_capacity';
  if (error?.unavailable === true || error?.quota) return 'unavailable';
  if (messages.some((message) => UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(message)))) return 'unavailable';
  if (messages.some((message) => QUOTA_PATTERNS.some((pattern) => pattern.test(message)))) return 'quota';
  return null;
}

const VISION_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// Only a typed "agy has no capacity" signal may turn a vision review into a skip. Parse, payload, timeout and
// envelope errors carry no such type and must surface as failures.
export function isNoCapacity(error) {
  return error?.noCapacity === true || error?.code === 'NO_CAPACITY' || error?.unavailable === true || Boolean(error?.quota);
}

// agyVision wants [{ mime, data(base64) }]; a bad payload is a caller bug, not a reason to skip.
function validateVisionImages(images) {
  images.forEach((image, index) => {
    if (!image || typeof image !== 'object' || !VISION_MIMES.has(image.mime) || typeof image.data !== 'string' || !image.data || image.data.length % 4 !== 0 || !BASE64.test(image.data)) {
      throw new TypeError(`image_review image ${index + 1} must be { mime, data } with a supported mime and base64 data`);
    }
  });
}

function validate(role, id) {
  if (!Object.hasOwn(FALLBACK_ORDER, role) || role.includes('..') || (id !== undefined && (typeof id !== 'string' || id.includes('..') || id.length > 64))) {
    throw new TypeError('Invalid role or id');
  }
}

// KAN-930 light steps: walk lightChain(pick). An agy provider error (no capacity, quota, timeout, bad envelope) is a provider
// failure: recorded, then the next model runs at once; it is not a step failure and not an escalation. An answer that fails
// the caller's schema check is never used from any model; agy and Haiku move on, the last model raises SCHEMA_INVALID so
// the caller can count it toward the schema_failed_twice trigger. A Claude provider error is thrown as is.
async function askLightStep({ role, instruction, pick, validateAnswer, askAgyFn, askClaudeFn, sink }) {
  const chain = lightChain(pick);
  const failed = (parsed) => { try { return !validateAnswer(parsed); } catch { return true; } };
  let fallbackFrom = null;
  for (const [index, step] of chain.entries()) {
    const started = Date.now();
    let tokens = null;
    const record = (status, error = null, providerFailure = false) => {
      if (typeof sink !== 'function') return;
      try {
        sink({ role, provider: step.provider, model: step.model, step: pick.step, tier: step.tier, escalated: pick.escalated, trigger: pick.trigger,
          tokens, started_at: new Date(started).toISOString(), wall_s: (Date.now() - started) / 1000,
          attempts: 1, retries: 0, extra_calls: index > 0 ? 1 : 0,
          fallback_order: chain.map((entry) => entry.provider), fell_back_from: fallbackFrom?.provider ?? null,
          fallback_reason: fallbackFrom?.reason ?? null, blocked_skips: 0, status,
          ...(providerFailure ? { provider_failure: true } : {}), ...(error ? { error: error.message } : {}) });
      } catch { /* recorder failures must not break a role call */ }
    };
    let reply;
    try {
      reply = await (step.provider === 'agy' ? askAgyFn(instruction, { search: false, model: step.model }) : askClaudeFn(instruction, { model: step.model, structured: true }));
    } catch (error) {
      record('provider_failure', error, true);
      if (step.provider === 'agy') { fallbackFrom = { provider: step.provider, reason: fallbackReason(error) ?? 'error' }; continue; }
      throw error;
    }
    tokens = usageOf(reply);
    const raw = reply && typeof reply === 'object' && 'text' in reply ? reply.text : reply;
    let parsed;
    let bad = false;
    try { parsed = parseAnswer(raw); } catch { bad = true; }
    if (bad || failed(parsed)) {
      const error = Object.assign(new Error(`${step.model} answer failed the schema check for ${pick.step}`), { code: 'SCHEMA_INVALID' });
      record('schema_failed', error);
      if (index === chain.length - 1) throw error;
      fallbackFrom = { provider: step.provider, reason: 'schema_failed' };
      continue;
    }
    record('ok');
    return parsed;
  }
  throw new Error(`No model answered step ${pick.step}`);
}

// Library function; this module is not wired to a route yet.
export async function askRole(role, instruction, {
  id,
  images = [],
  askAgyFn = askAgy,
  askAgyVisionFn = askAgyVision,
  askClaudeFn = askClaude,
  onCallRecord,
  step,
  trigger,
  capStore,
  dailyEscalationCap = 0,
  models,
  validate: validateAnswer,
} = {}) {
  validate(role, id);
  // CB9 tiering (optional): step picks the Claude model for this call; trigger names an escalation; the daily cap lives in
  // capStore (createFileCapStore). Without step the call is the legacy plain-text call.
  const pick = step === undefined ? null : resolveStepTier(step, trigger, { capStore, dailyEscalationCap, ...(models ? { models } : {}) });
  if (role === 'image_review' && !Array.isArray(images)) throw new TypeError('images must be an array');
  const sink = onCallRecord || callRecorder.getStore();
  // KAN-930: a script, build or build review never goes to agy, whatever the role's usual fallback says.
  const order = pick && AGY_FORBIDDEN_STEPS.has(pick.step) ? FALLBACK_ORDER[role].filter((provider) => !provider.startsWith('agy')) : FALLBACK_ORDER[role];
  if (!order.length) throw new TypeError(`Step ${pick.step} cannot run for role ${role}: agy is not allowed for it`);
  if (pick && isLightStep(pick.step)) {
    if (role === 'image_review') throw new TypeError('A light step cannot be an image_review call');
    if (typeof validateAnswer !== 'function') throw new TypeError('A light step needs a validate function (the schema check)');
    return askLightStep({ role, instruction, pick, validateAnswer, askAgyFn, askClaudeFn, sink });
  }
  let fallbackFrom = null;
  const record = (provider, status, started, error = null, tokens = null) => {
    if (typeof sink !== 'function') return;
    const tiered = provider === 'claude' && pick;
    try {
      sink({ role, provider, model: tiered ? pick.model : null,
        ...(pick ? { step: pick.step, tier: pick.tier, escalated: pick.escalated, trigger: pick.trigger, ...(pick.escalation_denied ? { escalation_denied: pick.escalation_denied } : {}), tokens: tiered ? tokens : null } : {}), started_at: new Date(started).toISOString(), wall_s: (Date.now() - started) / 1000,
        // A later provider is an extra call, not a retry of the first provider.
        attempts: 1, retries: 0, extra_calls: fallbackFrom ? 1 : 0,
        fallback_order: [...order], fell_back_from: fallbackFrom?.provider ?? null,
        fallback_reason: fallbackFrom?.reason ?? null, blocked_skips: 0, status, ...(error ? { error: error.message } : {}) });
    } catch { /* recorder failures must not break a role call */ }
  };

  for (const provider of order) {
    const started = Date.now();
    try {
      if (provider === 'agy_vision') {
        if (!images?.length) {
          record(provider, 'skipped', started);
          return { status: 'skipped' };
        }
        validateVisionImages(images);
        const result = parseAnswer(await askAgyVisionFn(instruction, images, {}));
        record(provider, 'ok', started);
        return result;
      }
      const tiered = provider === 'claude' && pick;
      const reply = await (provider === 'agy' ? askAgyFn(instruction, { search: false }) : askClaudeFn(instruction, tiered ? { model: pick.model, structured: true } : {}));
      const raw = tiered && reply && typeof reply === 'object' && 'text' in reply ? reply.text : reply;
      const result = parseAnswer(raw);
      record(provider, 'ok', started, null, tiered ? usageOf(reply) : null);
      return result;
    } catch (error) {
      const skipped = provider === 'agy_vision' && isNoCapacity(error);
      record(provider, skipped ? 'skipped' : 'error', started, error);
      if (provider === 'agy_vision') {
        if (skipped) return { status: 'skipped' };
        throw error;
      }
      const reason = fallbackReason(error);
      if (!reason || provider === order.at(-1)) throw error;
      fallbackFrom = { provider, reason };
    }
  }
  return { status: 'skipped' };
}

export { FALLBACK_ORDER };
