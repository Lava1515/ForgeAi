// KAN-778 (semantic_explainer_v1): the server-validated review receipt a semantic explainer draft needs before anything leaves ForgeAI (direct publish,
// scheduled upload and its release, future-upload enablement) and the status the queue/Library show. Ordinary drafts (no semantic provenance) never reach this
// code path's checks: isSemanticDraft() is false and every consumer behaves exactly as before.
//
// A receipt is issued only by issueReceipt(): the client sends the human checks (reviewer + evidence per check) and NOTHING else. Identities, machine QA and the
// timestamp are computed here, so a client boolean, identity or timestamp cannot forge acceptance. The gate recomputes the identities from the files on disk on
// every call and compares them with the ones bound into the receipt: any difference makes it stale. Nothing here ever auto-marks a check passed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { semanticSourceIdentity, semanticAssetsDir } from './model3d.js';
import { codeVersion, semanticIdentityHash } from './sceneProvenance.js';
import { canonicalJson } from '../lib/objects.js';
import { isEpisodeDraft, episodeGate, episodeReviewOf } from './episodeReview.js'; // KAN-828: Episode drafts carry their own receipt; this file only dispatches

export const RECEIPT_FILE = 'semantic_review.json';
export const RECORD_FILE = 'semantic.json'; // written by POST /api/studio/semantic (KAN-777)
// The independent human checks (names follow the skill's review checklist). Machine QA is read from the worker answer, never from the client.
export const HUMAN_CHECKS = Object.freeze(['content_evidence', 'extraction_paths', 'operating_mechanism', 'camera_labels', 'cutaways_reveals', 'narration_sync', 'audio_listened']);
export const MACHINE_GATES = Object.freeze(['conservation_passed', 'working_copies_match_source', 'saved_blend_ok', 'framing_passed', 'aspect_9_16', 'motion_passed']);
export const REVIEW_LIMITS = Object.freeze({ bodyBytes: 32 * 1024, name: 80, notes: 1000, evidenceMin: 10, evidence: 1000, outcomes: 256, outcome: 300 });
export const STATUS = Object.freeze({ PREVIEW_ONLY: 'preview-only', NEEDS_REVIEW: 'needs_review', READY: 'ready' });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const canonHash = (v) => sha(JSON.stringify(canonicalJson(v ?? null)));
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const fileSha = (file) => { try { const st = fs.statSync(file); return st.isFile() && st.size > 0 ? sha(fs.readFileSync(file)) : null; } catch { return null; } };
const blocker = (code, message) => ({ code, message });

// Strict marker (=== true), a semantic provenance object, an existing receipt, or the KAN-777 record next to the metadata.
export function isSemanticDraft({ folder, meta } = {}) {
  if (!isObj(meta)) return false;
  if (meta.semantic_explainer_v1 === true || meta.semantic != null || meta.semantic_review != null) return true;
  if (isEpisodeDraft({ meta })) return true; // KAN-828
  if (!folder) return false;
  return fs.existsSync(path.join(folder, RECORD_FILE)) || fs.existsSync(path.join(folder, RECEIPT_FILE));
}

