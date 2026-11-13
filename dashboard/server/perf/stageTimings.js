// KAN-408: finer timing for one draft (stages, substeps, calls, cache hits, queue waits), saved as the additive
// metadata.json key `timings_detail`. Pure observer: every method swallows its own failures and call() returns or
// rethrows exactly what the wrapped function did, so a broken clock or a write error never reaches the pipeline.
// Disabled (flag off) it is a stand-in whose wrap() returns the function itself and whose save() does nothing.
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { writeCreationCost } from './creationCost.js';

const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
const round = (n) => Math.round(n * 1000) / 1000;

// KAN-417: while a timed call runs, askGemini (routes/gemini.js) finds this recorder and reports what really
// happened inside it (provider that answered, attempts, key switches, 503 retries, agy -> API fallback).
// Nothing is stored unless call() set it, so untimed callers and the flag-off stand-in are untouched.
export const callRecorder = new AsyncLocalStorage();

const tokenUsage = (records) => {
  const ok = records.filter((r) => r.tokens && Number.isInteger(r.tokens.input) && Number.isInteger(r.tokens.output));
  return { tokens: ok.length ? { input: ok.reduce((n, r) => n + r.tokens.input, 0), output: ok.reduce((n, r) => n + r.tokens.output, 0) } : null, tokens_missing: records.length - ok.length };
};

// One timed call may hold several askGemini calls (e.g. a planner): the last one names the provider, the rest add up.
const fromRecords = (records) => {
  if (!records.length) return null;
  const last = records.at(-1);
  const sum = (key) => records.reduce((n, r) => n + (r[key] || 0), 0);
  const first = records.find((r) => r.fell_back_from);
  return {
    provider: last.provider ?? undefined,
    ...(last.model ? { model: last.model } : {}),
    ...(Object.hasOwn(last, 'role') ? { role: last.role } : {}),
    ...(Object.hasOwn(last, 'fallback_order') ? { fallback_order: last.fallback_order } : {}),
    ...(Object.hasOwn(last, 'extra_calls') ? { extra_calls: last.extra_calls } : {}),
    retries: Math.max(0, sum('attempts') - 1),
    ...(first ? { fallback_from: first.fell_back_from, fallback_reason: first.fallback_reason } : {}),
    // KAN-932: usage a provider reported (askRole tiered Claude calls); absent keys mean the call reported nothing.
    ...(records.some((r) => Object.hasOwn(r, 'tokens')) ? tokenUsage(records) : {}),
    ...(Object.hasOwn(last, 'step') ? { step: last.step, tier: last.tier, escalated: records.some((r) => r.escalated === true), trigger: records.find((r) => r.trigger)?.trigger ?? null, ...(last.escalation_denied ? { escalation_denied: last.escalation_denied } : {}) } : {}),
    key_switches: sum('key_switches'),
    http_503_retries: sum('http_503_retries'),
    blocked_skips: sum('blocked_skips'),
  };
};

function createCostOnlyTimings() {
const noopCalls = [];
return Object.freeze({
  enabled: false,
  stage: () => {},
  async call(meta, fn) {
    const records = [];
    let status = 'ok';
    const started = Date.now();
    try { return await callRecorder.run((record) => records.push(record), fn); }
    catch (error) { status = 'error'; throw error; }
    finally {
      safe(() => {
        for (const record of records.length ? records : [null]) {
          const from = record ? fromRecords([record]) : {};
          noopCalls.push({ ...meta, ...from, provider: from.provider ?? meta?.provider ?? null, model: from.model ?? meta?.model ?? null, kind: from.step ?? meta?.kind ?? 'ask', wall_s: round((Date.now() - started) / 1000), status, fallback_from: from.fallback_from ?? null });
        }
      });
    }
  },
  wrap: (_meta, fn) => fn,
  cache: () => {},
  reuse: () => {},
  wait: () => {},
  queued: (_key, promise) => promise,
  detail: () => null,
  // Even when detailed timing is disabled, finalization creates a cost record so each draft has an explicit record.
  save: (file) => safe(() => { const ok = writeCreationCost(path.dirname(file), { calls: [...noopCalls], stages: [] }); if (ok) noopCalls.length = 0; return ok; }, false),
});
}
// Legacy exported stand-in has no shared usage state; real creations use the factory below.
export const NOOP_TIMINGS = Object.freeze({ ...createCostOnlyTimings(), call: (_meta, fn) => fn(), save: (file) => safe(() => writeCreationCost(path.dirname(file), { calls: [], stages: [] }), false) });

