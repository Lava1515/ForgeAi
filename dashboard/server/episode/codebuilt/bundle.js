// KAN-923 (CB14): what a code-built draft is made of, and the on-disk drift check. This module imports nothing from routes/, so routes/episodeReview.js can use it
// (the Episode gate checks code-built drafts for drift on every path: publish, scheduled release, future-upload, the Library status, and receipt issue) without a cycle.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CODEBUILT_DRAFT_VERSION = 'codebuilt-draft-v1';
export const MB = 1024 * 1024;

// role -> where it lives in the job folder, its draft file name, size cap and content check. Contact sheets are added below.
const FIXED = Object.freeze({
  video: { from: 'final/video.mp4', to: 'video.mp4', cap: 512 * MB, kind: 'mp4' },
  code: { from: 'build/build.py', to: 'build.py', cap: 1 * MB, kind: 'text' },
  audio: { from: 'final/audio.wav', to: 'audio.wav', cap: 256 * MB, kind: 'wav' },
  subtitles: { from: 'final/subtitles.srt', to: 'subtitles.srt', cap: 1 * MB, kind: 'srt' },
  report: { from: 'final/report.json', to: 'report.json', cap: 1 * MB, kind: 'json' },
  contact_sheet: { from: 'final/contact_sheet.jpg', to: 'contact_sheet.jpg', cap: 20 * MB, kind: 'jpg' },
});
const EXTRA_SHEETS = 8;
function roleTable() {
  const table = { ...FIXED };
  for (let n = 2; n <= EXTRA_SHEETS + 1; n += 1) table[`contact_sheet_${n}`] = { from: `final/contact_sheet_${n}.jpg`, to: `contact_sheet_${n}.jpg`, cap: 20 * MB, kind: 'jpg', optional: true };
  return table;
}
export const ROLES = Object.freeze(roleTable());

// CB5 producer variant (narrative_factory/codebuilt/post/cb5.py, codebuilt-cb5-v1): the post step writes out/{video.mp4,subtitles.srt,contact_sheet.png,report.json}; the CB3
// mix is <job>/mix.wav; the build script stays <job>/build/build.py. The contact sheet there is a real PNG. It is kept as a PNG (never renamed to .jpg): the same
// `contact_sheet` role, with a second allowed draft file name. Every name below is fixed in code; nothing is taken from the producer's JSON.
export const CB5_REPORT_VERSION = 'codebuilt-cb5-v1';
export const CB5_SOURCES = Object.freeze({
  video: 'out/video.mp4', code: 'build/build.py', audio: 'out/audio/cb5-mix.wav', subtitles: 'out/subtitles.srt', report: 'out/report.json', contact_sheet: 'out/contact_sheet.png',
});
// codex · gpt-6.1-sol · 2026-11-14: selected only by the host video type; loop producer receipts are checked on copied bytes.
export const CB5_LOOP_SOURCES = Object.freeze(Object.fromEntries(Object.entries(CB5_SOURCES)
  .filter(([role]) => role !== 'subtitles').map(([role, source]) => [role, role === 'audio' ? 'out/audio/loop.wav' : source])));
export const CB5_PNG_SHEET = Object.freeze({ from: CB5_SOURCES.contact_sheet, to: 'contact_sheet.png', cap: 20 * MB, kind: 'png' });
// The spec a stored file entry must match: the role's own file, or (contact_sheet only) the PNG variant. null = not an expected file for that role.
export function specForFile(role, file) {
  if (!Object.hasOwn(ROLES, role)) return null;
  if (ROLES[role].to === file) return ROLES[role];
  if (role === 'contact_sheet' && file === CB5_PNG_SHEET.to) return CB5_PNG_SHEET;
  return null;
}

export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const blocker = (code, message) => ({ code, message });
const DRAFT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// The digest the receipt binds to. Names and hashes in a fixed order; a different set of files is a different digest.
export function bundleDigest(files) {
  return sha256(JSON.stringify({ v: CODEBUILT_DRAFT_VERSION, files: Object.keys(files).sort().map((role) => [role, files[role].sha256]) }));
}

