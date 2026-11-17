// codex · gpt-6.1-sol · 2026-11-17 18:10 +02:00: persist and forward the exact job route.
// codex · gpt-6.1-sol · 2026-11-17 13:53 +02:00: request formats follow the topic gate into the starter.
import { cleanJobFormats } from './skills.js';
// KAN-928 (CB16): the owner-started batch. One Start action runs `count` (1..15, default 1) code-built videos, one after another.
//
// For each video the coordinator resolves every choice the owner left on Auto (duration, voice and the type through routes/autoChoices.js; the topic through
// theme.js scoring fed by a real router call, see autoTopic.js). The TYPE is decided before the topic, and the same validated { genre, theme, type } goes to the
// topic pick, the script prompt, the fact check and the planner prompt (productionChoices.js). Then it queues one job on the existing single-job starter (start.js). The starter runs
// script -> fact check -> voice -> planner -> isolated build (its own QA) -> draft behind the review gate. A video that fails is recorded with a
// named reason code and the next video starts; only an explicit run abort stops the remaining videos. The existing starter FIFO is used as is:
// the coordinator waits for each job to settle before it queues the next one, so single jobs queued meanwhile interleave fairly.
//
// Nothing here starts by itself: no timer, no schedule, no boot-time resume, no publish. A restart leaves an unfinished run reported as
// "interrupted"; the owner starts a new one. A failed save is a run failure, not a warning: the running job is aborted and nothing costly starts after it
// (persistence_failed). The route behind startRun is admin-only. Everything is injectable; the production defaults are
// the shared starter, the router-backed topic provider and the real Episode fact check (all refuse a model call under `node --test`).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite } from '../artifacts.js';
import { jobsRoot } from './draftAdapter.js';
import { codebuiltStarter, DURATIONS, BUILD_MODELS, FINAL, TOPIC_MAX, checkJobRoute, effectiveJobRoute } from './start.js';
import { QWEN_SPEAKERS } from '../voice.js';
import { resolveAutoChoices, loadAutoInputs } from '../../routes/autoChoices.js';
import { cleanChannelVideoTypes, getAllChannels, getChannelById } from '../../routes/channelsManager.js';
import { createAutoTopicProvider, AutoTopicError, jobFormatsFor } from './autoTopic.js';
import { sanitizeRouterCall } from './routerCalls.js';
import { isWhatIfTopic } from './productionChoices.js';