// ---- the request body: reviewer + checks only ------------------------------------------------------------------------------------------------
const NO_REVIEW_HAZARDS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;
const NO_RECEIPT_HAZARDS = /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;
function text(value, what, max, min = 1, { reviewer = false } = {}) {
  if (typeof value !== 'string') return `${what} must be a string`;
  const t = value.trim();
  if (t.length < min) return `${what} must be at least ${min} characters`;
  if (t.length > max || (reviewer ? NO_REVIEW_HAZARDS : NO_RECEIPT_HAZARDS).test(value)) return `${what} must be at most ${max} characters without control characters or formatting characters`;
  return null;
}
// -> { error } | { value: { reviewer, notes, checks: { name: { reviewer, evidence, candidate_outcomes? } } } }. Unknown keys (identities, timestamps, `reviewed`,
// `passed`, __proto__, ...) are refused, so a client cannot say anything the server computes.
export function parseReviewBody(body) {
  if (!isObj(body)) return { error: 'semantic_review must be an object' };
  let size = 0;
  try { size = JSON.stringify(body).length; } catch { return { error: 'semantic_review is not valid JSON' }; }
  if (size > REVIEW_LIMITS.bodyBytes) return { error: `semantic_review is over ${REVIEW_LIMITS.bodyBytes} bytes` };
  const bad = [];
  const extra = Object.keys(body).filter((k) => !['reviewer', 'notes', 'checks'].includes(k));
  if (extra.length) bad.push(`unknown semantic_review keys: ${extra.map((k) => JSON.stringify(k)).join(', ')} (identities, QA results and timestamps are computed by the server)`);
  const e = text(body.reviewer, 'reviewer', REVIEW_LIMITS.name, 1, { reviewer: true }); if (e) bad.push(e);
  if (body.notes !== undefined) { const n = text(body.notes, 'notes', REVIEW_LIMITS.notes); if (n) bad.push(n); }
  const checks = {};
  if (!isObj(body.checks)) bad.push('checks must be an object');
  else {
    const names = Object.keys(body.checks);
    const unknown = names.filter((k) => !HUMAN_CHECKS.includes(k));
    if (unknown.length) bad.push(`unknown checks: ${unknown.map((k) => JSON.stringify(k)).join(', ')}`);
    for (const name of HUMAN_CHECKS) {
      if (!Object.hasOwn(body.checks, name)) continue; // a missing check is reported by the gate as a blocker; never defaulted to passed
      const c = body.checks[name];
      if (!isObj(c)) { bad.push(`${name} must be an object`); continue; }
      const cExtra = Object.keys(c).filter((k) => !['reviewer', 'evidence', 'candidate_outcomes'].includes(k));
      if (cExtra.length) bad.push(`${name}: unknown keys ${cExtra.map((k) => JSON.stringify(k)).join(', ')}`);
      const ev = text(c.evidence, `${name}.evidence`, REVIEW_LIMITS.evidence, REVIEW_LIMITS.evidenceMin); if (ev) bad.push(ev);
      if (c.reviewer !== undefined) { const r = text(c.reviewer, `${name}.reviewer`, REVIEW_LIMITS.name, 1, { reviewer: true }); if (r) bad.push(r); }
      let outcomes;
      if (c.candidate_outcomes !== undefined) {
        if (name !== 'extraction_paths') bad.push(`${name}: candidate_outcomes belongs to extraction_paths`);
        else if (!Array.isArray(c.candidate_outcomes) || c.candidate_outcomes.length > REVIEW_LIMITS.outcomes) bad.push(`candidate_outcomes must be a list of at most ${REVIEW_LIMITS.outcomes} strings`);
        else { outcomes = c.candidate_outcomes.map((o) => (typeof o === 'string' ? o.trim() : '')); if (outcomes.some((o, i) => text(c.candidate_outcomes[i], 'outcome', REVIEW_LIMITS.outcome))) bad.push('every candidate outcome must be a non-empty string'); }
      }
      checks[name] = { reviewer: typeof c.reviewer === 'string' ? c.reviewer.trim() : (typeof body.reviewer === 'string' ? body.reviewer.trim() : ''), evidence: typeof c.evidence === 'string' ? c.evidence.trim() : '', ...(outcomes && { candidate_outcomes: outcomes }) };
    }
  }
  if (bad.length) return { error: `semantic_review rejected:\n${bad.map((p) => `- ${p}`).join('\n')}` };
  return { value: { reviewer: body.reviewer.trim(), notes: typeof body.notes === 'string' ? body.notes.trim() : '', checks } };
}

