// KAN-923 (CB14): a finished code-built job becomes a normal draft behind the existing Episode review-receipt gate (KAN-828).
//
// This is a callable component only. Nothing here picks a UI path, a route or a default stage; the CB5 runner (or a later route) calls codebuiltToDraft().
//
// The CB5 runner contract (what this adapter consumes; anything missing fails closed with 'runner_output_missing' or 'bad_artifact'):
//   <jobsRoot>/<jobId>/job_result.json   { version: 1, job_id: <jobId>, topic: <string>, sha256: { "<relative path>": "<64 hex>", ... } }
//   <jobsRoot>/<jobId>/final/video.mp4 | final/audio.wav | final/subtitles.srt | final/report.json | final/contact_sheet.jpg (+ optional contact_sheet_2..9.jpg)
//   <jobsRoot>/<jobId>/build/build.py
// The manifest carries hashes, never a pass flag: a claim of success in a file is not trusted. The adapter recomputes every hash from the bytes it copies.
//
// Safety: the job folder must be a plain folder directly under jobsRoot (no link, junction or reparse point on the way); only the expected names are copied and
// each must be a regular, single-link, non-empty file of the right type; extra files in the job folder are ignored, never copied. Files are copied (never linked)
// and hashed during the copy, so a file that changes while it is read fails its manifest hash.
//
// Receipt: this adapter NEVER issues a receipt. The draft carries the Episode marker `episode_draft` that routes/episodeReview.js recognises (dispatched from
// routes/semanticReview.js), so publish, scheduled release and future-upload refuse it until a human receipt exists. The marker's final_sha256 is the video's hash and
// its approved_gate_hash is a digest of the whole bundle (video, code, audio, subtitles, contact sheets, report), so a receipt is bound to all of them: a change to
// any editable file followed by resealCodebuiltDraft() (or the sanctioned reviseCodebuiltDraft()) makes the stored receipt stale.
// The shared Episode gate (routes/episodeReview.js) runs the on-disk drift check for code-built drafts itself (episode/codebuilt/bundle.js), so publish, scheduled
// release, future-upload and receipt issue all refuse a raw edit of the non-video files. codebuiltGate() below is the same check as a standalone call.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeCreationCost, normalizeJobCalls } from '../../perf/creationCost.js';
import { getChannelById, resolveChannelPolicy } from '../../routes/channelsManager.js';
import { episodeGate } from '../../routes/episodeReview.js';

// Version of the `episode_draft` marker written into a draft's metadata; routes/episodeReview.js reads it.
const EPISODE_MARKER_VERSION = 1;
import { CODEBUILT_DRAFT_VERSION, MB, ROLES, CB5_SOURCES, CB5_PNG_SHEET, CB5_REPORT_VERSION, specForFile, isObject, sha256, bundleDigest, safeLinks, hashFile, isCodebuiltDraft, verifyCodebuiltDraft } from './bundle.js';

export { CODEBUILT_DRAFT_VERSION, ROLES, CB5_SOURCES, bundleDigest, safeLinks, isCodebuiltDraft, verifyCodebuiltDraft };
export const MANIFEST_FILE = 'job_result.json';
export const MANIFEST_LIMIT = 64 * 1024;
export const EDITABLE_ROLES = Object.freeze(Object.keys(ROLES));
const COST_CALLS_FILE = 'cost_calls.json';
const VISUAL_LOOP_FILE = 'visual_loop.json';
const LIMITS = Object.freeze({ costBytes: 256 * 1024, metadataBytes: 256 * 1024, title: 90, script: 5000 });
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const MESSAGES = Object.freeze({
  invalid_id: 'Invalid job id', runner_output_missing: 'The build job has no validated runner output', bad_manifest: 'The build job result is invalid',
  bad_artifact: 'A build job file is missing, changed or not the expected kind', unsafe_path: 'A folder or file is not a plain one in the expected place',
  too_large: 'A file is too large', unknown_channel: 'Unknown channel', kids_channel_forbidden: 'Code-built drafts cannot use a made-for-kids channel',
  bad_option: 'Invalid option', bad_producer_report: 'The build job report is not a successful CB5 report', conflict: 'A draft for this job already exists', published: 'The draft is already published', internal: 'Could not write the draft',
});
// The message is always the generic text for the code; no path ever appears in an error.
export class CodebuiltDraftError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.internal);
    this.name = 'CodebuiltDraftError';
    this.code = MESSAGES[code] ? code : 'internal';
  }
}

