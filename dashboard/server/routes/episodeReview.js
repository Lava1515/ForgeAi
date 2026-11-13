// KAN-828: the review-receipt gate for Episode drafts (episode/toDraft.js writes metadata.episode_draft). It plugs into routes/semanticReview.js, which is the one
// place every upload path asks (publish, scheduled release, future-upload, the Library/queue status). A draft without `episode_draft` never reaches this code.
//
// A receipt (episode_review.json) is issued only by issueEpisodeReceipt(): the client sends the reviewer and one piece of evidence per human check and NOTHING
// else. Timestamps, identities and the binding are computed here from the files on disk, so a client cannot forge them. The binding is the sha256 of the
// draft's video.mp4 computed now plus the animatic approval hash; any change to the video makes the receipt stale, and a hand-edited receipt fails its own hash.
// This module imports nothing from semanticReview.js (that file imports this one).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalJson } from '../lib/objects.js';
import { codebuiltBlockers, claimsCodebuilt } from '../episode/codebuilt/bundle.js'; // KAN-923: code-built drafts also need their non-video files unchanged

export const EPISODE_RECEIPT_FILE = 'episode_review.json';
export const EPISODE_CHECKS = Object.freeze(['content_evidence', 'narration_sync', 'audio_listened']);
export const EPISODE_LIMITS = Object.freeze({ bodyBytes: 16 * 1024, name: 80, notes: 1000, evidenceMin: 10, evidence: 1000 });
export const EPISODE_STATUS = Object.freeze({ NEEDS_REVIEW: 'needs_review', READY: 'ready' });
const VIDEO = 'video.mp4';
const HEX64 = /^[0-9a-f]{64}$/;
const HAZARDS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠⁦-⁩﻿]/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const canonHash = (v) => crypto.createHash('sha256').update(JSON.stringify(canonicalJson(v ?? null))).digest('hex');
const receiptHash = (r) => canonHash({ ...r, receipt_sha256: undefined });
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const blocker = (code, message) => ({ code, message });

// The dispatch predicate semanticReview.js calls. A draft that claims to be code-built (engine, generation path or codebuilt key) is routed here even when its episode_draft
// key is missing or not version 1, so the gate runs and refuses it (codebuilt_marker) instead of treating it as an ordinary draft. Known residual: a draft with EVERY marker
// removed by hand is indistinguishable from an ordinary draft and stays one.
export function isEpisodeDraft({ meta } = {}) { return isObj(meta) && ((isObj(meta.episode_draft) && meta.episode_draft.version === 1) || claimsCodebuilt({ meta })); }