export const RUN_VERSION = 'codebuilt-run-v1';
export const MAX_COUNT = 15;
export const DEFAULT_COUNT = 1;
export const TYPES = Object.freeze(['factual', 'whatif', 'history', 'teardown']);
export const RUN_DIR = '.runs';
export const ACTIVE_RUN = Object.freeze(['queued', 'running', 'aborting']);
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$/;
const TEXT_CHOICE = /^[\p{L}\p{N} ,.'&/+()-]{1,60}$/u;
const KEYS = Object.freeze(['count', 'genre', 'theme', 'topic', 'type', 'voice', 'duration', 'buildModel', 'channelId', 'formats', 'route']);
const isAuto = (v) => v === undefined || v === null || (typeof v === 'string' && (!v.trim() || v.trim().toLowerCase() === 'auto'));

const MESSAGES = Object.freeze({
  author_mode_disabled: 'Author mode is disabled',
  bad_request: 'Invalid request', topic_needs_single_video: 'A typed topic is one video: set the count to 1, or leave the topic on Auto and give a theme for several videos',
  type_mismatch: 'The chosen type and the topic disagree (a what-if type needs a "What if ...?" topic and a factual type must not have one)',
  channel_type_mismatch: 'The selected channel is not assigned to this video type', channel_type_unassigned: 'No channel is assigned to this video type', channel_type_ambiguous: 'Several channels are assigned to this video type; choose a channel explicitly',
  persistence_failed: 'The run could not be saved, so it was stopped before any more work was started', not_found: 'Not found', conflict: 'The run is not in a state that allows this', run_active: 'A run is already in progress',
  build_model_unavailable: 'The requested build model is not available', internal: 'The run failed',
  // per-video named failures (stage is recorded beside the code)
  theme_provider_failed: 'The topic pick could not reach a model', theme_no_candidates: 'The topic pick returned no usable topics',
  theme_all_rejected: 'Every proposed topic was rejected as a repeat or by the channel rules', theme_scoring_failed: 'The topic scoring failed',
  resolve_failed: 'The automatic choices could not be resolved', job_lost: 'The video job could not be found', aborted: 'Aborted',
  run_aborted: 'The run was aborted before this video started', interrupted: 'The server restarted while the run was going',
  not_started: 'The run ended before this video started', start_failed: 'The video job could not be queued',
});
// Job failure codes keep the starter's own fixed text (start.js MESSAGES); anything unknown is generic.
export class RunError extends Error {
  constructor(code, status = 400) { super(MESSAGES[code] || MESSAGES.internal); this.name = 'RunError'; this.code = MESSAGES[code] ? code : 'internal'; this.status = status; }
}

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nearestDuration = (seconds) => DURATIONS.reduce((best, d) => (Math.abs(d - seconds) < Math.abs(best - seconds) ? d : best), DURATIONS[0]);

/** Validates the owner's request. Auto (or blank) leaves a field to be decided per video; anything else must be a known choice. */
export function checkRunRequest(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new RunError('bad_request');
  if (Object.keys(input).some((k) => !KEYS.includes(k))) throw new RunError('bad_request');
  const route = checkJobRoute(input.route, RunError);
  const count = input.count === undefined ? DEFAULT_COUNT : input.count;
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) throw new RunError('bad_request');
  const text = (value) => {
    if (isAuto(value)) return null;
    if (typeof value !== 'string' || !TEXT_CHOICE.test(value.trim())) throw new RunError('bad_request');
    return value.trim();
  };
  const genre = text(input.genre); const theme = text(input.theme);
  let topic = null;
  if (!isAuto(input.topic)) {
    topic = typeof input.topic === 'string' ? input.topic.trim() : '';
    if (!topic || topic.length > TOPIC_MAX || /[\x00-\x1F\x7F]/.test(topic)) throw new RunError('bad_request');
    // One typed topic is one video: a longer run would make every video the same one. This is an explicit, named refusal (the form shows the same text
    // before Start); a theme gives variety across a run.
    if (count > 1) throw new RunError('topic_needs_single_video');
  }
  let type = null;
  if (!isAuto(input.type)) {
    type = typeof input.type === 'string' ? input.type.trim().toLowerCase() : '';
    if (!TYPES.includes(type)) throw new RunError('bad_request');
    if (topic && (type === 'whatif') !== isWhatIfTopic(topic)) throw new RunError('type_mismatch');
  }
  let voice = null;
  if (!isAuto(input.voice)) {
    voice = typeof input.voice === 'string' ? input.voice.trim().toLowerCase() : '';
    if (!QWEN_SPEAKERS.includes(voice)) throw new RunError('bad_request');
  }
  let duration = null;
  if (!isAuto(input.duration)) {
    if (!DURATIONS.includes(input.duration)) throw new RunError('bad_request');
    duration = input.duration;
  }
  let buildModel = 'Auto';
  if (input.buildModel !== undefined) {
    if (typeof input.buildModel !== 'string') throw new RunError('bad_request');
    const match = BUILD_MODELS.find((m) => m.toLowerCase() === input.buildModel.trim().toLowerCase());
    if (!match) throw new RunError('bad_request');
    buildModel = match;
  }
  if (buildModel === 'Codex Sol') throw new RunError('build_model_unavailable', 422);
  if (input.channelId !== undefined && (typeof input.channelId !== 'string' || !input.channelId || input.channelId.length > 80)) throw new RunError('bad_request');
  return { route, count, genre, theme, topic, type, voice, duration, buildModel, ...(cleanJobFormats(input.formats).length ? {formats:cleanJobFormats(input.formats)} : {}), channelId: input.channelId };
}

function requestedChannelTypes(type) {
  return type === null ? ['factual', 'whatif'] : [type];
}