const sameName = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
export const draftIdForJob = (jobId) => `cb-${jobId}`;
export const jobsRoot = () => path.resolve(process.env.FORGEAI_AGENT_JOBS_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../output/agent-jobs'));
export const draftsRoot = () => path.resolve(process.env.FORGEAI_DRAFTS_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../output/drafts'));
const inside = (a, b) => { const rel = path.relative(a, b); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

// ---- content checks on the bytes that were copied ---------------------------------------------------------------------------------------------------
function decodeText(buffer) {
  if (buffer.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, ''); } catch { return null; }
}
function checkKind(kind, buffer) {
  switch (kind) {
    case 'mp4': return buffer.length >= 12 && buffer.toString('latin1', 4, 8) === 'ftyp';
    case 'wav': return buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WAVE';
    case 'png': return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'jpg': return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case 'text': { const t = decodeText(buffer); return t !== null && t.trim().length > 0; }
    case 'srt': { const t = decodeText(buffer); return t !== null && t.includes('-->'); }
    case 'json': { const t = decodeText(buffer); if (t === null) return false; try { return isObject(JSON.parse(t)); } catch { return false; } }
    default: return false;
  }
}
// The head of a large file is enough for the binary magic checks; text kinds are small (cap 1 MB) and read whole.
function headFor(kind, file, size, fsApi) {
  const need = ['text', 'srt', 'json'].includes(kind) ? size : Math.min(size, 16);
  const fd = fsApi.openSync(file, 'r');
  try { const buffer = Buffer.alloc(need); fsApi.readSync(fd, buffer, 0, need, 0); return buffer; } finally { fsApi.closeSync(fd); }
}

// Copies one regular file, hashing the bytes that are written. Refuses links, hard links, empty, over-cap files. -> { sha256, size }
function copyHashed(from, to, cap, fsApi) {
  let fd; let out;
  try {
    const lstat = fsApi.lstatSync(from);
    if (lstat.isSymbolicLink() || !lstat.isFile()) throw new CodebuiltDraftError('unsafe_path');
    fd = fsApi.openSync(from, 'r');
    const stat = fsApi.fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1) throw new CodebuiltDraftError('unsafe_path');
    if (stat.size === 0) throw new CodebuiltDraftError('bad_artifact');
    if (stat.size > cap) throw new CodebuiltDraftError('too_large');
    out = fsApi.openSync(to, 'wx');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(MB);
    let total = 0;
    for (;;) {
      const n = fsApi.readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      total += n;
      if (total > cap) throw new CodebuiltDraftError('too_large');
      hash.update(buffer.subarray(0, n));
      fsApi.writeSync(out, buffer, 0, n);
    }
    return { sha256: hash.digest('hex'), size: total };
  } finally {
    if (fd !== undefined) try { fsApi.closeSync(fd); } catch { /* closed */ }
    if (out !== undefined) try { fsApi.closeSync(out); } catch { /* closed */ }
  }
}

// KAN-932: the runner keeps <jobsRoot>/.state/<jobId>.json with startedAt and finishedAt of the finished (isolated build + CPU render) run.
// -> seconds, or null when the record is missing, not a complete run, or its times are not valid. Nothing is guessed.
const RUNNER_STATE_DIR = '.state';
function renderWallSeconds(jobsReal, jobId, fsApi) {
  try {
    const file = path.join(jobsReal, RUNNER_STATE_DIR, `${jobId}.json`);
    const st = fsApi.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1 || st.size <= 0 || st.size > LIMITS.costBytes) return null;
    const state = JSON.parse(fsApi.readFileSync(file, 'utf8'));
    if (!isObject(state) || state.status !== 'complete') return null;
    const seconds = (Date.parse(state.finishedAt) - Date.parse(state.startedAt)) / 1000;
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) / 1000 : null;
  } catch { return null; }
}
const RENDER_NOTE = 'render_duration_s is the wall time of the isolated Blender build and CPU render run (runner startedAt to finishedAt); peak_vram_mb stays null because the render uses the CPU, not the GPU.';

// ---- the job folder -----------------------------------------------------------------------------------------------------------------------------------
// Every path segment from the jobs root down to the file must be a real, non-link folder/file. -> absolute path
/**
 * KAN-934: the visual loop's receipt, host-written beside cost_calls.json, reduced to hashes, counts and verdicts. No model sentence,
 * prompt, path or image ever reaches the draft; anything that does not match the strict shape is dropped (the draft is still made).
 */