// ---- identities recomputed from disk ------------------------------------------------------------------------------------------------------------
// -> { record, binding, blockers, facts }. `binding` is what a receipt is bound to; `blockers` are the reasons the current files cannot be reviewed at all.
export async function currentState({ draftId, folder, meta }, deps = {}) {
  const { sourceIdentity = semanticSourceIdentity, assetsRoot, version = () => codeVersion() } = deps;
  const blockers = [];
  const record = readJson(path.join(folder, RECORD_FILE));
  if (!isObj(record) || record.version !== 1 || !isObj(record.identity) || !isObj(record.result)) {
    return { record: null, binding: null, facts: {}, blockers: [blocker('record_missing', `${RECORD_FILE} (the POST /api/studio/semantic record) is missing or unreadable, so there is nothing to review`)] };
  }
  const { identity, result } = record;
  if (record.stage !== 'render' || record.status !== 'preview_ready') blockers.push(blocker('no_preview', `the explanation is ${JSON.stringify(record.status)} at stage ${JSON.stringify(record.stage)}, not a rendered preview`));
  if (semanticIdentityHash(identity) !== record.review?.identity_hash) blockers.push(blocker('record_inconsistent', `${RECORD_FILE} identity does not match its recorded identity hash`));
  // machine QA: the worker answer in the record, never anything the client said
  const qa = isObj(result.qa) ? result.qa : {};
  for (const gate of MACHINE_GATES) if (qa[gate] !== true) blockers.push(blocker(`qa_${gate}`, `machine QA ${gate} did not pass`));
  // source: the registered files hashed now
  let source = null;
  try { source = await sourceIdentity(record.asset, assetsRoot ? { assetsRoot } : undefined); } catch (err) { blockers.push(blocker('source_unavailable', `the source asset cannot be read: ${err.message}`)); }
  if (source && canonHash({ asset: source.asset, source_sha256: source.source_sha256, files: source.files }) !== canonHash({ asset: identity.source?.asset, source_sha256: identity.source?.source_sha256, files: identity.source?.files })) {
    blockers.push(blocker('source_changed', 'the source model, asset.json or inventory changed since this preview was built; rebuild the preview'));
  }
  // audio and timing: the files in the draft folder
  const audioFile = path.join(folder, path.basename(String(meta?.audio_file || 'voiceover.wav')));
  const audioSha = fileSha(audioFile);
  if (!audioSha) blockers.push(blocker('audio_missing', 'the voice-over file is missing or empty'));
  else if (identity.audio_timing?.audio_sha256 && audioSha !== identity.audio_timing.audio_sha256) blockers.push(blocker('audio_changed', 'the voice-over changed since this preview was built'));
  const tts = readJson(path.join(folder, 'semantic_tts.json'));
  const timingSha = isObj(tts) ? sha(JSON.stringify({ words: tts.words, scenes: tts.scenes, duration: tts.duration, source: tts.word_timing_source, coverage: tts.word_timing_coverage, fps: record.edit?.fps })) : null;
  if (!timingSha) blockers.push(blocker('timing_missing', 'the measured narration timing (semantic_tts.json) is missing'));
  else if (identity.audio_timing?.timing_sha256 && timingSha !== identity.audio_timing.timing_sha256) blockers.push(blocker('timing_changed', 'the measured narration timing changed since this preview was built'));
  // preview: the video the draft would publish
  const previewSha = meta?.video_file ? fileSha(path.join(folder, path.basename(String(meta.video_file)))) : null;
  if (!previewSha) blockers.push(blocker('preview_missing', 'the draft has no preview video to review'));
  // render code
  const code = version();
  if (identity.implementation?.code_version && code !== identity.implementation.code_version) blockers.push(blocker('render_code_changed', `the render code changed (${identity.implementation.code_version} -> ${code}); rebuild the preview`));
  // fixtures and candidates
  let spec = null, inventory = null;
  if (source) { const dir = path.join(assetsRoot || semanticAssetsDir(), record.asset); spec = readJson(path.join(dir, 'asset.json')); inventory = readJson(path.join(dir, 'explanation.json')); }
  const flagged = (o) => isObj(o) && (o.synthetic === true || o.fixture === true || o.origin === 'synthetic' || o.kind === 'fixture');
  if (flagged(spec) || flagged(inventory) || /^(synthetic|fixture)[_-]/.test(String(record.asset))) blockers.push(blocker('synthetic_fixture', 'this explains a synthetic fixture; it is never accepted as a real-product explanation'));
  const pairs = new Set();
  for (const row of Array.isArray(qa.aabb_candidates) ? qa.aabb_candidates : []) for (const pair of Array.isArray(row?.candidate_pairs) ? row.candidate_pairs : []) pairs.add(JSON.stringify(pair));
  const binding = {
    identity_hash: semanticIdentityHash(identity),
    source: { asset: record.asset, source_sha256: source?.source_sha256 ?? null },
    audio_sha256: audioSha, timing_sha256: timingSha, narration_sha256: identity.audio_timing?.narration_sha256 ?? null,
    plan_sha256: identity.plan?.envelope_sha256 ?? null, skill_sha256: identity.skill?.digest_sha256 ?? null,
    scene: { result_sha256: canonHash(result), blend_sha256: typeof result.scene_blend === 'string' ? fileSha(result.scene_blend) : null },
    preview_sha256: previewSha, render_code: code,
  };
  if (!binding.plan_sha256) blockers.push(blocker('plan_missing', 'the record has no plan identity'));
  return { record, binding, blockers, facts: { candidatePairs: pairs.size, qa, source, asset: record.asset, assetDir: source ? path.join(assetsRoot || semanticAssetsDir(), record.asset) : null } };
}

