// KAN-828: an Episode ends as a normal draft.
// toDraft({ episodeDir, channelId, now, ... }) copies the finished video of an Episode into a draft folder with the layout every other draft uses
// (output/drafts/<id>/{video.mp4, metadata.json, ...}), so Library, the listing and publishing see it like any other draft.
//  - It refuses unless state.json is valid, the finish stage is complete (its artifacts untouched, its probe passing) and the animatic gate is approved
//    for the animatic that is on disk right now.
//  - made_for_kids is the channel's policy (resolveChannelPolicy), never a default of this code. The channel id must be a known channel.
//  - ai_disclosure: true for story and whatif; breakdown has an explicit table entry (AI_DISCLOSURE_DEFAULTS); the caller may override it.
//  - The draft is staged in a hidden folder, renamed into place, and metadata.json is the LAST file to appear (the listing skips a folder without it).
//  - Nothing is linked: files are copied. Every source and target is checked by real path. Errors carry a code and a generic message, never a path.
//  - The draft carries `episode_draft` (see EPISODE_MARKER_VERSION). routes/episodeReview.js reads it: every upload path needs a review receipt bound to
//    this video.mp4 and this approval (see routes/semanticReview.js, which dispatches Episode drafts there).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { getChannelById, isSafeId } from '../routes/channelsManager.js';
import { selectEpisodeChannel } from './channel.js';
import { validateSpec } from './validateSpec.js';
import { validateState, STAGES } from './stateMachine.js';
import { resolveEpisodeDir, readArtifact, sha256, episodeRoot, validEpisodeId, STATE_FILE } from './artifacts.js';
import { resolveEpisodeFile } from './finish/paths.js';

export const DRAFT_VERSION = 'episode-draft-v1';
export const EPISODE_MARKER_VERSION = 1;
// The YouTube altered/synthetic-content flag follows meta.ai_disclosure (routes/youtube.js uploadStatus). Every path renders synthetic 3D/AI media,
// so every path discloses by default; a caller that has a reason (e.g. a purely diagrammatic breakdown) passes aiDisclosure: false explicitly.
export const AI_DISCLOSURE_DEFAULTS = Object.freeze({ story: true, whatif: true, breakdown: true });
export const LIMITS = Object.freeze({ videoBytes: 512 * 1024 * 1024, probeBytes: 1024 * 1024, posterBytes: 5 * 1024 * 1024, metadataBytes: 256 * 1024, title: 90, script: 5000 });
const POSTERS = Object.freeze(['final/poster.jpg', 'final/poster.png']);
const FINAL_VIDEO = /^final\/([A-Za-z0-9_][A-Za-z0-9._-]{0,127}\.mp4)$/;
const VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const MESSAGES = Object.freeze({
  invalid_id: 'Invalid Episode id', not_found: 'Episode not found', invalid_state: 'Episode state is invalid', not_ready: 'The Episode finish stage is not complete',
  gate_not_approved: 'The animatic gate is not approved for the current animatic', bad_artifact: 'An Episode artifact is missing or changed',
  unknown_channel: 'Unknown channel', kids_channel_forbidden: 'This Episode path cannot use a made-for-kids channel', bad_option: 'Invalid option', too_large: 'A file is too large', unsafe_path: 'A folder is not a plain folder in the expected place',
  conflict: 'A draft for this Episode already exists', internal: 'Could not write the draft',
});

// The message is always the generic text for the code.
export class DraftError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.internal);
    this.name = 'DraftError';
    this.code = MESSAGES[code] ? code : 'internal';
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameName = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
export const draftsRoot = () => path.resolve(process.env.FORGEAI_DRAFTS_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../output/drafts'));
// The same digest the state machine binds an approval to (stateMachine.js digestOf); the machine's own tests approve and run with this, so the two must agree.
const gateDigest = (outputs) => sha256(JSON.stringify(Object.keys(outputs).sort().map((name) => [name, outputs[name]])));

function fileSha256(file, fsApi) {
  const hash = crypto.createHash('sha256');
  const fd = fsApi.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) { const n = fsApi.readSync(fd, buffer, 0, buffer.length, null); if (n === 0) break; hash.update(buffer.subarray(0, n)); }
  } finally { fsApi.closeSync(fd); }
  return hash.digest('hex');
}

function parseJson(text, code) { try { return JSON.parse(text); } catch { throw new DraftError(code); } }
function artifactText(dir, name, expectedHash, fsApi) {
  let text;
  try { text = readArtifact(dir, name, fsApi); } catch { throw new DraftError('bad_artifact'); }
  if (text === null || sha256(text) !== expectedHash) throw new DraftError('bad_artifact');
  return text;
}