export function sanitizeVisualLoop(raw) {
  const int = (v, max = 1000) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);
  const hex = (v) => (typeof v === 'string' && HEX64.test(v) ? v : null);
  const word = (v) => (typeof v === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(v) ? v : null);
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || !Array.isArray(raw.rounds) || raw.rounds.length < 1 || raw.rounds.length > 20) return null;
  const unapproved = raw.visual_check?.approved === false;
  const accepted = hex(raw.accepted?.buildSha256);
  if ((!unapproved && (!accepted || int(raw.accepted?.round, 100) === null)) || (unapproved && !Array.isArray(raw.visual_check?.findings))) return null;
  const rounds = [];
  for (const r of raw.rounds) {
    if (!r || (r.verdict !== 'pass' && r.verdict !== 'fix') || int(r.round, 100) === null || !hex(r.buildSha256)) return null;
    rounds.push({
      round: r.round, verdict: r.verdict, crashed: r.crashed === true, p0: int(r.p0), p1: int(r.p1), p2: int(r.p2), shots_ok: int(r.shotsOk), shots_described: int(r.shotsDescribed), calls: int(r.attempts),
      build_sha256: r.buildSha256, sheets: Array.isArray(r.sheets) ? r.sheets.slice(0, 2).map((x) => hex(x?.sha256)).filter(Boolean) : [], model: word(r.model),
      delivery_receipt: r.receipt ? { no_session_persistence: r.receipt.noSessionPersistence === true, tools_offered: int(r.receipt.toolsOffered, 100), image_count: int(r.receipt.imageCount, 10), prompt_sha256: hex(r.receipt.promptSha256) } : null,
    });
  }
  return {
    version: 1, ...(unapproved ? { visual_check: { approved: false, findings: raw.visual_check.findings.slice(0, 12).map((f) => ({ severity: ['P0', 'P1', 'P2'].includes(f?.severity) ? f.severity : 'P2', shot: typeof f?.shot === 'string' ? f.shot.slice(0, 40) : null, frames: Array.isArray(f?.frames) ? f.frames.slice(0, 8).filter((n) => Number.isInteger(n) && n >= 0) : [], issue: typeof f?.issue === 'string' ? f.issue.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300) : '', fix: typeof f?.fix === 'string' ? f.fix.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300) : '' })) } } : { accepted_round: raw.accepted.round, accepted_build_sha256: accepted }), looks: rounds.length, fix_rounds: rounds.filter((r) => r.verdict === 'fix').length, call_count: int(raw.callCount, 100),
    probe: { cli_version: word(raw.probe?.cliVersion), transport: word(raw.probe?.transport), argv_sha256: hex(raw.probe?.argvSha256) }, rounds,
    note: 'The delivery receipt proves which pictures and prompt reached which call; it does not prove the model judged them well.',
  };
}