function supportsRequestedTypes(channel, type) {
  let assigned;
  try { assigned = cleanChannelVideoTypes(channel?.video_types); } catch { assigned = []; }
  return type === null ? assigned.some((candidate) => candidate !== 'teardown') : requestedChannelTypes(type).every((candidate) => assigned.includes(candidate));
}

function findMappedChannel(type, channels) {
  const candidates = channels.filter((channel) => supportsRequestedTypes(channel, type));
  if (!candidates.length) throw new RunError('channel_type_unassigned');
  if (candidates.length > 1) throw new RunError('channel_type_ambiguous');
  return candidates[0];
}

function withoutLegacyLoopDefault(channel) {
  return channel?.profile?.format === 'loop'
    ? { ...channel, profile: { ...channel.profile, format: 'narrated' } }
    : channel;
}

// codex · gpt-6.1-sol · 2026-11-16 10:36 +02:00: expose persisted all-rejected evidence on failed videos.
const publicError = (e) => (e ? { code: e.code, message: e.message, ...(e.stage ? { stage: e.stage } : {}), ...(e.diagnostics && e.code === 'theme_all_rejected' ? { diagnostics: e.diagnostics } : {}) } : null);
const countsOf = (videos) => {
  const c = { done: 0, failed: 0, aborted: 0, pending: 0, running: 0 };
  for (const v of videos) {
    if (v.status === 'done') c.done += 1; else if (v.status === 'failed') c.failed += 1; else if (v.status === 'aborted') c.aborted += 1;
    else if (v.status === 'pending') c.pending += 1; else c.running += 1;
  }
  return { ...c, drafts: c.done };
};
export function publicRun(rec) {
  if (!rec) return null;
  const { id, status, count, choices, channelId, createdAt, updatedAt, videos } = rec;
  return {
    route: rec.route ?? 'classic', id, status, count, choices, channelId: channelId ?? null, createdAt, updatedAt, summary: countsOf(videos), error: publicError(rec.error),
    videos: videos.map((v) => ({
      route: v.route ?? rec.route ?? 'classic', index: v.index, status: v.status, step: v.step ?? null, topic: v.topic ?? null, duration: v.duration ?? null, voice: v.voice ?? null, type: v.type ?? null,
      jobId: v.jobId ?? null, draftId: v.draftId ?? null, resolved: v.resolved ?? {}, theme_pick: v.theme_pick ?? null, calls: v.calls ?? [], error: publicError(v.error),
      ...(v.length_check ? { length_check: v.length_check } : {}),
    })),
  };
}