// Links the draft exposes, rebuilt from the role table only: a stored link is never trusted. Every link is /api/drafts/media/<draft id>/<fixed file name>, so it can only
// resolve to a file directly inside the draft's own folder. An odd draft id (separator, dot segment, drive letter, absolute path) yields no links at all.
export function safeLinks(draftId, files) {
  if (typeof draftId !== 'string' || !DRAFT_ID.test(draftId) || draftId.includes('..') || !isObject(files)) return {};
  const links = {};
  for (const [role, entry] of Object.entries(files)) {
    if (isObject(entry) && specForFile(role, entry.file)) links[role] = `/api/drafts/media/${draftId}/${entry.file}`;
  }
  return links;
}

export function hashFile(file, fsApi = fs) {
  try {
    const stat = fsApi.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) return null;
    const hash = crypto.createHash('sha256');
    const fd = fsApi.openSync(file, 'r');
    try { const buffer = Buffer.alloc(MB); for (;;) { const n = fsApi.readSync(fd, buffer, 0, buffer.length, null); if (n === 0) break; hash.update(buffer.subarray(0, n)); } } finally { fsApi.closeSync(fd); }
    return hash.digest('hex');
  } catch { return null; }
}
export const isCodebuiltDraft = ({ meta } = {}) => isObject(meta) && isObject(meta.codebuilt) && meta.codebuilt.version === 1 && isObject(meta.episode_draft) && meta.episode_draft.version === 1;
// A draft that claims to be code-built in any way (the engine, the generation path, or the codebuilt key). Stripping one key does not turn it into an ordinary episode.
export const claimsCodebuilt = ({ meta } = {}) => isObject(meta) && (meta.engine === 'codebuilt' || meta.codebuilt !== undefined || (isObject(meta.generation_details) && meta.generation_details.path === 'codebuilt'));

// -> { ok, blockers }. Compares every file on disk with the hashes sealed in the marker. Writes nothing.
export function verifyCodebuiltDraft(draft, { fsApi = fs } = {}) {
  const blockers = [];
  if (!isCodebuiltDraft(draft)) return { ok: false, blockers: [blocker('not_codebuilt', 'not a code-built draft')] };
  const { files, bundle_sha256: sealed } = draft.meta.codebuilt;
  if (!isObject(files)) return { ok: false, blockers: [blocker('codebuilt_files', 'the code-built file list is unreadable')] };
  for (const [role, entry] of Object.entries(files)) {
    if (!isObject(entry) || !specForFile(role, entry.file)) { blockers.push(blocker(`codebuilt_${role}_unexpected`, `${role} is not an expected code-built file`)); continue; }
    const actual = hashFile(path.join(draft.folder, entry.file), fsApi);
    if (!actual) blockers.push(blocker(`codebuilt_${role}_missing`, `${role} is missing or not a plain file`));
    else if (actual !== entry.sha256) blockers.push(blocker(`codebuilt_${role}_changed`, `${role} changed after the draft was made; it needs a fresh review`));
  }
  for (const required of ['video', 'code', 'audio', ...(draft.meta.video_type === 'loop' ? [] : ['subtitles']), 'report', 'contact_sheet']) if (!isObject(files[required])) blockers.push(blocker(`codebuilt_${required}_missing`, `${required} is not part of the draft`));
  if (!blockers.length && (bundleDigest(files) !== sealed || draft.meta.episode_draft.approved_gate_hash !== sealed)) blockers.push(blocker('codebuilt_bundle', 'the draft bundle does not match its sealed digest'));
  return { ok: blockers.length === 0, blockers };
}

// For the Episode gate: [] for an ordinary Episode draft (nothing changes for it); drift blockers for a code-built one; a blocker for one that claims to be code-built
// but whose marker is unreadable (fails closed).
export function codebuiltBlockers(draft, deps = {}) {
  if (!claimsCodebuilt(draft)) return [];
  if (!isCodebuiltDraft(draft)) return [blocker('codebuilt_marker', 'the code-built draft marker is unreadable; it needs a fresh review')];
  return verifyCodebuiltDraft(draft, deps).blockers;
}