// -> { state, spec, finish, probe, output } or throws DraftError. Reads only; writes nothing.
function checkEpisode(dir, id, { fsApi, aspectHint }) {
  let stateText;
  try { stateText = readArtifact(dir, STATE_FILE, fsApi); } catch { throw new DraftError('invalid_state'); }
  if (stateText === null) throw new DraftError('not_found');
  const state = parseJson(stateText, 'invalid_state');
  try { validateState(state, id); } catch { throw new DraftError('invalid_state'); }
  const finishRec = state.stages.finish;
  if (finishRec.status !== 'complete') throw new DraftError('not_ready');
  for (const stage of STAGES.slice(0, STAGES.indexOf('finish') + 1)) if (state.stages[stage].status !== 'complete') throw new DraftError('not_ready');
  const animatic = state.stages.animatic;
  const gate = state.gates.animatic;
  if (gate.status !== 'approved' || animatic.status !== 'complete' || gate.approvedHash !== gateDigest(animatic.outputs)) throw new DraftError('gate_not_approved');
  artifactText(dir, 'animatic.json', animatic.outputs['animatic.json'], fsApi); // the approval is for the animatic on disk now
  const spec = parseJson(artifactText(dir, 'spec.json', state.stages.spec.outputs['spec.json'], fsApi), 'bad_artifact');
  if (!validateSpec(spec).valid) throw new DraftError('bad_artifact');
  const finish = parseJson(artifactText(dir, 'finish.json', finishRec.outputs['finish.json'], fsApi), 'bad_artifact');
  if (!isObject(finish) || finish.pass !== true || finish.assembled !== true || !Array.isArray(finish.outputs) || !finish.outputs.length) throw new DraftError('not_ready');
  const wanted = aspectHint || spec.aspect;
  const output = finish.outputs.find((o) => isObject(o) && o.aspect === wanted && typeof o.file === 'string' && FINAL_VIDEO.test(o.file)) || null;
  if (!output) throw new DraftError('bad_artifact');
  let probe;
  try {
    const probeFile = resolveEpisodeFile(dir, 'final/probe.json', { exts: ['.json'], maxBytes: LIMITS.probeBytes, label: 'probe' });
    probe = JSON.parse(fsApi.readFileSync(probeFile, 'utf8'));
  } catch { throw new DraftError('bad_artifact'); }
  const base = FINAL_VIDEO.exec(output.file)[1];
  const measured = isObject(probe) && probe.pass === true && Array.isArray(probe.outputs) ? probe.outputs.find((o) => isObject(o) && o.file === base) : null;
  if (!measured || !isObject(measured.checks) || !Object.values(measured.checks).length || !Object.values(measured.checks).every((c) => isObject(c) && c.pass === true)) throw new DraftError('not_ready');
  return { state, spec, finish, probe, output, base, measured };
}