function readVisualLoop(jobsReal, jobId, fsApi) {
  try {
    const file = confinedPath(jobsReal, jobId, VISUAL_LOOP_FILE, fsApi);
    const st = file ? fsApi.lstatSync(file) : null;
    if (!st || !st.isFile() || st.nlink > 1 || st.size === 0 || st.size > 64 * 1024) return null;
    return sanitizeVisualLoop(JSON.parse(fsApi.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error instanceof CodebuiltDraftError) throw error;
    return null;
  }
}

function confinedPath(rootReal, jobId, rel, fsApi) {
  let current = rootReal;
  for (const segment of [jobId, ...rel.split('/')]) {
    current = path.join(current, segment);
    let stat;
    try { stat = fsApi.lstatSync(current); } catch { return null; }
    if (stat.isSymbolicLink()) throw new CodebuiltDraftError('unsafe_path');
  }
  let real;
  try { real = fsApi.realpathSync(current); } catch { return null; }
  if (!sameName(real, current)) throw new CodebuiltDraftError('unsafe_path'); // a reparse point not reported as a link still changes the real path
  return current;
}

function readManifest(rootReal, jobId, fsApi) {
  const file = confinedPath(rootReal, jobId, MANIFEST_FILE, fsApi);
  if (!file) throw new CodebuiltDraftError('runner_output_missing'); // CB5 has not produced its validated output: fail closed
  const stat = fsApi.lstatSync(file);
  if (!stat.isFile() || stat.nlink > 1 || stat.size === 0 || stat.size > MANIFEST_LIMIT) throw new CodebuiltDraftError('bad_manifest');
  let manifest;
  try { manifest = JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { throw new CodebuiltDraftError('bad_manifest'); }
  if (!isObject(manifest) || manifest.version !== 1 || manifest.job_id !== jobId || typeof manifest.topic !== 'string' || !manifest.topic.trim() || !isObject(manifest.sha256)) throw new CodebuiltDraftError('bad_manifest');
  const allowed = new Set(Object.values(ROLES).map((r) => r.from));
  for (const [rel, hash] of Object.entries(manifest.sha256)) {
    if (!allowed.has(rel) || typeof hash !== 'string' || !HEX64.test(hash)) throw new CodebuiltDraftError('bad_manifest'); // an unexpected name is poison, not an extra
  }
  return { manifest, text: fsApi.readFileSync(file, 'utf8') };
}

// CB5 producer layout: no job_result.json exists, so there is no runner hash manifest. The only authority is the producer's own report, accepted on the copied bytes:
// fixed version, status 'ok', post.ok === true and a real probed duration. It never contains a path or a link we follow. -> { duration }
function checkCb5Report(buffer) {
  const text = decodeText(buffer);
  let report;
  try { report = text === null ? null : JSON.parse(text); } catch { report = null; }
  const post = isObject(report) ? report.post : null;
  const duration = isObject(post) && isObject(post.probe) ? post.probe.duration : null;
  if (!isObject(report) || report.version !== CB5_REPORT_VERSION || report.status !== 'ok' || !isObject(post) || post.ok !== true || !Number.isFinite(duration) || duration <= 0) throw new CodebuiltDraftError('bad_producer_report');
  return { duration };
}

function resolveChannel(channelId, getChannel) {
  let channel;
  try { channel = typeof channelId === 'string' ? getChannel(channelId) : null; } catch { channel = null; }
  if (!isObject(channel) || channel.id !== channelId) throw new CodebuiltDraftError('unknown_channel');
  const policy = resolveChannelPolicy(channel);
  if (!isObject(policy) || typeof policy.made_for_kids !== 'boolean') throw new CodebuiltDraftError('unknown_channel');
  if (policy.made_for_kids !== false) throw new CodebuiltDraftError('kids_channel_forbidden');
  return { channel_id: channel.id, genre: channel.genre, made_for_kids: false };
}

function resolveDraftsRoot(root, jobsReal, fsApi) {
  let real;
  try {
    fsApi.mkdirSync(root, { recursive: true });
    real = fsApi.realpathSync(root);
    if (!fsApi.lstatSync(real).isDirectory()) throw new Error('not a directory');
  } catch { throw new CodebuiltDraftError('unsafe_path'); }
  if (inside(jobsReal, real) || inside(real, jobsReal)) throw new CodebuiltDraftError('unsafe_path');
  return real;
}

const linksFor = safeLinks;
const srtText = (buffer) => (decodeText(buffer) || '').split(/\r?\n/).filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !l.includes('-->')).join(' ').replace(/\s+/g, ' ').trim();

// Options: jobId, channelId (a known, not-for-kids channel), now (Date | () => Date | ISO string), jobsDir / draftsDir (default agent-jobs / FORGEAI_DRAFTS_DIR),
// getChannel (default: the channel store), fsApi (tests). -> { created, draftId, metadata }. The same job with the same bytes returns { created: false }.
export function codebuiltToDraft({ jobId, channelId, now = () => new Date(), jobsDir = jobsRoot(), draftsDir = draftsRoot(), getChannel = getChannelById, fsApi = fs, topic, premise, title: titleOverride, tags: tagOverrides, metadataSource } = {}) {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new CodebuiltDraftError('invalid_id');
  const channel = resolveChannel(channelId, getChannel);
  const createdAt = typeof now === 'function' ? now() : now;
  const stamp = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(stamp.getTime())) throw new CodebuiltDraftError('bad_option');
  let jobsReal;
  try { jobsReal = fsApi.realpathSync(jobsDir); } catch { throw new CodebuiltDraftError('runner_output_missing'); }
  const root = resolveDraftsRoot(draftsDir, jobsReal, fsApi);
  // Layout: a runner manifest (job_result.json + final/*) wins. Without one, the fixed CB5 producer layout (out/report.json) is used, with the topic given explicitly.
  const cb5 = !confinedPath(jobsReal, jobId, MANIFEST_FILE, fsApi);
  let manifest; let manifestText;
  if (cb5) {
    if (!confinedPath(jobsReal, jobId, CB5_SOURCES.report, fsApi)) throw new CodebuiltDraftError('runner_output_missing');
    if (typeof topic !== 'string' || !topic.trim()) throw new CodebuiltDraftError('bad_option');
    manifest = { topic, sha256: null };
  } else ({ manifest, text: manifestText } = readManifest(jobsReal, jobId, fsApi));
  const draftId = draftIdForJob(jobId);
  const target = path.join(root, draftId);

  // Resolve the sources first: nothing is written until every expected file is present and confined.
  const sources = {};
  const plan = cb5 ? Object.entries(CB5_SOURCES).map(([role, from]) => [role, role === 'contact_sheet' ? CB5_PNG_SHEET : { ...ROLES[role], from }]) : Object.entries(ROLES);
  for (const [role, spec] of plan) {
    const file = confinedPath(jobsReal, jobId, spec.from, fsApi);
    if (cb5) { if (!file) throw new CodebuiltDraftError('bad_artifact'); sources[role] = { file, spec }; continue; }
    if (!file) { if (spec.optional) { if (Object.hasOwn(manifest.sha256, spec.from)) throw new CodebuiltDraftError('bad_manifest'); continue; } throw new CodebuiltDraftError('bad_artifact'); }
    if (!Object.hasOwn(manifest.sha256, spec.from)) throw new CodebuiltDraftError('bad_manifest'); // present but never validated by the runner
    sources[role] = { file, spec };
  }

  let existing = null;
  try { existing = fsApi.lstatSync(target); } catch { /* absent */ }

  const stage = path.join(root, `.stage-${draftId}-${crypto.randomBytes(6).toString('hex')}`);
  const written = [];
  let folder = stage;
  const cleanup = () => { // only files this call created, then the empty folder: no recursive delete
    for (const name of written) { try { fsApi.unlinkSync(path.join(folder, name)); } catch { /* already gone */ } }
    try { fsApi.rmdirSync(folder); } catch { /* absent or not empty */ }
  };
  try {
    fsApi.mkdirSync(stage);
    if (!sameName(path.dirname(fsApi.realpathSync(stage)), root)) throw new CodebuiltDraftError('unsafe_path');
    const files = {};
    for (const [role, { file: source, spec }] of Object.entries(sources)) {
      const dest = path.join(stage, spec.to);
      let copied;
      try { copied = copyHashed(source, dest, spec.cap, fsApi); } finally { written.push(spec.to); }
      if (!cb5 && copied.sha256 !== manifest.sha256[spec.from]) throw new CodebuiltDraftError('bad_artifact'); // changed since the runner validated it, or never matched
      if (!checkKind(spec.kind, headFor(spec.kind, dest, copied.size, fsApi))) throw new CodebuiltDraftError('bad_artifact');
      files[role] = { file: spec.to, sha256: copied.sha256, size: copied.size };
    }
    const digest = bundleDigest(files);
    const reportBytes = fsApi.readFileSync(path.join(stage, 'report.json'));
    const report = cb5 ? null : JSON.parse(decodeText(reportBytes));
    const producer = cb5 ? checkCb5Report(reportBytes) : null; // checked on the copied bytes, never on the source
    const cleanMeta = (v, max) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';
    const fallbackTitle = cleanMeta(manifest.topic, LIMITS.title) || 'Code-built short';
    const title = cleanMeta(premise?.title, 200) || cleanMeta(titleOverride, LIMITS.title) || fallbackTitle;
    const tags = Array.isArray(tagOverrides) ? [...new Set(tagOverrides.slice(0, 12).map((v) => cleanMeta(v, 32)).filter(Boolean))] : [];
    const script = srtText(fsApi.readFileSync(path.join(stage, 'subtitles.srt'))).slice(0, LIMITS.script);
    const duration = cb5 ? producer.duration : (Number.isFinite(report.duration_seconds) ? report.duration_seconds : null);
    const visualLoop = readVisualLoop(jobsReal, jobId, fsApi);
    const metadata = {
      draft_id: draftId,
      channel_id: channel.channel_id,
      genre: channel.genre,
      content_type: 'episode_video',
      created_at: stamp.toISOString(),
      product: { title, suggested_price: '$0.00', garment_type: 'video_short', visual_style: 'code_built', placement: 'tiktok_reels_shorts' },
      listing_copy: { title, tags, description: [cleanMeta(premise?.answer, 600), script].filter(Boolean).join('\n\n'), bullet_points: ['Path: code-built'] },
      social: { caption: title, hashtags: [], duration_seconds: duration },
      video_file: 'video.mp4',
      script,
      engine: 'codebuilt',
      made_for_kids: false,
      ai_disclosure: true,
      generation_details: { draft_version: CODEBUILT_DRAFT_VERSION, path: 'codebuilt', job_id: jobId, ...(visualLoop ? { visual_loop: visualLoop, ...(visualLoop.visual_check ? { visual_check: visualLoop.visual_check } : {}) } : {}), metadata_source: metadataSource === 'light_router' && cleanMeta(titleOverride, LIMITS.title) ? 'light_router' : 'topic_fallback', ...(cb5 ? { producer: CB5_REPORT_VERSION } : {}), final: { file: 'video.mp4', sha256: files.video.sha256 } },
      codebuilt: { version: 1, job_id: jobId, bundle_sha256: digest, files, links: linksFor(draftId, files) },
      // The marker the review-receipt gate recognises. NO receipt is written here: a person issues it after watching and listening.
      episode_draft: { version: EPISODE_MARKER_VERSION, episode_id: jobId, final_sha256: files.video.sha256, approved_gate_hash: digest, finish_hash: cb5 ? files.report.sha256 : sha256(manifestText) },
    };
    const metadataText = `${JSON.stringify(metadata, null, 2)}\n`;
    if (Buffer.byteLength(metadataText) > LIMITS.metadataBytes) throw new CodebuiltDraftError('too_large');

    if (existing) { // same job, same bytes = the same draft (idempotent); anything else is a conflict and nothing is overwritten
      cleanup();
      if (existing.isDirectory() && !existing.isSymbolicLink()) {
        try {
          const prior = JSON.parse(fsApi.readFileSync(path.join(target, 'metadata.json'), 'utf8'));
          if (prior?.codebuilt?.bundle_sha256 === digest && prior.channel_id === channel.channel_id) return { created: false, draftId, metadata: prior };
        } catch { /* conflict */ }
      }
      throw new CodebuiltDraftError('conflict');
    }
    // KAN-932: cost record beside the draft, from the optional cost_calls.json the runner or agents wrote in the job folder (not part of the sealed bundle).
    // Missing, unreadable or token-less calls are recorded as "tokens not reported"; this never fails or blocks the draft.
    try {
      let calls = [];
      try {
        const costFile = confinedPath(jobsReal, jobId, COST_CALLS_FILE, fsApi);
        const st = costFile ? fsApi.lstatSync(costFile) : null;
        if (st && st.isFile() && st.nlink <= 1 && st.size > 0 && st.size <= LIMITS.costBytes) calls = normalizeJobCalls(JSON.parse(fsApi.readFileSync(costFile, 'utf8').replace(/^﻿/, '')));
      } catch { calls = []; }
      written.push('cost.json');
      const renderS = renderWallSeconds(jobsReal, jobId, fsApi);
      if (!writeCreationCost(stage, { calls, stages: renderS === null ? [] : [{ id: 'render', wall_s: renderS }], ...(renderS === null ? {} : { notes: [RENDER_NOTE] }) })) written.pop();
    } catch { /* cost is best effort */ }
    fsApi.writeFileSync(path.join(stage, '.metadata.partial'), metadataText, { flag: 'wx' });
    written.push('.metadata.partial');
    fsApi.renameSync(stage, target);
    folder = target;
    fsApi.renameSync(path.join(target, '.metadata.partial'), path.join(target, 'metadata.json')); // metadata.json appears last, in a complete folder
    return { created: true, draftId, metadata };
  } catch (error) {
    if (!existing) cleanup();
    if (error instanceof CodebuiltDraftError) throw error;
    throw new CodebuiltDraftError('internal');
  }
}