export function createTimings({ enabled = false, clock = Date.now } = {}) {
  if (enabled !== true) return createCostOnlyTimings();
  const stages = [];
  const calls = [];
  const cache = { model_library_hit: null, tts_cache_hit: null, take_reuse_count: 0 };
  const queue = { gpu_lock_wait_s: 0, blender_queue_wait_s: 0 };
  let current = null;
  const now = () => safe(() => { const t = Number(clock()); return Number.isFinite(t) ? t : null; }, null);
  const iso = (t) => (t === null ? null : safe(() => new Date(t).toISOString(), null));
  const span = (a, b) => (a === null || b === null ? null : round((b - a) / 1000));
  const close = (st, t) => { if (st && st.ended_at === null) { st.ended_at = iso(t); st.wall_s = span(st._t0, t); } };

  const self = {
    enabled: true,
    // A new stage closes the one before it (the pipeline announces stages in order).
    stage(id) {
      safe(() => {
        const t = now();
        close(current, t);
        current = { id, started_at: iso(t), ended_at: null, wall_s: null, wait_s: 0, substeps: [], _t0: t };
        stages.push(current);
      });
    },
    // meta: {provider, kind, model, sub?, note?(result) -> extra fields}. Also records a substep of the open stage when meta.sub is set.
    async call(meta, fn) {
      const t0 = now();
      const st = current;
      let status = 'ok';
      let result;
      const records = [];
      try {
        result = await callRecorder.run((r) => records.push(r), fn);
        return result;
      } catch (err) {
        status = 'error';
        throw err;
      } finally {
        safe(() => {
          const t1 = now();
          const extra = status === 'ok' && typeof meta.note === 'function' ? safe(() => meta.note(result), null) : null;
          const { sub, note, ...rest } = meta; // eslint-disable-line no-unused-vars
          calls.push({ provider: rest.provider, kind: rest.kind, model: rest.model ?? null, started_at: iso(t0), wall_s: span(t0, t1), status, retries: 0, fallback_from: null, ...extra, ...safe(() => fromRecords(records), null) });
          if (sub && st) st.substeps.push({ id: sub, started_at: iso(t0), ended_at: iso(t1), wall_s: span(t0, t1) });
        });
      }
    },
    // meta may be a function of the call's arguments (e.g. factory route -> kind).
    wrap(meta, fn) {
      return (...args) => self.call(typeof meta === 'function' ? meta(...args) : meta, () => fn(...args));
    },
    // Several builds in one draft: the name stays true only while every one of them hit.
    cache(name, hit) { safe(() => { cache[name] = cache[name] === null ? hit === true : cache[name] && hit === true; }); },
    reuse() { safe(() => { cache.take_reuse_count += 1; }); },
    // Seconds spent queued (key: gpu_lock_wait_s | blender_queue_wait_s); also counted into the open stage's wait_s.
    wait(key, seconds) {
      safe(() => {
        if (typeof seconds !== 'number' || !(seconds >= 0) || !(key in queue)) return;
        queue[key] = round(queue[key] + seconds);
        if (current) current.wait_s = round(current.wait_s + seconds);
      });
    },
    // Wraps a promise that resolves when a shared lane frees up and records how long it took (the queue wait).
    queued(key, promise) {
      const t0 = now();
      const record = () => self.wait(key, span(t0, now()));
      return promise.then((v) => { record(); return v; }, (e) => { record(); throw e; });
    },
    detail() {
      return safe(() => {
        close(current, now());
        return { schema: 1, stages: stages.map(({ _t0, ...st }) => st), calls, cache, queue };
      }, null);
    },
    // Adds timings_detail to an already written metadata.json; false when it could not.
    save(file) {
      return safe(() => {
        const detail = self.detail();
        if (!detail) return false;
        const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify({ ...meta, timings_detail: detail }, null, 2));
        fs.renameSync(temp, file);
        writeCreationCost(path.dirname(file), detail); // KAN-932: cost.json beside metadata.json; never throws, never blocks
        return true;
      }, false);
    },
  };
  return self;
}