// ---- receipts ---------------------------------------------------------------------------------------------------------------------------------------
const receiptHash = (r) => canonHash({ ...r, receipt_sha256: undefined });
// Issues (writes) a receipt from the human checks, bound to the identities recomputed now. Refuses while the files themselves cannot be reviewed (a failing
// machine gate, a synthetic fixture, a changed source ...), and never fills in a check the reviewer did not give.
export async function issueReceipt(draft, body, deps = {}) {
  const parsed = parseReviewBody(body);
  if (parsed.error) return { ok: false, status: 400, error: parsed.error };
  const state = await currentState(draft, deps);
  if (state.blockers.length) return { ok: false, status: 409, error: 'The semantic preview cannot be reviewed yet.', blockers: state.blockers };
  const missing = HUMAN_CHECKS.filter((n) => !parsed.value.checks[n]);
  if (missing.length) return { ok: false, status: 422, error: `Every independent check needs a reviewer and evidence; missing: ${missing.join(', ')}.`, blockers: missing.map((n) => blocker(`check_${n}_missing`, `${n} was not recorded`)) };
  const now = (deps.now || (() => new Date()))().toISOString();
  const receipt = { version: 1, issued_at: now, reviewer: parsed.value.reviewer, notes: parsed.value.notes,
    checks: Object.fromEntries(HUMAN_CHECKS.map((n) => [n, { ...parsed.value.checks[n], at: now }])),
    machine_qa: Object.fromEntries(MACHINE_GATES.map((g) => [g, state.facts.qa[g] === true])), binding: state.binding };
  const tail = await evaluate(draft, deps, { receipt: { ...receipt, receipt_sha256: receiptHash(receipt) }, state });
  if (tail.blockers.length) return { ok: false, status: 409, error: 'The semantic preview cannot be accepted yet.', blockers: tail.blockers };
  receipt.receipt_sha256 = receiptHash(receipt);
  const tmp = path.join(draft.folder, `${RECEIPT_FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(receipt, null, 2));
  fs.renameSync(tmp, path.join(draft.folder, RECEIPT_FILE));
  return { ok: true, receipt, review: await evaluate(draft, deps) };
}
export function withdrawReceipt(draft) { fs.rmSync(path.join(draft.folder, RECEIPT_FILE), { force: true }); }

function receiptProblems(receipt, state) {
  const out = [];
  if (!isObj(receipt) || receipt.version !== 1 || !isObj(receipt.binding) || !isObj(receipt.checks)) return [blocker('receipt_invalid', 'the stored review receipt is unreadable')];
  if (receipt.receipt_sha256 !== receiptHash(receipt)) out.push(blocker('receipt_tampered', 'the review receipt does not match its own hash; it was edited by hand'));
  for (const name of HUMAN_CHECKS) {
    const c = receipt.checks[name];
    if (!isObj(c)) out.push(blocker(`check_${name}_missing`, `${name} was not recorded`));
    else if (typeof c.reviewer !== 'string' || !c.reviewer.trim() || typeof c.evidence !== 'string' || c.evidence.trim().length < REVIEW_LIMITS.evidenceMin || Number.isNaN(Date.parse(c.at))) out.push(blocker(`check_${name}_incomplete`, `${name} needs a reviewer, a timestamp and evidence`));
  }
  if (state.binding) {
    const groups = { source: ['source'], audio: ['audio_sha256', 'narration_sha256'], timing: ['timing_sha256'], plan: ['plan_sha256', 'skill_sha256', 'identity_hash'], scene: ['scene'], preview: ['preview_sha256'], render_code: ['render_code'] };
    for (const [group, keys] of Object.entries(groups)) {
      if (keys.some((k) => canonHash(receipt.binding[k]) !== canonHash(state.binding[k]))) out.push(blocker(`stale_${group}`, `the ${group.replace('_', ' ')} changed after the review; the receipt no longer applies`));
    }
  }
  const pairs = state.facts?.candidatePairs || 0;
  if (pairs > 0 && (receipt.checks.extraction_paths?.candidate_outcomes?.length || 0) < pairs) out.push(blocker('candidate_only', `${pairs} AABB overlap pair(s) are broad-phase candidates only; extraction_paths must record an outcome for each (candidate_outcomes)`));
  return out;
}

// -> { semantic: true, status, blockers, links, reviewed_by, reviewed_at }. Pure read: recomputes everything, writes nothing.
export async function evaluate(draft, deps = {}, pre = {}) {
  const state = pre.state || await currentState(draft, deps);
  const receipt = pre.receipt !== undefined ? pre.receipt : readJson(path.join(draft.folder, RECEIPT_FILE));
  const blockers = [...state.blockers];
  if (!receipt) blockers.push(blocker('review_missing', 'no independent review has been recorded for this preview'));
  else blockers.push(...receiptProblems(receipt, state));
  const unique = [...new Map(blockers.map((b) => [b.code, b])).values()];
  // preview-only: a clean preview nobody has reviewed yet; needs_review: anything that has to be fixed or redone first.
  const status = unique.length === 0 ? STATUS.READY : (!receipt && !state.blockers.length) ? STATUS.PREVIEW_ONLY : STATUS.NEEDS_REVIEW;
  return { semantic: true, status, ready: unique.length === 0, blockers: unique, links: links(draft, state), ...(receipt && isObj(receipt) && { reviewed_by: receipt.reviewer, reviewed_at: receipt.issued_at }) };
}

function links({ draftId, folder, meta }, state) {
  const r = state.record?.result || {};
  const local = (name) => (name && fs.existsSync(path.join(folder, path.basename(String(name)))) ? `/api/drafts/media/${draftId}/${path.basename(String(name))}` : undefined);
  const dir = state.facts?.assetDir;
  return {
    source: state.record ? { asset: state.record.asset, model_file: state.record.metadata?.source?.model_file ?? null, path: dir ? path.join(dir, String(state.record.metadata?.source?.model_file || '')) : null } : null,
    scene_blend: typeof r.scene_blend === 'string' ? r.scene_blend : null,
    inventory: dir ? path.join(dir, 'explanation.json') : null,
    evidence: dir ? path.join(dir, 'asset.json') : null,
    preview: { video_url: local(meta?.video_file) ?? null, frames_dir: r.frames_dir ?? null },
    qa: typeof r.qa_path === 'string' ? r.qa_path : null,
  };
}

// What the queue and Library show for a semantic draft; never throws.
export async function semanticReviewOf(draft, deps = {}) {
  if (isEpisodeDraft(draft)) return episodeReviewOf(draft); // KAN-828
  try { return await evaluate(draft, deps); } catch (err) { return { semantic: true, status: STATUS.NEEDS_REVIEW, ready: false, blockers: [blocker('review_error', `the review could not be evaluated: ${err.message}`)], links: null }; }
}
// The one call every publication consumer makes. null = not a semantic draft, or ready: proceed exactly as before. Otherwise the refusal body.
export async function semanticGate(draft, deps = {}) {
  if (isEpisodeDraft(draft)) return episodeGate(draft); // KAN-828: null when ready, a refusal body otherwise
  if (!isSemanticDraft(draft)) return null;
  const review = await semanticReviewOf(draft, deps);
  return review.ready ? null : { error: `This semantic explainer is ${review.status}: ${review.blockers.map((b) => b.message).join('; ')}.`, semantic_review: review };
}
// A list of drafts -> their DTOs with semantic_review added to semantic drafts only. Returns a plain array (synchronously) when no draft is semantic.
export function withSemanticReview(drafts, toItem, deps = {}) {
  if (!drafts.some(isSemanticDraft)) return drafts.map(toItem);
  return Promise.all(drafts.map(async (d) => (isSemanticDraft(d) ? { ...toItem(d), semantic_review: await semanticReviewOf(d, deps) } : toItem(d))));
}