function resolveDraftsRoot(root, episodesReal, fsApi) {
  let real;
  try {
    fsApi.mkdirSync(root, { recursive: true });
    real = fsApi.realpathSync(root);
    if (!fsApi.lstatSync(real).isDirectory()) throw new Error('not a directory');
  } catch { throw new DraftError('unsafe_path'); }
  const inside = (a, b) => { const rel = path.relative(a, b); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  if (inside(episodesReal, real) || inside(real, episodesReal)) throw new DraftError('unsafe_path'); // the two roots must be separate trees
  return real;
}

function stageVersions(engines) {
  const out = {};
  if (!isObject(engines)) return out;
  for (const stage of STAGES) { const v = engines[stage]?.version; if (typeof v === 'string' && VERSION.test(v)) out[stage] = v; }
  return out;
}

export const draftIdFor = (episodeId) => `ep-${episodeId}`;

// Options: episodeDir (the Episode id, a folder name under episodesRoot), channelId (a known channel), now (Date | () => Date | ISO string),
// aiDisclosure (optional boolean override), aspect (optional '9:16' | '16:9' to pick the output), engines (optional, for stage versions),
// episodesRoot / draftsDir (default EPISODE_ROOT / FORGEAI_DRAFTS_DIR), getChannel (default: the channel store), fsApi (tests).
// -> { created, draftId, metadata }. A second call for the same Episode and the same finished video returns { created: false } and changes nothing.
export function toDraft({ episodeDir, channelId, now = () => new Date(), aiDisclosure, aspect, engines, episodesRoot = episodeRoot(), draftsDir = draftsRoot(), getChannel = getChannelById, resolveChannel = selectEpisodeChannel, fsApi = fs } = {}) {
  if (!validEpisodeId(episodeDir)) throw new DraftError('invalid_id');
  if (aiDisclosure !== undefined && typeof aiDisclosure !== 'boolean') throw new DraftError('bad_option');
  if (aspect !== undefined && aspect !== '9:16' && aspect !== '16:9') throw new DraftError('bad_option');
  let dir; let episodesReal;
  try { dir = resolveEpisodeDir(episodesRoot, episodeDir, fsApi); episodesReal = fsApi.realpathSync(episodesRoot); }
  catch (error) { throw new DraftError(error && error.code === 'invalid_id' ? 'invalid_id' : 'not_found'); }
  const found = checkEpisode(dir, episodeDir, { fsApi, aspectHint: aspect });
  const { state, spec, finish, probe, output, base, measured } = found;
  let channel;
  try { channel = resolveChannel({ channelId, path: state.path, subPath: spec.sub, getChannel }); }
  catch (error) {
    if (error instanceof DraftError) throw error;
    throw new DraftError(error?.code === 'kids_channel_forbidden' ? 'kids_channel_forbidden' : 'unknown_channel');
  }
  if (!isObject(channel) || channel.channel_id !== channelId || typeof channel.made_for_kids !== 'boolean') throw new DraftError('unknown_channel');
  const createdAt = typeof now === 'function' ? now() : now;
  const stamp = (createdAt instanceof Date ? createdAt : new Date(createdAt));
  if (Number.isNaN(stamp.getTime())) throw new DraftError('bad_option');

  const videoFile = (() => { try { return resolveEpisodeFile(dir, output.file, { exts: ['.mp4'], maxBytes: LIMITS.videoBytes, label: 'video' }); } catch (error) { throw new DraftError(/too large/.test(error.message) ? 'too_large' : 'bad_artifact'); } })();
  let posterFile = null; let posterName = null;
  for (const rel of POSTERS) {
    try { posterFile = resolveEpisodeFile(dir, rel, { exts: ['.jpg', '.png'], maxBytes: LIMITS.posterBytes, label: 'poster' }); posterName = `poster${path.extname(rel)}`; break; }
    catch (error) { if (/too large/.test(error.message)) throw new DraftError('too_large'); /* not present: no poster */ }
  }
  const sourceSha = fileSha256(videoFile, fsApi);
  const draftId = draftIdFor(episodeDir);
  const root = resolveDraftsRoot(draftsDir, episodesReal, fsApi);
  const target = path.join(root, draftId);
  const gate = state.gates.animatic;
  const aiDisclosureValue = aiDisclosure !== undefined ? aiDisclosure : AI_DISCLOSURE_DEFAULTS[state.path] === true;
  const title = state.topic.replace(/\s+/g, ' ').trim().slice(0, LIMITS.title);
  const script = spec.lines.map((line) => line.text).join(' ').slice(0, LIMITS.script);
  const duration = Number.isFinite(measured.duration) ? measured.duration : (Number.isFinite(finish.audioDuration) ? finish.audioDuration : null);
  const stageEntries = (pick) => Object.fromEntries(STAGES.filter((s) => state.stages[s].status === 'complete').map((s) => [s, pick(state.stages[s])]));
  const metadata = {
    draft_id: draftId,
    channel_id: channel.channel_id,
    genre: channel.genre,
    content_type: 'episode_video',
    created_at: stamp.toISOString(),
    product: { title, suggested_price: '$0.00', garment_type: 'video_short', visual_style: spec.style, placement: 'tiktok_reels_shorts' },
    listing_copy: { title, tags: [], description: script, bullet_points: [`Path: ${state.path}`, `Shots: ${spec.shots.length}`] },
    social: { caption: title, hashtags: [], duration_seconds: duration },
    video_file: 'video.mp4',
    ...(posterName && { poster_file: posterName }),
    script,
    engine: 'episode',
    made_for_kids: channel.made_for_kids,
    ai_disclosure: aiDisclosureValue,
    generation_details: {
      draft_version: DRAFT_VERSION, episode_id: state.id, path: state.path, state_version: state.version,
      stage_versions: stageVersions(engines),
      stage_input_hashes: stageEntries((rec) => rec.inputHash),
      stage_output_hashes: stageEntries((rec) => ({ ...rec.outputs })),
      animatic_gate: { approved_hash: gate.approvedHash, approved_at: gate.at },
      final: { file: base, aspect: output.aspect, sha256: sourceSha },
    },
    // The marker the review-receipt gate (routes/episodeReview.js) recognises. The receipt binds to final_sha256 and approved_gate_hash.
    episode_draft: { version: EPISODE_MARKER_VERSION, episode_id: state.id, final_sha256: sourceSha, approved_gate_hash: gate.approvedHash, finish_hash: state.stages.finish.outputs['finish.json'] },
  };
  const metadataText = `${JSON.stringify(metadata, null, 2)}\n`;
  if (Buffer.byteLength(metadataText) > LIMITS.metadataBytes) throw new DraftError('too_large');

  // Already there? Same finished video and approval = the same draft (idempotent). Anything else is a conflict; nothing is overwritten.
  let existing = null;
  try { existing = fsApi.lstatSync(target); } catch { /* absent */ }
  if (existing) {
    if (existing.isDirectory() && !existing.isSymbolicLink()) {
      try {
        const prior = JSON.parse(fsApi.readFileSync(path.join(target, 'metadata.json'), 'utf8'));
        if (prior?.episode_draft?.final_sha256 === sourceSha && prior.episode_draft.approved_gate_hash === gate.approvedHash && prior.channel_id === channel.channel_id && prior.made_for_kids === channel.made_for_kids) return { created: false, draftId, metadata: prior };
      } catch { /* fall through to conflict */ }
    }
    throw new DraftError('conflict');
  }

  const stage = path.join(root, `.stage-${draftId}-${crypto.randomBytes(6).toString('hex')}`);
  const written = [];
  let folder = stage;
  const cleanup = () => { // only files this call created, then the empty folder: no recursive delete
    for (const name of written) { try { fsApi.unlinkSync(path.join(folder, name)); } catch { /* already gone */ } }
    try { fsApi.rmdirSync(folder); } catch { /* absent or not empty */ }
  };
  try {
    fsApi.mkdirSync(stage);
    if (!sameName(path.dirname(fsApi.realpathSync(stage)), root)) throw new DraftError('unsafe_path');
    const copy = (from, name, cap) => {
      fsApi.copyFileSync(from, path.join(stage, name), fs.constants.COPYFILE_EXCL);
      written.push(name);
      if (fsApi.statSync(path.join(stage, name)).size > cap) throw new DraftError('too_large');
    };
    copy(videoFile, 'video.mp4', LIMITS.videoBytes);
    if (fileSha256(path.join(stage, 'video.mp4'), fsApi) !== sourceSha) throw new DraftError('bad_artifact'); // the source changed while it was copied
    copy(resolveEpisodeFile(dir, 'final/probe.json', { exts: ['.json'], maxBytes: LIMITS.probeBytes, label: 'probe' }), 'probe.json', LIMITS.probeBytes);
    if (posterFile) copy(posterFile, posterName, LIMITS.posterBytes);
    fsApi.writeFileSync(path.join(stage, '.metadata.partial'), metadataText, { flag: 'wx' });
    written.push('.metadata.partial');
    fsApi.renameSync(stage, target);
    folder = target;
    // metadata.json is what makes a folder a draft: it appears last, atomically, in a folder that is already complete.
    fsApi.renameSync(path.join(target, '.metadata.partial'), path.join(target, 'metadata.json'));
  } catch (error) {
    cleanup();
    if (error instanceof DraftError) throw error;
    throw new DraftError('internal');
  }
  return { created: true, draftId, metadata };
}

// The 'draft' stage engine for the Episode state machine: it runs toDraft and records what it made in draft.json.
// The stage runs only after finish is complete and the animatic gate is open, which is what toDraft checks again.
export function createDraftEngine({ root, channelId, draftsDir, getChannel, resolveChannel, now, aiDisclosure, aspect, engines } = {}) {
  if (typeof root !== 'string' || !root) throw new Error('the draft engine needs the episodes root folder');
  const engine = async ({ episode }) => {
    const result = toDraft({ episodeDir: episode.id, channelId, episodesRoot: root, ...(draftsDir && { draftsDir }), ...(getChannel && { getChannel }), ...(resolveChannel && { resolveChannel }), ...(now && { now }), ...(aiDisclosure !== undefined && { aiDisclosure }), ...(aspect && { aspect }), ...(engines && { engines }) });
    return { 'draft.json': { state: 'draft', ready: true, draftId: result.draftId, channelId, finalSha256: result.metadata.episode_draft.final_sha256 } };
  };
  engine.version = DRAFT_VERSION;
  return engine;
}