// ---- drift, reseal, revise ------------------------------------------------------------------------------------------------------------------------------
// The existing Episode gate plus the drift check. null = ready. Otherwise the refusal body, same shape as episodeGate's.
export function codebuiltGate(draft, deps = {}) {
  const drift = verifyCodebuiltDraft(draft, deps);
  if (!drift.ok) return { error: `This code-built video has changed since it was reviewed: ${drift.blockers.map((b) => b.message).join('; ')}.`, semantic_review: { episode: true, status: 'needs_review', ready: false, blockers: drift.blockers, links: null } };
  return episodeGate(draft);
}

function writeMeta(folder, meta, fsApi) {
  const text = `${JSON.stringify(meta, null, 2)}\n`;
  if (Buffer.byteLength(text) > LIMITS.metadataBytes) throw new CodebuiltDraftError('too_large');
  const tmp = path.join(folder, `.metadata.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fsApi.writeFileSync(tmp, text, { flag: 'wx' });
  fsApi.renameSync(tmp, path.join(folder, 'metadata.json'));
}

// Re-reads the files in the draft folder, validates them by kind, and re-seals the marker. The receipt (if any) becomes stale because its binding changes.
// -> { changed, meta }. A published draft is refused: the version that went out is the version that was reviewed.
export function resealCodebuiltDraft(draft, { fsApi = fs } = {}) {
  if (!isCodebuiltDraft(draft)) throw new CodebuiltDraftError('bad_option');
  if (draft.meta.youtube) throw new CodebuiltDraftError('published');
  const meta = JSON.parse(JSON.stringify(draft.meta));
  const files = {};
  for (const [role, entry] of Object.entries(meta.codebuilt.files)) {
    const spec = isObject(entry) ? specForFile(role, entry.file) : null;
    if (!spec) throw new CodebuiltDraftError('bad_artifact');
    const file = path.join(draft.folder, spec.to);
    const stat = fsApi.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1 || stat.size === 0) throw new CodebuiltDraftError('unsafe_path');
    if (stat.size > spec.cap) throw new CodebuiltDraftError('too_large');
    const sha = hashFile(file, fsApi);
    if (!sha || !checkKind(spec.kind, headFor(spec.kind, file, stat.size, fsApi))) throw new CodebuiltDraftError('bad_artifact');
    files[role] = { file: spec.to, sha256: sha, size: stat.size };
  }
  const digest = bundleDigest(files);
  const changed = digest !== meta.codebuilt.bundle_sha256;
  meta.codebuilt.files = files;
  meta.codebuilt.bundle_sha256 = digest;
  meta.codebuilt.links = linksFor(meta.draft_id, files);
  meta.episode_draft.final_sha256 = files.video.sha256;
  meta.episode_draft.approved_gate_hash = digest;
  meta.generation_details.final = { file: 'video.mp4', sha256: files.video.sha256 };
  if (changed) writeMeta(draft.folder, meta, fsApi);
  return { changed, meta };
}

// The sanctioned way to replace one editable file (code, audio, subtitles, report, contact sheet, video): it validates the new bytes by kind, writes them
// atomically inside the draft folder, and re-seals. Any receipt issued before is stale afterwards.
export function reviseCodebuiltDraft(draft, role, bytes, { fsApi = fs } = {}) {
  if (!isCodebuiltDraft(draft) || !Object.hasOwn(ROLES, role) || !Object.hasOwn(draft.meta.codebuilt.files, role)) throw new CodebuiltDraftError('bad_option');
  if (draft.meta.youtube) throw new CodebuiltDraftError('published');
  const spec = specForFile(role, draft.meta.codebuilt.files[role].file); // the file name already in the draft (jpg or png sheet); never a new one
  if (!spec) throw new CodebuiltDraftError('bad_option');
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length === 0 || buffer.length > spec.cap) throw new CodebuiltDraftError(buffer.length ? 'too_large' : 'bad_artifact');
  if (!checkKind(spec.kind, buffer)) throw new CodebuiltDraftError('bad_artifact');
  const tmp = path.join(draft.folder, `.${spec.to}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fsApi.writeFileSync(tmp, buffer, { flag: 'wx' });
    fsApi.renameSync(tmp, path.join(draft.folder, spec.to));
  } catch (error) {
    try { fsApi.unlinkSync(tmp); } catch { /* not created */ }
    throw error instanceof CodebuiltDraftError ? error : new CodebuiltDraftError('internal');
  }
  return resealCodebuiltDraft(draft, { fsApi });
}