export function createCodebuiltRunCoordinator({
  starter, runsDir = path.join(jobsRoot(), RUN_DIR), getChannel = getChannelById, getChannels = getAllChannels,
  pickTopic = createAutoTopicProvider({ getChannel: (id) => withoutLegacyLoopDefault(getChannel(id)) }),
  resolveAuto = resolveAutoChoices, autoInputs = loadAutoInputs,
  clock = now, newId = () => `run-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`, pollMs = 1000,
} = {}) {
  const theStarter = () => starter ?? codebuiltStarter();
  const recFile = (id) => path.join(runsDir, id, 'run.json');
  const live = new Map(); // id -> { rec, ctl }
  let activeId = null; // one run at a time: set synchronously in startRun, so two simultaneous Starts cannot both pass
  const unsaved = new Map(); // finished runs whose final record could not be written: still reported from memory, never from a stale file

  const save = (rec) => {
    rec.updatedAt = clock();
    fs.mkdirSync(path.dirname(recFile(rec.id)), { recursive: true });
    atomicWrite(path.dirname(recFile(rec.id)), 'run.json', `${JSON.stringify(rec, null, 1)}\n`);
  };
  const safeSave = (rec) => { try { save(rec); return true; } catch { return false; /* the live record stays queryable */ } };
  // Persistence is part of the run's safety: it is how an interrupted or failed run is reported. When a write fails, the run stops BEFORE any further
  // costly step (topic pick, script, voice, build): the running job is aborted, nothing more is started, and the run ends failed with persistence_failed.
  const persist = (rec, ctl) => {
    if (safeSave(rec)) return true;
    ctl.persistFailed = true; ctl.aborted = true;
    return false;
  };
  const load = (id) => {
    if (typeof id !== 'string' || !RUN_ID.test(id)) throw new RunError('bad_request');
    if (live.has(id)) return live.get(id).rec;
    if (unsaved.has(id)) return unsaved.get(id);
    try {
      const rec = JSON.parse(fs.readFileSync(recFile(id), 'utf8'));
      if (rec.id !== id) return null;
      // Recorded as going but nothing here owns it: the server restarted. Never report it as still running, and never resume it.
      if (ACTIVE_RUN.includes(rec.status)) {
        const videos = rec.videos.map((v) => (v.status === 'pending' ? { ...v, status: 'aborted', error: { code: 'not_started', message: MESSAGES.not_started } }
          : ['resolving', 'running'].includes(v.status) ? { ...v, status: 'failed', error: { code: 'interrupted', message: MESSAGES.interrupted, stage: v.step ?? null } } : v));
        return { ...rec, status: 'interrupted', videos };
      }
      return rec;
    } catch { return null; }
  };
  const fail = (video, code, stage, diagnostics = null) => { video.status = 'failed'; video.error = { code, message: MESSAGES[code] || MESSAGES.internal, ...(stage ? { stage } : {}), ...(code === 'theme_all_rejected' && diagnostics ? { diagnostics } : {}) }; };

  /** Auto resolution for one video. Every field records who decided it (owner or auto) and why. */
  async function resolveVideo(rec, index, previousTopics, onCallRecord) {
    const c = rec.request; // null = left on Auto
    const resolved = {};
    let channel = null;
    if (rec.channelId) { try { channel = withoutLegacyLoopDefault(getChannel(rec.channelId)); } catch { channel = null; } }
    const decide = (field, fallbackBody) => resolveAuto({ body: { auto_choices: { [field]: true }, ...fallbackBody }, channel });

    let duration = c.duration;
    if (duration !== null) resolved.duration = { source: 'owner' };
    else {
      const out = decide('seconds');
      duration = nearestDuration(out.body.seconds);
      resolved.duration = { source: 'auto', reason: `${out.resolved.seconds?.reason ?? 'default length'}; nearest code-built length`, value: duration };
    }
    let voice = c.voice;
    if (voice !== null) resolved.voice = { source: 'owner' };
    else {
      const out = decide('model');
      // The channel's own voice when it names one of the allowed speakers (plain or "qwen:<speaker>"); otherwise the existing default.
      const own = String(channel?.voice ?? '').trim().toLowerCase().split(':').at(-1);
      voice = out.body.model === 'qwen' && QWEN_SPEAKERS.includes(own) ? own : 'aiden';
      resolved.voice = { source: 'auto', reason: voice === own ? "the channel's voice" : 'default voice', value: voice };
    }
    // The type is decided BEFORE the topic, from what the owner already gave (the typed topic, else the theme, else the channel's own current idea), so the
    // topic pick, the script, the fact check and the planner all see the same value. The owner's own type, when set, is never overridden.
    let inspiration = '';
    if (!c.topic && !c.theme) {
      try {
        const inputs = autoInputs(channel);
        const out = resolveAuto({ body: { auto_choices: { theme: true } }, channel, ...inputs });
        const text = out.body.generation_profile?.custom_theme_text;
        if (typeof text === 'string' && text.trim()) inspiration = text.trim().slice(0, 200);
      } catch { /* inspiration is optional */ }
    }
    let type = c.type;
    if (type !== null) resolved.type = { source: c.type === null ? 'channel' : 'owner' };
    else {
      const out = decide('contentMode', { custom_theme_text: c.topic ?? c.theme ?? inspiration });
      type = out.body.contentMode === 'whatif' ? 'whatif' : 'factual';
      const assigned = cleanChannelVideoTypes(channel?.video_types);
      if (!assigned.includes(type)) type = assigned.find((candidate) => candidate !== 'teardown') ?? type;
      resolved.type = { source: 'auto', reason: out.resolved.contentMode?.reason ?? 'default', value: type };
    }
    if (type === 'teardown' && (rec.formats ?? []).includes('journey')) throw new RunError('bad_request');
    let topic = c.topic;
    let themePick = null;
    if (topic && !(rec.formats ?? []).includes('journey') && (type === 'teardown' || !channel?.profile?.formats?.includes('journey'))) resolved.topic = { source: 'owner' };
    else {
      const formats = cleanJobFormats([...(rec.formats ?? []), ...jobFormatsFor({ profile: channel?.profile, type })]);
      const picture = effectiveJobRoute(rec.route ?? 'classic', formats) !== 'classic';
      themePick = await pickTopic({ ...(picture ? { picture: true } : {}), genre: c.genre ?? '', theme: c.theme ?? '', type, formats: rec.formats, inspiration: topic || inspiration, previousTopics, channelId: rec.channelId ?? undefined, onCallRecord });
      topic = themePick.topic;
      resolved.topic = { source: 'auto', reason: `theme pick: rank 1 of ${themePick.ranked}`, value: topic };
    }
    // The topic and the type can never disagree after this point (the candidate filter and the request check already enforce it; this is the backstop).
    if (isWhatIfTopic(topic) !== (type === 'whatif')) throw new RunError('type_mismatch');
    // The same validated choices go to the script prompt, the fact check and the planner prompt of this video.
    const choices = { genre: c.genre, theme: c.theme, type };
    return { topic, duration, voice, type, choices, resolved, themePick };
  }

  async function waitForJob(ctl, jobId, video, rec) {
    let abortedJob = false;
    for (;;) {
      if (ctl.aborted && !abortedJob) { abortedJob = true; try { theStarter().abort(jobId); } catch { /* already final */ } }
      let job;
      try { job = theStarter().get(jobId); } catch { return null; }
      // codex / gpt-6.1-sol / 2026-11-16 09:06 +02:00: retain script-selected Auto length.
      if (rec.request.duration === null && [30, 45, 60].includes(job.duration) && video.duration !== job.duration) {
        video.duration = job.duration;
        video.resolved.duration = { source: 'auto', reason: 'script selected duration for the premise', value: job.duration };
        persist(rec, ctl);
      }
      if (job.step && job.step !== video.step) { video.step = job.step; persist(rec, ctl); }
      if (FINAL.includes(job.status)) return job;
      await sleep(pollMs);
    }
  }

  async function runLoop(rec, ctl) {
    // Videos that did not start: reported as not run (a persistence stop ends the whole run, see below).
    const stopRest = (from) => {
      for (const v of rec.videos.slice(from)) if (v.status === 'pending') { v.status = 'aborted'; v.error = { code: 'run_aborted', message: MESSAGES.run_aborted }; }
    };
    // The video that was in flight when the owner aborted (aborted) or when saving failed (failed, persistence_failed).
    const stopInFlight = (video, stage) => {
      if (ctl.persistFailed) fail(video, 'persistence_failed', stage);
      else { video.status = 'aborted'; video.error = { code: 'run_aborted', message: MESSAGES.run_aborted }; }
    };
    // codex / gpt-6.1-sol / 2026-11-16 08:56 +02:00: at most two jobs in flight.
    const inFlight = [];
    try {
      rec.status = 'running'; persist(rec, ctl);
      const previousTopics = [];
      for (let i = 0; i < rec.count; i += 1) {
        if (inFlight.length >= 2) await inFlight.shift();
        const video = rec.videos[i];
        if (ctl.aborted) { stopRest(i); break; }
        video.status = 'resolving'; video.step = 'resolving';
        // Nothing costly (no topic pick) starts unless the run's state can be written.
        if (!persist(rec, ctl)) { stopInFlight(video, 'resolving'); stopRest(i + 1); break; }
        const calls = [];
        const onCallRecord = (r) => { const call = sanitizeRouterCall(r); if (call) calls.push(call); };
        let resolved;
        try { resolved = await resolveVideo(rec, i, previousTopics, onCallRecord); } catch (error) {
          video.calls = calls;
          fail(video, error instanceof AutoTopicError || error instanceof RunError ? error.code : 'resolve_failed', 'theme', error instanceof AutoTopicError ? error.diagnostics : null);
          persist(rec, ctl);
          if (ctl.aborted) { stopRest(i + 1); break; }
          continue; // an individual failure never stops the run
        }
        video.calls = calls;
        Object.assign(video, { route: rec.route ?? 'classic', ...(rec.formats ? {formats:rec.formats} : {}), topic: resolved.topic, duration: resolved.duration, voice: resolved.voice, type: resolved.type, resolved: resolved.resolved, theme_pick: resolved.themePick ? { candidate_id: resolved.themePick.candidate_id, total: resolved.themePick.total, ranked: resolved.themePick.ranked, rejected: resolved.themePick.rejected, history_used: resolved.themePick.history_used, history_available: resolved.themePick.history_available } : null });
        previousTopics.push(resolved.topic);
        if (ctl.aborted) { stopInFlight(video, 'resolving'); stopRest(i + 1); persist(rec, ctl); break; }
        if (!persist(rec, ctl)) { stopInFlight(video, 'resolving'); stopRest(i + 1); break; }
        let queued;
        try {
          queued = theStarter().start(
            { route: rec.route ?? 'classic', ...(rec.formats ? {formats:rec.formats} : {}), topic: resolved.topic, duration: resolved.duration, voice: resolved.voice, buildModel: rec.request.buildModel, ...(rec.channelId ? { channelId: rec.channelId } : {}) },
            { factCheck: true, autoDuration: rec.request.duration === null, runId: rec.id, batchIndex: i, contentMode: resolved.type, choices: resolved.choices, ...(resolved.themePick?.premise ? { premise: resolved.themePick.premise } : {}), preCalls: calls },
          );
        } catch (error) {
          fail(video, typeof error?.code === 'string' && MESSAGES[error.code] ? error.code : 'start_failed', 'start');
          persist(rec, ctl);
          if (ctl.aborted) { stopRest(i + 1); break; }
          continue;
        }
        video.jobId = queued.id; video.status = 'running'; video.step = queued.step ?? 'queued'; ctl.jobs.add(queued.id); persist(rec, ctl);
        inFlight.push((async () => {
          const job = await waitForJob(ctl, queued.id, video, rec);
          ctl.jobs.delete(queued.id);
          if (!job) fail(video, 'job_lost', video.step);
          else if (job.status === 'done' && !ctl.persistFailed) { video.status = 'done'; video.step = 'done'; video.draftId = job.draftId ?? null; video.error = null; if (job.length_check) video.length_check = job.length_check; }
          else if (ctl.persistFailed) { video.draftId = job.status === 'done' ? (job.draftId ?? null) : null; fail(video, 'persistence_failed', job.step ?? video.step); }
          else if (job.status === 'aborted' && ctl.aborted) { video.status = 'aborted'; video.error = { code: 'aborted', message: MESSAGES.aborted, stage: job.step ?? null }; }
          else { video.status = 'failed'; video.error = { code: job.error?.code ?? 'internal', message: job.error?.message ?? MESSAGES.internal, stage: job.step ?? null }; }
          persist(rec, ctl);
        })().catch(() => {
          // Observe failures immediately, even while the next topic is resolving.
          // The remaining waiters see aborted and stop their jobs before we finish.
          ctl.aborted = true;
          fail(video, 'internal', video.step);
          persist(rec, ctl);
        }));
        if (ctl.aborted) { stopRest(i + 1); break; }
      }
      await Promise.all(inFlight);
      rec.status = ctl.persistFailed ? 'failed' : ctl.aborted ? 'aborted' : 'done';
    } catch {
      ctl.aborted = true;
      for (const id of ctl.jobs) { try { theStarter().abort(id); } catch {} }
      await Promise.allSettled(inFlight);
      // Unexpected: never leave the run looking active. Anything unfinished is reported, not hidden.
      for (const v of rec.videos) if (v.status === 'pending' || v.status === 'resolving') { v.status = 'failed'; v.error = { code: 'internal', message: MESSAGES.internal }; }
      rec.status = 'done';
    } finally {
      if (ctl.persistFailed) {
        for (const v of rec.videos) if (v.status === 'pending') { v.status = 'aborted'; v.error = { code: 'run_aborted', message: MESSAGES.run_aborted }; }
        rec.error = { code: 'persistence_failed', message: MESSAGES.persistence_failed };
      }
      // One last attempt. When the disk still refuses, the final record is kept in memory so the run is reported as it ended, not as the last file said.
      if (!safeSave(rec)) { unsaved.set(rec.id, rec); if (unsaved.size > 20) unsaved.delete(unsaved.keys().next().value); } else unsaved.delete(rec.id);
      live.delete(rec.id);
      if (activeId === rec.id) activeId = null;
    }
  }

  return {
    version: RUN_VERSION,
    /** Validates, records and starts a run in the background; returns at once. Only an explicit call does this. */
    startRun(input) {
      const requested = checkRunRequest(input);
      let channel = input.channelId ? getChannel(input.channelId) : findMappedChannel(requested.type, getChannels());
      if (!channel) throw new RunError('bad_request');
      if (!supportsRequestedTypes(channel, requested.type)) throw new RunError('channel_type_mismatch');
      const formats = cleanJobFormats([...(requested.formats ?? []), ...jobFormatsFor({ profile: channel.profile, type: requested.type })]);
      const req = { ...requested, route: effectiveJobRoute(requested.route, formats), channelId: channel.id };
      if (activeId) throw new RunError('run_active', 409);
      const id = newId();
      if (!RUN_ID.test(id)) throw new RunError('internal', 500);
      const choices = { route: req.route, count: req.count, genre: req.genre ?? 'Auto', theme: req.theme ?? 'Auto', topic: req.topic ?? 'Auto', type: req.type ?? 'Auto', voice: req.voice ?? 'Auto', duration: req.duration ?? 'Auto', buildModel: req.buildModel };
      const rec = {
        version: RUN_VERSION, route: req.route, id, ...(req.formats ? {formats:req.formats} : {}), status: 'queued', count: req.count, choices, request: { route: req.route, genre: req.genre, theme: req.theme, topic: req.topic, type: req.type, voice: req.voice, duration: req.duration, buildModel: req.buildModel }, channelId: req.channelId, createdAt: clock(), updatedAt: clock(),
        videos: Array.from({ length: req.count }, (_, index) => ({ index, status: 'pending', step: null, topic: null, jobId: null, draftId: null, error: null })),
      };
      save(rec); // a run that cannot even be recorded is refused
      const ctl = { aborted: false, jobs: new Set() };
      live.set(id, { rec, ctl });
      activeId = id;
      void runLoop(rec, ctl);
      return publicRun(rec);
    },
    getRun(id) { const rec = load(id); if (!rec) throw new RunError('not_found', 404); return publicRun(rec); },
    listRuns() {
      const out = new Map([...live.values()].map(({ rec }) => [rec.id, rec]));
      for (const [id, rec] of unsaved) if (!out.has(id)) out.set(id, rec);
      try { for (const name of fs.readdirSync(runsDir)) if (!out.has(name) && RUN_ID.test(name)) { const rec = load(name); if (rec) out.set(name, rec); } } catch { /* none yet */ }
      return [...out.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 20).map(publicRun);
    },
    /** Explicit run abort: the current job is aborted, the remaining videos are not started. A finished run cannot be aborted. */
    abortRun(id) {
      const rec = load(id);
      if (!rec) throw new RunError('not_found', 404);
      const entry = live.get(id);
      if (!entry) throw new RunError('conflict', 409);
      entry.ctl.aborted = true;
      rec.status = 'aborting';
      for (const jobId of entry.ctl.jobs) { try { theStarter().abort(jobId); } catch { /* already final */ } }
      safeSave(rec);
      return publicRun(rec);
    },
    /** Resolves when no run is active (tests and graceful shutdown). */
    async idle() { while (activeId) await sleep(5); },
  };
}

let shared = null;
/** The process-wide coordinator used by the routes. Tests pass their own through setCodebuiltRunCoordinator(). */
export function codebuiltRunCoordinator() { return (shared ??= createCodebuiltRunCoordinator()); }
export function setCodebuiltRunCoordinator(coordinator) { shared = coordinator; }