// sha256 of a regular, non-empty, non-linked file; null otherwise.
function videoSha(file) {
  let fd;
  try {
    const link = fs.lstatSync(file);
    if (!link.isFile() || link.isSymbolicLink() || link.size === 0) return null;
    fd = fs.openSync(file, 'r');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) { const n = fs.readSync(fd, buffer, 0, buffer.length, null); if (n === 0) break; hash.update(buffer.subarray(0, n)); }
    return hash.digest('hex');
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

// -> { binding, blockers }. `binding` is what a receipt is bound to; `blockers` are reasons the current files cannot be reviewed.
export function episodeCurrentState({ folder, meta } = {}) {
  const blockers = [];
  const marker = isObj(meta?.episode_draft) ? meta.episode_draft : {};
  for (const key of ['final_sha256', 'approved_gate_hash', 'finish_hash']) {
    if (typeof marker[key] !== 'string' || !HEX64.test(marker[key])) blockers.push(blocker(`marker_${key}`, `the Episode draft marker has no well-formed ${key}`));
  }
  const actual = folder ? videoSha(path.join(folder, VIDEO)) : null;
  if (!actual) blockers.push(blocker('video_missing', 'the draft has no video to review'));
  else if (marker.final_sha256 !== actual) blockers.push(blocker('stale_video', 'the draft video is not the video the Episode finished with; it changed after the draft was made'));
  blockers.push(...codebuiltBlockers({ folder, meta })); // KAN-923: [] for every ordinary Episode draft
  return { binding: { final_sha256: actual, approved_gate_hash: typeof marker.approved_gate_hash === 'string' ? marker.approved_gate_hash : null }, blockers };
}

function text(value, what, max, min = 1) {
  if (typeof value !== 'string') return `${what} must be a string`;
  const t = value.trim();
  if (t.length < min) return `${what} must be at least ${min} characters`;
  if (t.length > max || HAZARDS.test(value)) return `${what} must be at most ${max} characters without control characters or formatting characters`;
  return null;
}

// -> { error } | { value: { reviewer, notes, checks } }. Unknown keys (identities, timestamps, hashes, `passed`, __proto__ ...) are refused.
export function parseEpisodeReviewBody(body) {
  if (!isObj(body)) return { error: 'review must be an object' };
  let size = 0;
  try { size = JSON.stringify(body).length; } catch { return { error: 'review is not valid JSON' }; }
  if (size > EPISODE_LIMITS.bodyBytes) return { error: `review is over ${EPISODE_LIMITS.bodyBytes} bytes` };
  const bad = [];
  const extra = Object.keys(body).filter((k) => !['reviewer', 'notes', 'checks'].includes(k));
  if (extra.length) bad.push(`unknown review keys: ${extra.map((k) => JSON.stringify(k)).join(', ')} (identities, hashes and timestamps are computed by the server)`);
  const r = text(body.reviewer, 'reviewer', EPISODE_LIMITS.name); if (r) bad.push(r);
  if (body.notes !== undefined) { const n = text(body.notes, 'notes', EPISODE_LIMITS.notes); if (n) bad.push(n); }
  const checks = {};
  if (!isObj(body.checks)) bad.push('checks must be an object');
  else {
    const unknown = Object.keys(body.checks).filter((k) => !EPISODE_CHECKS.includes(k));
    if (unknown.length) bad.push(`unknown checks: ${unknown.map((k) => JSON.stringify(k)).join(', ')}`);
    for (const name of EPISODE_CHECKS) {
      if (!Object.hasOwn(body.checks, name)) continue; // reported as missing, never defaulted to passed
      const c = body.checks[name];
      if (!isObj(c)) { bad.push(`${name} must be an object`); continue; }
      const cExtra = Object.keys(c).filter((k) => !['reviewer', 'evidence'].includes(k));
      if (cExtra.length) bad.push(`${name}: unknown keys ${cExtra.map((k) => JSON.stringify(k)).join(', ')}`);
      const ev = text(c.evidence, `${name}.evidence`, EPISODE_LIMITS.evidence, EPISODE_LIMITS.evidenceMin); if (ev) bad.push(ev);
      if (c.reviewer !== undefined) { const cr = text(c.reviewer, `${name}.reviewer`, EPISODE_LIMITS.name); if (cr) bad.push(cr); }
      checks[name] = { reviewer: typeof c.reviewer === 'string' ? c.reviewer.trim() : (typeof body.reviewer === 'string' ? body.reviewer.trim() : ''), evidence: typeof c.evidence === 'string' ? c.evidence.trim() : '' };
    }
  }
  if (bad.length) return { error: `review rejected:\n${bad.map((p) => `- ${p}`).join('\n')}` };
  return { value: { reviewer: body.reviewer.trim(), notes: typeof body.notes === 'string' ? body.notes.trim() : '', checks } };
}

function receiptProblems(receipt, state) {
  if (!isObj(receipt) || receipt.version !== 1 || !isObj(receipt.binding) || !isObj(receipt.checks)) return [blocker('receipt_invalid', 'the stored review receipt is unreadable')];
  const out = [];
  if (typeof receipt.receipt_sha256 !== 'string' || receipt.receipt_sha256 !== receiptHash(receipt)) out.push(blocker('receipt_tampered', 'the review receipt does not match its own hash; it was edited by hand'));
  for (const name of EPISODE_CHECKS) {
    const c = receipt.checks[name];
    if (!isObj(c)) out.push(blocker(`check_${name}_missing`, `${name} was not recorded`));
    else if (typeof c.reviewer !== 'string' || !c.reviewer.trim() || typeof c.evidence !== 'string' || c.evidence.trim().length < EPISODE_LIMITS.evidenceMin || Number.isNaN(Date.parse(c.at))) out.push(blocker(`check_${name}_incomplete`, `${name} needs a reviewer, a timestamp and evidence`));
  }
  if (canonHash(receipt.binding) !== canonHash(state.binding) || !state.binding.final_sha256) out.push(blocker('stale_receipt', 'the video or its approval changed after the review; the receipt no longer applies'));
  return out;
}

// Pure read: recomputes everything, writes nothing. -> { episode: true, status, ready, blockers, links, reviewed_by?, reviewed_at? }
export function evaluateEpisode(draft, pre = {}) {
  const state = pre.state || episodeCurrentState(draft);
  const receipt = pre.receipt !== undefined ? pre.receipt : readJson(path.join(draft.folder, EPISODE_RECEIPT_FILE));
  const blockers = [...state.blockers];
  if (!receipt) blockers.push(blocker('review_missing', 'no independent review has been recorded for this Episode video'));
  else blockers.push(...receiptProblems(receipt, state));
  const unique = [...new Map(blockers.map((b) => [b.code, b])).values()];
  const ready = unique.length === 0;
  const video = draft.draftId && fs.existsSync(path.join(draft.folder, VIDEO)) ? `/api/drafts/media/${draft.draftId}/${VIDEO}` : null;
  return { episode: true, status: ready ? EPISODE_STATUS.READY : EPISODE_STATUS.NEEDS_REVIEW, ready, blockers: unique, links: { preview: { video_url: video } },
    ...(isObj(receipt) && { reviewed_by: receipt.reviewer, reviewed_at: receipt.issued_at }) };
}

export function episodeReviewOf(draft) {
  try { return evaluateEpisode(draft); } catch (err) { return { episode: true, status: EPISODE_STATUS.NEEDS_REVIEW, ready: false, blockers: [blocker('review_error', `the review could not be evaluated: ${err.message}`)], links: null }; }
}
// null = ready, proceed. Otherwise the refusal body (same shape as semanticGate's).
export function episodeGate(draft) {
  const review = episodeReviewOf(draft);
  return review.ready ? null : { error: `This Episode video is ${review.status}: ${review.blockers.map((b) => b.message).join('; ')}.`, semantic_review: review };
}

// Issues (writes) a receipt from the human checks, bound to the video and approval recomputed now. Refuses while the files cannot be reviewed.
export function issueEpisodeReceipt(draft, body, deps = {}) {
  const parsed = parseEpisodeReviewBody(body);
  if (parsed.error) return { ok: false, status: 400, error: parsed.error };
  const state = episodeCurrentState(draft);
  if (state.blockers.length) return { ok: false, status: 409, error: 'The Episode video cannot be reviewed yet.', blockers: state.blockers };
  const missing = EPISODE_CHECKS.filter((n) => !parsed.value.checks[n]);
  if (missing.length) return { ok: false, status: 422, error: `Every independent check needs a reviewer and evidence; missing: ${missing.join(', ')}.`, blockers: missing.map((n) => blocker(`check_${n}_missing`, `${n} was not recorded`)) };
  const now = (deps.now || (() => new Date()))().toISOString();
  const receipt = { version: 1, issued_at: now, reviewer: parsed.value.reviewer, notes: parsed.value.notes,
    checks: Object.fromEntries(EPISODE_CHECKS.map((n) => [n, { ...parsed.value.checks[n], at: now }])), binding: state.binding };
  receipt.receipt_sha256 = receiptHash(receipt);
  const tmp = path.join(draft.folder, `${EPISODE_RECEIPT_FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(receipt, null, 2));
  fs.renameSync(tmp, path.join(draft.folder, EPISODE_RECEIPT_FILE));
  return { ok: true, receipt, review: evaluateEpisode(draft) };
}
export function withdrawEpisodeReceipt(draft) { fs.rmSync(path.join(draft.folder, EPISODE_RECEIPT_FILE), { force: true }); }
