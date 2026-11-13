import { broadcastEvent } from './runs.js';
import { getAgyEmail, askAgy, recordAgyQuota, clearAgyQuota, getAgyStatus } from './antigravityCli.js';
import { askAgyVision, agyVisionEnabled } from './agyVision.js';
import { askClaude, claudeEnabled, claudeBlocked } from './claudeCli.js';
import { callRecorder } from '../perf/stageTimings.js';
import { sleep } from '../lib/objects.js';

const log = (level, message) => broadcastEvent('log', { level, source: 'GEMINI', message });

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const GEMINI_FALLBACK_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
];

// Starting models for lighter jobs. Each has its own quota, so these jobs never use up the best model's
// (scripts). They still fall down the chain from here, never up.
export const GEMINI_MID_MODEL = process.env.GEMINI_MID_MODEL || 'gemini-3.6-flash';
export const GEMINI_LITE_MODEL = process.env.GEMINI_LITE_MODEL || 'gemini-3.5-flash-lite';

export function getGeminiApiKeys() {
  const raw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  return raw
    .split(/[,;\n\r]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

let activeKeyIndex = 0;

export function getActiveKeyIndex() {
  return activeKeyIndex;
}

export function resetActiveKeyIndex() {
  activeKeyIndex = 0;
}

export function maskKey(k) {
  if (!k || typeof k !== 'string') return '****';
  if (k.length <= 8) return '****';
  return `${k.slice(0, 4)}...${k.slice(-4)}`;
}

// Prompts hold the whole creative brief (topic, script, channel rules): the debug line carries the length and the
// opening only, because every log line also reaches the log drawer.
export function maskPrompt(text, max = 80) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}... [${flat.length - max} more chars not logged]` : flat;
}

export function isQuotaExceeded(err) {
  if (!err) return false;
  if (err.status === 429) return true;
  const msg = String(err.message || '');
  return /429|quota|rate limit|resource has been exhausted/i.test(msg);
}

// Models whose quota is used up on every key -> when to try them again. Skipped by askGemini until then.
const quotaBlockedUntil = new Map();
export const resetQuotaBlocks = () => quotaBlockedUntil.clear();

// ponytail: ignores the hour shift on DST-change days; a cooldown an hour off is harmless.
export function msUntilPacificMidnight(now = Date.now()) {
  const pt = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  return 86400000 - ((pt.getHours() * 60 + pt.getMinutes()) * 60 + pt.getSeconds()) * 1000;
}

// Google's 429 says how long to wait (RetryInfo, daily limits included). Without it: daily quotas reset
// at midnight Pacific, anything else gets 60s.
export function quotaCooldownMs(err, now = Date.now()) {
  const details = Array.isArray(err?.details) ? err.details : [];
  const secs = parseFloat(details.find((d) => d?.retryDelay)?.retryDelay);
  if (Number.isFinite(secs)) return secs * 1000;
  if (details.some((d) => d?.violations?.some((v) => /PerDay/i.test(v?.quotaId || '')))) return msUntilPacificMidnight(now);
  return 60000;
}

// A model name is one URL path segment of the Gemini endpoint: anything else (slashes, ?, :, %) would steer the API-key request.
const SAFE_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function getFallbackModels(startModel) {
  if (startModel && !SAFE_MODEL_NAME.test(String(startModel))) startModel = undefined;
  const base = process.env.GEMINI_FALLBACK_MODELS
    ? process.env.GEMINI_FALLBACK_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
    : GEMINI_FALLBACK_MODELS;

  // The list is strictly ordered, best first. If an external custom model (not in base and not the obsolete 3.5 default) is passed, prepend it.
  if (startModel && !base.includes(startModel) && startModel !== 'gemini-3.5-flash') {
    return [startModel, ...base];
  }
  // If a standard fallback model is explicitly requested as the starting point, start from it down the chain
  if (startModel && base.includes(startModel) && startModel !== 'gemini-3.5-flash' && startModel !== DEFAULT_GEMINI_MODEL) {
    const idx = base.indexOf(startModel);
    return base.slice(idx);
  }
  return [...base];
}

// Fallback event listeners & last fallback record for UI status
let lastGeminiFallback = null;
const fallbackListeners = new Set();

export function onGeminiFallback(listener) {
  fallbackListeners.add(listener);
  return () => fallbackListeners.delete(listener);
}

export function getLastGeminiFallback() {
  return lastGeminiFallback;
}

export function clearLastGeminiFallback() {
  lastGeminiFallback = null;
}

export function notifyGeminiFallback(info) {
  lastGeminiFallback = {
    ...info,
    timestamp: new Date().toISOString(),
  };
  for (const fn of fallbackListeners) {
    try {
      fn(lastGeminiFallback);
    } catch (e) {
      console.error('Error in fallback listener:', e);
    }
  }
}

// Real answers are ~400-800 tokens for summaries, but full multi-scene video plans can reach 2000-3000 tokens.
// Setting 4096 prevents truncated responses causing JSON parse errors.
export const MAX_OUTPUT_TOKENS = 4096;
const TIMEOUT_MS = 60000;
const ATTEMPTS = 2;
const RETRY_DELAY_MS = 1500;
export const DEFAULT_HIGH_DEMAND_MAX_RETRIES = 3;
export const DEFAULT_HIGH_DEMAND_BASE_DELAY_MS = 1500;

export function isHighDemand(err) {
  if (!err) return false;
  if (err.status >= 400 && err.status < 500) return false;
  const msg = String(err.message || '');
  if (/HTTP\s+4\d\d/i.test(msg)) return false;
  if (err.status === 503) return true;
  return msg.includes('503') || /high demand/i.test(msg) || /overloaded/i.test(msg);
}

// Returns the first complete {...} object in the text, ignoring anything after it.
// Handles prose around grounded answers and the runaway case where a valid object is followed by endless "}\n".
export function extractJson(text = '') {
  let start = -1;
  let depth = 0;
  let inStr = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      if (inStr) escape = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;

    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }
  throw new Error('Gemini returned an incomplete JSON object');
}

async function callGemini(key, instruction, search, maxTokens, model, images, timeoutMs = TIMEOUT_MS) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [...images.map((i) => ({ inline_data: { mime_type: i.mime, data: i.data } })), { text: instruction }] }],
        generationConfig: search
          ? { maxOutputTokens: maxTokens }
          : { response_mime_type: 'application/json', maxOutputTokens: maxTokens },
        tools: search ? [{ google_search: {} }] : undefined,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    }
  ).catch((err) => {
    // undici only says "fetch failed"; the useful part (ECONNRESET, ETIMEDOUT, ENOTFOUND...) is in err.cause
    throw new Error(`Couldn't reach Gemini (${err.cause?.code || err.cause?.message || err.message})`);
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = body?.error?.message?.split('.')[0] || res.statusText || 'request failed';
    throw Object.assign(new Error(`Gemini HTTP ${res.status}: ${message}`), { status: res.status, details: body?.error?.details });
  }

  const data = await res.json();
  // Grounded (search) answers can come back split over several parts.
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error('Gemini returned an empty response');
  const response = extractJson(text);
  if (search) {
    const grounding = data?.candidates?.[0]?.groundingMetadata;
    // Retain the source-linked generated summaries that JSON extraction used
    // to discard. These are grounding summaries, not fetched verbatim quotes.
    delete response._grounding; // never trust model-authored metadata in the JSON
    delete response._agy;
    const sources = (Array.isArray(grounding?.groundingSupports) ? grounding.groundingSupports : []).slice(0, 100).flatMap((support) =>
      (Array.isArray(support?.groundingChunkIndices) ? support.groundingChunkIndices : []).slice(0, 20).flatMap((index) => {
        const web = grounding?.groundingChunks?.[index]?.web;
        return typeof web?.uri === 'string' && typeof web?.title === 'string' && typeof support?.segment?.text === 'string'
          ? [{ url: web.uri.slice(0, 4096), title: web.title.slice(0, 300), passage: support.segment.text.slice(0, 12000) }] : [];
      }));
    if (sources.length) response._grounding = sources.slice(0, 200);
  }
  return response;
}

