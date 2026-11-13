import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson, deepFreeze } from '../lib/objects.js';
const artifactHashCache = new Map();
function fileHash(filePath) { if (!filePath || typeof filePath !== 'string') return null; try { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); } catch { return null; } }
function artifactHash(filePath) {
  const stat = fs.statSync(filePath);
  const cached = artifactHashCache.get(filePath);
  if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.sha256;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  artifactHashCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
  if (artifactHashCache.size > 512) artifactHashCache.delete(artifactHashCache.keys().next().value);
  return sha256;
}
function parseRate(value) { const [n, d] = String(value || '').split('/').map(Number); return Number.isFinite(n) ? (d ? n / d : n) : 0; }
// Runs ffprobe (FFPROBE_PATH, else the one on PATH: the dashboard container has it). Any failure means "not verified".
export function ffprobeArtifact(file, { exe = process.env.FFPROBE_PATH || 'ffprobe', args = [] } = {}) {
  try {
    const out = JSON.parse(execFileSync(exe, [...args, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    const video = out.streams?.find((stream) => stream.codec_type === 'video');
    const width = Number(video?.width); const height = Number(video?.height);
    if (!(width > 0 && height > 0)) return { status: 'failed', error: 'no decodable video or image stream' };
    if (/\.(?:png|jpe?g)$/i.test(file)) return { status: 'verified', type: 'image', width, height, fps: null, duration: null };
    const duration = Number(out.format?.duration ?? video.duration); const fps = parseRate(video.avg_frame_rate || video.r_frame_rate);
    if (!(duration > 0 && fps > 0)) return { status: 'failed', error: 'video has no duration or frame rate' };
    return { status: 'verified', type: 'video', width, height, fps, duration };
  } catch (err) { return { status: 'failed', error: String(err.message || err).split('\n')[0].slice(0, 200) }; }
}
let prober = ffprobeArtifact;
export function setArtifactProber(fn) { prober = fn || ffprobeArtifact; } // tests inject an offline prober

const HEX_SHA = /^[0-9a-f]{7,40}$/i;

function readGitRef(gitDir, commonDir, refName) {
  if (!refName || typeof refName !== 'string' || refName.includes('..') || path.isAbsolute(refName)) return '';
  for (const base of [gitDir, commonDir]) {
    try {
      const content = fs.readFileSync(path.join(base, refName), 'utf8').trim();
      if (HEX_SHA.test(content)) return content.slice(0, 12).toLowerCase();
    } catch {}
  }
  for (const base of [commonDir, gitDir]) {
    try {
      const content = fs.readFileSync(path.join(base, 'packed-refs'), 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^')) continue;
        const spaceIdx = trimmed.indexOf(' ');
        if (spaceIdx === -1) continue;
        const sha = trimmed.slice(0, spaceIdx).trim();
        const name = trimmed.slice(spaceIdx + 1).trim();
        if (name === refName && HEX_SHA.test(sha)) return sha.slice(0, 12).toLowerCase();
      }
    } catch {}
  }
  return '';
}

function findGitEntry(startDir, boundedToStart = false) {
  let cur = path.resolve(startDir);
  const maxLevels = boundedToStart ? 1 : 5;
  for (let i = 0; i < maxLevels; i++) {
    const candidate = path.join(cur, '.git');
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory() || stat.isFile()) {
        return { path: candidate, isFile: stat.isFile() };
      }
    } catch {}
    if (boundedToStart) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function resolveFsGitHead(gitEntry) {
  try {
    let gitDir = gitEntry.path;
    let commonDir = gitDir;

    if (gitEntry.isFile) {
      const content = fs.readFileSync(gitEntry.path, 'utf8');
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (!match) return '';
      gitDir = path.resolve(path.dirname(gitEntry.path), match[1].trim());
      commonDir = gitDir;
      try {
        const commondir = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
        if (commondir) commonDir = path.resolve(gitDir, commondir);
      } catch {}
    }

    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head) return '';
    if (HEX_SHA.test(head)) return head.slice(0, 12).toLowerCase();
    const refMatch = head.match(/^ref:\s*(.+)$/);
    if (!refMatch) return '';
    return readGitRef(gitDir, commonDir, refMatch[1].trim());
  } catch {
    return '';
  }
}

function resolveCheckoutHead(dir, boundedToDir = false) {
  if (!dir || typeof dir !== 'string') return '';
  const gitEntry = findGitEntry(dir, boundedToDir);
  if (!gitEntry) return '';
  try {
    const out = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: path.dirname(gitEntry.path),
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (HEX_SHA.test(out)) return out.slice(0, 12).toLowerCase();
  } catch {}
  return resolveFsGitHead(gitEntry);
}

export function gitHead(env = process.env) {
  if (env?.FORGEAI_ROOT) {
    return resolveCheckoutHead(env.FORGEAI_ROOT, true);
  }
  return resolveCheckoutHead(path.dirname(fileURLToPath(import.meta.url)), false);
}

let defaultVersion;
// Build SHA from FORGEAI_BUILD_SHA, else the checkout's git HEAD, else the explicit string 'unknown' (never a package version).
export function codeVersion(env = process.env, head = gitHead) {
  if (env?.FORGEAI_BUILD_SHA) return env.FORGEAI_BUILD_SHA;
  if (env === process.env && head === gitHead) return (defaultVersion ??= gitHead(process.env) || 'unknown');
  return (head === gitHead ? gitHead(env) : head(env)) || 'unknown';
}

export function sceneInputIdentity(scene = {}, ctx = {}) {
  const referenceHash = ctx.referenceHash || fileHash(ctx.referencePath || ctx.reference_image || ctx.reference_path);
  const input = {
    prompt: ctx.effectivePrompt ?? ctx.prompt ?? scene.effectivePrompt ?? scene.prompt ?? scene.still_prompt ?? scene.motion_prompt ?? scene.text ?? '',
    seed: ctx.seed ?? scene.seed ?? null, still_seed: ctx.stillSeed ?? ctx.still_seed ?? scene.still_seed ?? null, video_seed: ctx.videoSeed ?? ctx.video_seed ?? scene.video_seed ?? null,
    reference_hash: referenceHash, backend: ctx.backend ?? null,
    fallback_identity: ctx.fallbackIdentity ?? null,
    workflow_model: ctx.workflowId ?? ctx.workflow_id ?? ctx.modelId ?? ctx.model_id ?? null,
    width: ctx.width ?? null, height: ctx.height ?? null, duration: ctx.duration ?? null, fps: ctx.fps ?? null,
    // Only keyed when provided: a legacy context must hash to the bytes it always had, or cached takes and approvals silently go stale.
    ...((ctx.assetPlanHash ?? ctx.asset_plan_hash) != null && { asset_plan_hash: ctx.assetPlanHash ?? ctx.asset_plan_hash }),
    ...((ctx.resolvedAssetHashes ?? ctx.resolved_asset_hashes) != null && { resolved_asset_hashes: ctx.resolvedAssetHashes ?? ctx.resolved_asset_hashes }),
    ...((ctx.backgroundAssets ?? ctx.background_assets) != null && { background_assets: ctx.backgroundAssets ?? ctx.background_assets }),
    ...(ctx.mechanismIdentity != null && { mechanism: ctx.mechanismIdentity }),
    style: ctx.style ?? null, viral_v1: ctx.viralV1 ?? ctx.viral_v1 ?? null,
    blender: ctx.blender ? { model_hash: ctx.blender.modelHash ?? crypto.createHash('sha256').update(JSON.stringify(canonicalJson(ctx.blender.model || null))).digest('hex'), assembly_hash: ctx.blender.assemblyHash ?? crypto.createHash('sha256').update(JSON.stringify(canonicalJson(ctx.blender.assembly || null))).digest('hex'), shots: ctx.blender.shots || [], setting: ctx.blender.setting ?? null, setting_material_asset_ids: ctx.blender.settingMaterialAssetIds ?? null, character_actions: ctx.blender.characterActions || ctx.blender.character_actions || [], props: ctx.blender.props || [] } : null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonicalJson(input))).digest('hex');
}

// Mechanism identity for a request, keyed into sceneInputIdentity only when provided. Groups: assets (profile, definition, controller,
// source package, receipts), audio_timing (narration, audio, timing) and caption. Missing or malformed parts become null, so filling one in later changes the digest.
// Mechanism identity is consumed by the Studio render path; capability acceptance remains server-owned.
const SHA256_HEX = /^[0-9a-f]{64}$/;
const shaOrNull = (value) => (typeof value === 'string' && SHA256_HEX.test(value) ? value : null);
const textOrNull = (value) => (typeof value === 'string' && value.trim() ? value : null);
const profileOrNull = (value) => (value && typeof value === 'object' && !Array.isArray(value) && value.version === 1 && typeof value.subject_id === 'string' ? canonicalJson(value) : null);

export function buildMechanismIdentity(parts) {
  const { profile, definitionHash, controllerId, sourcePackageHash, assetReceiptHashes, audioSha256, timingSha256, narrationSha256, captionSha256, look } = parts ?? {};
  return deepFreeze({
    assets: {
      profile: profileOrNull(profile), definition_hash: shaOrNull(definitionHash), controller_id: textOrNull(controllerId), source_package_hash: shaOrNull(sourcePackageHash),
      asset_receipt_hashes: Array.isArray(assetReceiptHashes) ? assetReceiptHashes.map(shaOrNull).sort() : null,
    },
    audio_timing: { narration_sha256: shaOrNull(narrationSha256), audio_sha256: shaOrNull(audioSha256), timing_sha256: shaOrNull(timingSha256) },
    caption: { caption_sha256: shaOrNull(captionSha256) },
    ...(look !== undefined && { renderer: { look: textOrNull(look) } }),
  });
}

// Which products a change between two mechanism identities invalidates. Caption-only changes touch captions alone; narration or timing changes
// invalidate audio, timing and compiled motion; renderer changes invalidate rendered motion; profile, definition, controller, source or receipt changes invalidate assets and motion.
export function mechanismInvalidation(oldIdentity, newIdentity) {
  const changed = (group) => JSON.stringify(canonicalJson(oldIdentity?.[group] ?? null)) !== JSON.stringify(canonicalJson(newIdentity?.[group] ?? null));
  const audioTiming = changed('audio_timing');
  const assets = changed('assets');
  return { captions: changed('caption'), audio_timing: audioTiming, motion: audioTiming || assets || changed('renderer'), assets };
}

// KAN-777 (semantic_explainer_v1): what a semantic explanation was built from. Groups: source (registered asset id and the hashes of asset.json, explanation.json
// and the model file), audio_timing (narration, audio, timing), plan (the envelope sent to the worker), skill (hash of the rules digest the stages saw),
// adapter (worker route and schema) and implementation (code version). Any group changing makes a cached render and its review stale: a review never carries over.
export function buildSemanticIdentity(parts) {
  const { source, audioSha256, timingSha256, narrationSha256, envelope, skillDigestSha256, adapter, implementation, resolution } = parts ?? {};
  const files = source?.files && typeof source.files === 'object' && !Array.isArray(source.files) ? Object.fromEntries(Object.entries(source.files).map(([k, v]) => [k, shaOrNull(v)]).sort(([a], [b]) => (a < b ? -1 : 1))) : null;
  return deepFreeze({
    source: { asset: textOrNull(source?.asset), source_sha256: shaOrNull(source?.source_sha256), files },
    audio_timing: { narration_sha256: shaOrNull(narrationSha256), audio_sha256: shaOrNull(audioSha256), timing_sha256: shaOrNull(timingSha256) },
    plan: { envelope_sha256: envelope == null ? null : crypto.createHash('sha256').update(JSON.stringify(canonicalJson(envelope))).digest('hex'), resolution_percent: Number.isInteger(resolution) ? resolution : null }, // KAN-777: the render size is part of the plan (stage, fps and frames are in the envelope)
    skill: { digest_sha256: shaOrNull(skillDigestSha256) },
    adapter: { name: textOrNull(adapter?.name), schema: textOrNull(adapter?.schema), version: Number.isInteger(adapter?.version) ? adapter.version : null },
    implementation: { code_version: textOrNull(implementation) },
  });
}
export const semanticIdentityHash = (identity) => crypto.createHash('sha256').update(JSON.stringify(canonicalJson(identity ?? null))).digest('hex');
// Which groups differ between a stored identity and the current one. Any difference (or a missing stored identity) invalidates the cached render and the review.
export function semanticInvalidation(oldIdentity, newIdentity) {
  const changed = (group) => JSON.stringify(canonicalJson(oldIdentity?.[group] ?? null)) !== JSON.stringify(canonicalJson(newIdentity?.[group] ?? null));
  const groups = Object.fromEntries(['source', 'audio_timing', 'plan', 'skill', 'adapter', 'implementation'].map((g) => [g, changed(g)]));
  const stale = oldIdentity == null || Object.values(groups).some(Boolean);
  return { ...groups, cache: stale, review: stale };
}

function recordPath(draftDir, sceneId) { const safeId = String(sceneId).replace(/[^a-zA-Z0-9_.-]/g, '_'); return path.join(draftDir, 'scenes', `${safeId}.provenance.json`); }
function saveRecord(draftDir, sceneId, output) {
  const target = recordPath(draftDir, sceneId); fs.mkdirSync(path.dirname(target), { recursive: true }); const temp = `${target}.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify(output, null, 2)); fs.renameSync(temp, target); return output;
}
export function writeSceneRecord(draftDir, sceneId, record = {}) {
  const artifactPath = record.artifact ? path.resolve(draftDir, record.artifact) : null;
  let artifactSha = record.artifact_sha256 || null;
  if (artifactPath) { try { artifactSha = artifactHash(artifactPath); } catch { artifactSha = null; } }
  return saveRecord(draftDir, sceneId, { version: 1, requested: record.requested ?? null, actual: record.actual ?? 'unknown', artifact: record.artifact ?? null, artifact_sha256: artifactSha, input_identity: record.input_identity ?? null, status: record.status ?? 'completed', fallback_reason: record.fallback_reason ?? null, ...(record.render_evidence && { render_evidence: record.render_evidence }), ...(record.selected_background_assets && { selected_background_assets: record.selected_background_assets }), timing_ms: Number.isFinite(record.timing_ms) ? record.timing_ms : null, code_version: record.code_version ?? codeVersion(), probe: artifactPath && artifactSha ? prober(artifactPath) : { status: 'failed', error: 'artifact missing' } });
}
// One take or render can cover several scenes: probe it once, then give every id (stage record and per-scene "current" alias) the same record.
export function writeSceneRecords(draftDir, sceneIds, record = {}) {
  const [first, ...rest] = sceneIds; const output = writeSceneRecord(draftDir, first, record);
  for (const id of rest) saveRecord(draftDir, id, output);
  return output;
}
// A reused artifact becomes the scene's current one: copy its stage record over the per-scene alias.
export function selectSceneRecord(draftDir, sceneId, sourceId) {
  try { saveRecord(draftDir, sceneId, JSON.parse(fs.readFileSync(recordPath(draftDir, sourceId), 'utf8'))); } catch {}
}
export function clearSceneRecord(draftDir, sceneId) { fs.rmSync(recordPath(draftDir, sceneId), { force: true }); }

// The record for one scene id, only if it is complete, its renderer is known, its probe verified and its file still hashes to the recorded value.
function verifiedRecord(draftDir, sceneId, hashes = new Map()) {
  try {
    const record = JSON.parse(fs.readFileSync(recordPath(draftDir, sceneId), 'utf8'));
    if (record.version !== 1 || record.status !== 'completed' || record.actual === 'unknown' || !record.code_version || record.probe?.status !== 'verified' || !record.artifact || !record.artifact_sha256) return null;
    const artifact = path.resolve(draftDir, record.artifact); const relative = path.relative(path.resolve(draftDir), artifact); if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const stat = fs.statSync(artifact); if (!stat.isFile() || stat.size === 0) return null;
    if (!hashes.has(artifact)) hashes.set(artifact, crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'));
    return hashes.get(artifact) === record.artifact_sha256 ? { record, artifact } : null;
  } catch { return null; }
}
export function reusableArtifact(draftDir, sceneId, identity) {
  const found = verifiedRecord(draftDir, sceneId);
  return found && found.record.input_identity === identity ? found.artifact : null;
}

export function hasUnverifiedArtifacts(draftDir) {
  const media = /\.(?:mp4|webm|png|jpg|jpeg)$/i;
  const recordedArtifacts = new Set();
  const hashes = new Map();
  let records = [];
  try { records = fs.readdirSync(path.join(draftDir, 'scenes')).filter((name) => name.endsWith('.provenance.json')); } catch {}
  for (const name of records) {
    const found = verifiedRecord(draftDir, name.slice(0, -'.provenance.json'.length), hashes);
    if (found) recordedArtifacts.add(found.artifact);
  }
  for (const folder of [draftDir, path.join(draftDir, 'scenes')]) {
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile() && media.test(entry.name) && (/^scene_\d+/i.test(entry.name) || /^render(?:_|\.)/i.test(entry.name) || (folder.endsWith(`${path.sep}scenes`) && /^take_/i.test(entry.name)))); } catch {}
    if (entries.some((entry) => !recordedArtifacts.has(path.resolve(folder, entry.name)))) return true;
  }
  return false;
}

// What was asked for versus what really rendered, one entry per planned scene: `scenes` is [{ id, requested }] where id names the scene's
// current record and requested is what the plan asked for before any fallback. A scene without a valid current record is `unverified`, never guessed.
// The same artifact may back several scenes (one Blender take over six scenes is six 3D scenes). Stage records of replaced artifacts are ignored.
export function summarizeProvenance(draftDir, scenes) {
  if (!scenes?.length) return null;
  const summary = { planned: scenes.length, requested: {}, actual: {}, unverified: 0, fallbacks: 0, fallback_reasons: [] };
  const hashes = new Map();
  for (const { id, requested } of scenes) {
    const found = verifiedRecord(draftDir, id, hashes);
    const wanted = requested ?? found?.record.requested;
    if (wanted) summary.requested[wanted] = (summary.requested[wanted] || 0) + 1;
    if (!found) { summary.unverified += 1; continue; }
    const { record } = found;
    summary.actual[record.actual] = (summary.actual[record.actual] || 0) + 1;
    if (record.fallback_reason || (wanted && wanted !== record.actual)) { summary.fallbacks += 1; if (record.fallback_reason && !summary.fallback_reasons.includes(record.fallback_reason)) summary.fallback_reasons.push(record.fallback_reason); }
  }
  return summary;
}