// Antigravity CLI quota used up or refused -> when to try it again. ponytail: flat 30 min, agy's errors have no reset time we parse.
let agyBlockedUntil = 0;
export const resetAgyBlock = () => { agyBlockedUntil = 0; };
// KAN-539: PLANNER_DEADLINE_MS unset/invalid = no deadline (today's behaviour). Set = bounds one askGemini call end to end.
const envMs = (name) => { const n = Number(process.env[name]); return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(n) && n > 0 ? n : undefined; };
export const DEFAULT_PLANNER_MAX_MODELS = 2;
export const DEFAULT_PLANNER_AGY_CAP_MS = 120000;

export const isAgyBlocked = () => Date.now() <= agyBlockedUntil;

// KAN-848 opt-in, default off so kids and merch keep today's output: GEMINI_CLI_ONLY=1 (or cliOnly: true) means Claude CLI,
// then agy (search_web for search, agy vision for images), and nothing else: no API key is read and no API call is made.
export const geminiCliOnly = () => /^(1|true|yes|on)$/i.test(String(process.env.GEMINI_CLI_ONLY || '').trim());

// search: true lets agy use its search_web tool; on the API it enables Google Search grounding (JSON mode is not
// allowed together with tools).
// apiFallback: false makes agy failures throw instead of switching to the Gemini API.
// maxTokens: raise for big plans (multi-scene scripts); defaults to MAX_OUTPUT_TOKENS (4096).
// Retries on timeout/incomplete JSON/5xx. 429: switch to the next API key; once every key is out of quota on a
// model, block that model until its quota resets and fall to the next one.
// Falls down GEMINI_FALLBACK_MODELS on HTTP 503 high demand errors or persistent incomplete JSON.
async function askGeminiCore(instruction, {
  search = false,
  apiFallback = true,
  cliOnly = geminiCliOnly(),
  requireGrounding = false,
  maxTokens = MAX_OUTPUT_TOKENS,
  model,
  images = [],
  askAgyFn = askAgy,
  askAgyVisionFn = askAgyVision,
  askClaudeFn = askClaude,
  claudeOn = claudeEnabled,
  agyVision = agyVisionEnabled(),
  maxHighDemandRetries = (process.env.GEMINI_503_MAX_RETRIES !== undefined && !Number.isNaN(Number(process.env.GEMINI_503_MAX_RETRIES)))
    ? Number(process.env.GEMINI_503_MAX_RETRIES)
    : DEFAULT_HIGH_DEMAND_MAX_RETRIES,
  highDemandBaseDelayMs = (process.env.GEMINI_503_RETRY_DELAY_MS !== undefined && !Number.isNaN(Number(process.env.GEMINI_503_RETRY_DELAY_MS)))
    ? Number(process.env.GEMINI_503_RETRY_DELAY_MS)
    : DEFAULT_HIGH_DEMAND_BASE_DELAY_MS,
  highDemandJitter = true,
  sleepFn = (ms) => sleep(ms),
  deadlineMs = envMs('PLANNER_DEADLINE_MS'),
  maxModels = envMs('PLANNER_MAX_MODELS') ?? DEFAULT_PLANNER_MAX_MODELS,
  agyCapMs = envMs('PLANNER_AGY_CAP_MS') ?? DEFAULT_PLANNER_AGY_CAP_MS,
} = {}, rec = null) {
  const t0 = Date.now();
  if (cliOnly) apiFallback = false; // KAN-848: CLI-only mode never reaches the Gemini API or reads its keys
  const remaining = () => deadlineMs - (Date.now() - t0);
  const deadlineError = () => {
    if (rec) rec.fallback_reason = 'deadline';
    log('warn', `Planner deadline of ${Math.round(deadlineMs / 1000)}s reached; giving up on Gemini.`);
    return Object.assign(new Error(`Gemini planner deadline of ${Math.round(deadlineMs / 1000)}s reached`), { deadline: true, deadlineMs });
  };
  // Claude CLI first when the Claude panel switched it on: plain prompt-to-JSON calls only (plans, corrections, model code).
  // Search needs agy's search_web and images need agy vision or the API, so those skip this. Any Claude failure falls through to agy.
  if (!search && !requireGrounding && !images.length && claudeOn() && !claudeBlocked()) {
    try {
      if (rec) { rec.provider = 'claude'; rec.attempts++; }
      log('debug', `Calling Claude CLI (${instruction.length} chars): ${maskPrompt(instruction)}`);
      const started = Date.now();
      const response = extractJson(await askClaudeFn(instruction, deadlineMs ? { timeoutMs: Math.max(1, Math.min(remaining(), envMs('PLANNER_CLAUDE_CAP_MS') ?? 300000)) } : {}));
      log('info', `Generated with Claude CLI in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
      return response;
    } catch (err) {
      if (deadlineMs && remaining() <= 0) throw deadlineError();
      if (rec) { rec.fell_back_from = 'claude'; rec.fallback_reason = err.timedOut ? 'timeout' : err.quota ? 'quota' : err.unavailable ? 'unavailable' : 'error'; }
      log('warn', `Claude CLI failed, using the next provider: ${err.message}`);
    }
  }
  // Main path: Antigravity CLI on the dashboard's Google account, search requests included. The API only stands in
  // when agy can't be used (not set up, wrong account, not installed, quota, account refused), times out or returns
  // malformed JSON; any other agy failure (e.g. an empty answer) is thrown. Without an API key those two are thrown too.
  // Images (vision checks) go through agy only behind the AGY_VISION flag (agy opens image files from its workspace),
  // and only when agy is ready; otherwise they use the API as before.
  const visionViaAgy = images.length > 0 && agyVision && !search && getAgyStatus().ready;
  if (!apiFallback && (requireGrounding || (images.length && !visionViaAgy) || !getAgyEmail() || Date.now() <= agyBlockedUntil)) {
    throw Object.assign(new Error('Antigravity CLI unavailable for this request; API fallback is disabled.'), { unavailable: true });
  }
  // KAN-417 rec: when set (a recorder asked), what really happened is noted on it; null = no change at all.
  if (rec && !requireGrounding && (!images.length || visionViaAgy) && getAgyEmail() && Date.now() <= agyBlockedUntil) {
    rec.fell_back_from = images.length ? 'agy_vision' : 'agy';
    rec.fallback_reason = 'blocked_window';
  }
  if (!requireGrounding && (!images.length || visionViaAgy) && getAgyEmail() && Date.now() > agyBlockedUntil) {
    try {
      if (rec) { rec.provider = images.length ? 'agy_vision' : 'agy'; rec.attempts++; }
      log('debug', `Calling Antigravity CLI${search ? ' with web search' : ''}${images.length ? ` with ${images.length} image(s)` : ''} (${instruction.length} chars): ${maskPrompt(instruction)}`);
      const started = Date.now();
      const response = extractJson(await (images.length ? askAgyVisionFn(instruction, images, {}) : askAgyFn(instruction, deadlineMs ? { search, timeoutMs: Math.max(1, Math.min(remaining(), agyCapMs)) } : { search })));
      if (search) { delete response._grounding; response._agy = true; } // answer JSON is not independent tool metadata; _agy is set here, never by the model
      log('info', `Generated with Antigravity CLI${search ? ' + web search' : ''} (${getAgyEmail()}) in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
      return response;
    } catch (err) {
      // Quota, or Google refusing the account: don't pay agy's startup on every call until it might work again.
      if (deadlineMs && remaining() <= 0) throw deadlineError();
      const isTimeout = Boolean(err.timedOut || /timed out/i.test(err.message));
      const quota = isQuotaExceeded(err);
      const blocked = quota || /IneligibleTier|no longer supported|not logged in/i.test(err.message);
      if (blocked) agyBlockedUntil = Date.now() + 30 * 60000;
      // Malformed JSON from agy: the API path retries that, so hand over instead of failing the run.
      const badJson = err instanceof SyntaxError || err.badEnvelope || /incomplete JSON/i.test(err.message);
      if (!blocked && !err.unavailable && !isTimeout && !badJson) throw err;
      if (!apiFallback) throw err;
      // Nothing to hand over to: surface agy's own error instead of the endpoint's "no key" 503.
      if ((isTimeout || badJson) && getGeminiApiKeys().length === 0) throw err;
      if (rec) { rec.fell_back_from = rec.provider; rec.fallback_reason = isTimeout ? 'timeout' : badJson ? 'bad_json' : quota ? 'quota' : 'unavailable'; }
      log('warn', isTimeout
        ? `Antigravity CLI timed out, using the API instead: ${err.message}`
        : badJson
          ? `Antigravity CLI returned malformed JSON, using the API instead: ${err.message}`
          : `Antigravity CLI unavailable, using the API instead: ${err.message}`);
    }
  }

  if (cliOnly) throw Object.assign(new Error('Claude and Antigravity CLIs unavailable; Gemini API is disabled (GEMINI_CLI_ONLY).'), { unavailable: true });
  const keys = getGeminiApiKeys();
  if (keys.length === 0) return null;

  const candidateModels = deadlineMs ? getFallbackModels(model).slice(0, maxModels) : getFallbackModels(model);
  let modelIndex = 0;
  let currentModel = candidateModels[modelIndex];

  let keysTried = 0;
  let highDemandAttempt = 0;

  for (let attempt = 1; ; attempt++) {
    if (deadlineMs && remaining() <= 0) throw deadlineError();
    // Skip models whose quota is used up; when none are left, fail fast without calling Gemini.
    while ((quotaBlockedUntil.get(currentModel) || 0) > Date.now()) {
      if (modelIndex >= candidateModels.length - 1) {
        const mins = Math.ceil((quotaBlockedUntil.get(currentModel) - Date.now()) / 60000);
        throw Object.assign(new Error(`Gemini HTTP 429: quota used up on every model (next reset in ~${mins} min)`), { status: 429 });
      }
      currentModel = candidateModels[++modelIndex];
      attempt = 1;
      keysTried = 0;
      if (rec) rec.blocked_skips++;
    }
    const currentKey = keys[activeKeyIndex % keys.length];
    try {
      const keyLabel = keys.length > 1 ? ` (key #${(activeKeyIndex % keys.length) + 1}/${keys.length} ${maskKey(currentKey)})` : '';
      log('debug', `Calling ${currentModel}${search ? ' with Google Search' : ''}${keyLabel} (${instruction.length} chars, attempt ${attempt}): ${maskPrompt(instruction)}`);
      const started = Date.now();
      if (rec) { rec.provider = 'gemini_api'; rec.model = currentModel; rec.attempts++; }
      const response = await callGemini(currentKey, instruction, search, maxTokens, currentModel, images, deadlineMs ? Math.max(1, Math.min(TIMEOUT_MS, remaining())) : TIMEOUT_MS);
      log('info', `Generated with Gemini API (${currentModel}, key #${(activeKeyIndex % keys.length) + 1}) in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
      if (modelIndex > 0 && response && typeof response === 'object') {
        response._gemini_model_used = currentModel;
        response._gemini_fallback = true;
      }
      return response;
    } catch (err) {
      if (deadlineMs && remaining() <= 0) throw deadlineError();
      // Next model down the chain; the drawer and banner get it from the fallback listener in app.js.
      const fallDown = (why) => {
        const fromModel = currentModel;
        currentModel = candidateModels[++modelIndex];
        keysTried = 0; // a new model gets every key again
        attempt = 0;
        const message = `${why}; falling back to ${currentModel}`;
        console.log(message); // docker logs
        notifyGeminiFallback({ from_model: fromModel, to_model: currentModel, error: err.message, message });
      };

      if (isQuotaExceeded(err) && keys.length > 1 && keysTried < keys.length - 1) {
        const fromKeyIdx = activeKeyIndex % keys.length;
        activeKeyIndex = (activeKeyIndex + 1) % keys.length;
        keysTried++;
        if (rec) rec.key_switches++;
        const toKeyIdx = activeKeyIndex % keys.length;
        const fallbackMsg = `Gemini quota exceeded (429) on key #${fromKeyIdx + 1} (${maskKey(keys[fromKeyIdx])}); switching to key #${toKeyIdx + 1} (${maskKey(keys[toKeyIdx])})`;
        console.log(fallbackMsg); // docker logs; the drawer gets it from the fallback listener in app.js
        notifyGeminiFallback({
          from_key: fromKeyIdx + 1,
          to_key: toKeyIdx + 1,
          from_key_masked: maskKey(keys[fromKeyIdx]),
          to_key_masked: maskKey(keys[toKeyIdx]),
          error: err.message,
          message: fallbackMsg,
        });
        attempt = 0;
        continue;
      }

      // Every key is out of quota on this model: block it and move down the chain (the loop top does the move).
      if (isQuotaExceeded(err)) {
        // 1s floor: a retryDelay of "0s" would re-call the same model in a tight loop.
        quotaBlockedUntil.set(currentModel, Date.now() + Math.max(quotaCooldownMs(err), 1000));
        const msg = `Gemini quota used up on ${currentModel} for every key; skipping it until it resets.`;
        console.log(msg);
        log('warn', msg);
        keysTried = 0;
        attempt = 0;
        continue;
      }

      // Explicit 4xx client errors (400, 401, 403, 404...) are non-retryable and must throw immediately.
      if (err.status >= 400 && err.status < 500) {
        log('error', `${currentModel} failed (attempt ${attempt}/${ATTEMPTS}, not retrying): ${err.message}`);
        throw err;
      }

      const lowerModelLeft = modelIndex < candidateModels.length - 1;
      if (isHighDemand(err)) {
        if (lowerModelLeft) {
          if (rec) rec.http_503_retries++;
          fallDown(`Gemini HTTP 503: high demand on ${currentModel}`);
          continue;
        }

        if (highDemandAttempt < maxHighDemandRetries) {
          highDemandAttempt++;
          if (rec) rec.http_503_retries++;
          const base = highDemandBaseDelayMs * Math.pow(2, highDemandAttempt - 1);
          const jitter = highDemandJitter ? Math.floor(Math.random() * Math.min(500, Math.floor(base * 0.2) + 1)) : 0;
          const delay = Math.round(base + jitter);
          const warnMsg = `[gemini] All models busy (503). Retrying in ${delay}ms (attempt ${highDemandAttempt}/${maxHighDemandRetries})...`;
          console.warn(warnMsg);
          log('warn', warnMsg);
          await sleepFn(deadlineMs ? Math.max(0, Math.min(delay, remaining())) : delay);
          modelIndex = 0;
          currentModel = candidateModels[modelIndex];
          keysTried = 0;
          attempt = 0;
          continue;
        }

        log('error', `[gemini] All models busy (503). Max retries exhausted (${maxHighDemandRetries}/${maxHighDemandRetries}): ${err.message}`);
        throw err;
      }
      if (err.status < 500 || attempt >= ATTEMPTS) {
        if (/incomplete JSON|empty response|timeout/i.test(err.message) && lowerModelLeft) {
          fallDown(`Gemini ${currentModel} output issue (${err.message})`);
          continue;
        }

        log('error', `${currentModel} failed (attempt ${attempt}/${ATTEMPTS}, not retrying): ${err.message}`);
        throw err;
      }
      log('warn', `${currentModel} attempt ${attempt}/${ATTEMPTS} failed, retrying in ${RETRY_DELAY_MS / 1000}s: ${err.message}`);
      await sleep(deadlineMs ? Math.max(0, Math.min(RETRY_DELAY_MS, remaining())) : RETRY_DELAY_MS);
    }
  }
}

// Public entry. With a recorder (opts.onCallRecord, or the one a timed call set up in perf/stageTimings.js) it
// reports one record per call: {provider (agy | agy_vision | gemini_api | null), model, started_at, wall_s,
// attempts (provider calls made), key_switches (429), http_503_retries, fell_back_from (agy | agy_vision | null),
// fallback_reason (quota | timeout | bad_json | unavailable | blocked_window | deadline), blocked_skips (models skipped
// because their quota window is blocked), status (ok | error)}. Without one this is askGeminiCore, unchanged.
export async function askGemini(instruction, opts = {}) {
  const sink = opts.onCallRecord || callRecorder.getStore();
  if (typeof sink !== 'function') return askGeminiCore(instruction, opts);
  const t0 = Date.now();
  const rec = { provider: null, model: null, started_at: new Date(t0).toISOString(), wall_s: null, attempts: 0, key_switches: 0, http_503_retries: 0, fell_back_from: null, fallback_reason: null, blocked_skips: 0, status: 'error' };
  try {
    const result = await askGeminiCore(instruction, opts, rec);
    rec.status = 'ok';
    return result;
  } finally {
    rec.wall_s = Math.round(Date.now() - t0) / 1000;
    try { sink(rec); } catch { /* a recorder must never break the call */ }
  }
}
