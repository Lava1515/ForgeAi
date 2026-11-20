// "Send to uploader": ForgeAi hands a finished draft to the separate uploader (uploader/ in this repo) through a folder.
// ForgeAi writes   <share>/inbox/<draft id>/ video.mp4, manifest.json, then an empty READY file (READY last).
// The uploader writes <share>/results/<draft id>.json, which is read back here. Only the owner's button calls the send route.
// The folder may be a NAS share other machines can write to, so the manifest is signed and a result counts only when it
// carries the uploader's signature (one shared key that never lies on the share), and nothing there is deleted recursively.
// claude-pro · claude-fable-5-2 · 2026-11-20. Plan: docs/plans/2026-11-20-uploader-service-plan.md
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getChannelById, safeChildDir } from './channelsManager.js';
import { buildSnippet, uploadTitleError, publishing } from './youtube.js';
import { sendGeneric5xx } from './redact.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.FORGEAI_ROOT || path.resolve(__dirname, '../../../');
const draftsDir = () => process.env.FORGEAI_DRAFTS_DIR || path.join(REPO_ROOT, 'output/drafts');
export const uploaderShare = () => path.resolve(process.env.UPLOADER_SHARE || path.join(REPO_ROOT, 'output/uploader-share'));
export const UPLOAD_CATEGORY = '27'; // Education
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const PACKAGE_FILES = ['video.mp4', 'manifest.json', 'READY'];
const MAX_RESULT_BYTES = 20 * 1024;

// ---- the hand-over key and signatures (the same few lines live in uploader/server/share.js) ----
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));
export function sign(key, purpose, obj) {
  const { mac: _mac, ...rest } = obj;
  return crypto.createHmac('sha256', key).update(`${purpose}\n${canonical(rest)}`).digest('hex');
}
export function verified(key, purpose, obj) {
  if (!obj || typeof obj !== 'object' || typeof obj.mac !== 'string' || !/^[0-9a-f]{64}$/.test(obj.mac)) return false;
  return crypto.timingSafeEqual(Buffer.from(obj.mac, 'hex'), Buffer.from(sign(key, purpose, obj), 'hex'));
}
export function handoverKey(env = process.env) {
  if (env.UPLOADER_KEY) { if (env.UPLOADER_KEY.length < 32) throw new Error('UPLOADER_KEY must be 32 characters or more'); return env.UPLOADER_KEY; }
  const file = path.resolve(env.UPLOADER_KEY_FILE || path.join(REPO_ROOT, 'data/uploader/handover.key'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); } catch (err) { if (err.code !== 'EEXIST') throw err; }
  const key = fs.readFileSync(file, 'utf8').trim();
  if (key.length < 32) throw new Error('The hand-over key file is damaged');
  return key;
}

// ---- the folders ----
function plain(p, kind) {
  let st;
  try { st = fs.lstatSync(p); } catch { return null; }
  if (st.isSymbolicLink()) return null;
  return (kind === 'dir' ? st.isDirectory() : st.isFile()) ? st : null;
}
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
/** inbox/ and results/ exist and really sit inside the share (a link in their place could point anywhere). */
function shareReady(share) {
  try {
    fs.mkdirSync(share, { recursive: true });
    const root = fs.realpathSync(share);
    for (const name of ['inbox', 'results']) {
      fs.mkdirSync(path.join(share, name), { recursive: true });
      if (!plain(path.join(share, name), 'dir') || !same(fs.realpathSync(path.join(share, name)), path.join(root, name))) return false;
    }
    return true;
  } catch { return false; }
}
/** Empties a package folder of ours in the inbox: the three known plain files, then the folder. Never recursive. */
function clearInboxFolder(folder) {
  if (!fs.existsSync(folder)) return true;
  if (!plain(folder, 'dir')) return false;
  for (const name of PACKAGE_FILES) { if (plain(path.join(folder, name), 'file')) fs.unlinkSync(path.join(folder, name)); }
  try { fs.rmdirSync(folder); return true; } catch { return false; }
}

function readDraft(id) {
  const draftId = path.basename(String(id));
  const folder = safeChildDir(draftsDir(), draftId);
  if (!folder) return { draftId, meta: null };
  const metaPath = path.join(folder, 'metadata.json');
  try { return { draftId, folder, metaPath, meta: JSON.parse(fs.readFileSync(metaPath, 'utf8')) }; } catch { return { draftId, meta: null }; }
}
function readResult(share, id) {
  const file = path.join(share, 'results', `${id}.json`);
  const st = plain(file, 'file');
  if (!st || st.size > MAX_RESULT_BYTES) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
const sha256File = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file).on('error', reject).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex')));
});

/** The manifest the uploader gets: everything YouTube needs, decided here. Throws an Error with .status 400 on a draft that cannot go. */
export function buildManifest({ draftId, meta, channel, title, tags, sha256, submissionId }) {
  const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!channel) fail('This draft has no channel in ForgeAi.');
  const youtubeChannelId = String(channel.youtube_channel_id || '').trim();
  if (!CHANNEL_ID.test(youtubeChannelId)) fail(`Add the YouTube Channel ID (starts with UC) to the channel "${channel.name}" first: channel settings, YouTube tab.`);
  if (meta.made_for_kids === true) fail('A made-for-kids draft is not sent to the uploader.');
  const titleError = uploadTitleError(title, draftId);
  if (titleError) fail(titleError);
  const language = channel.profile?.language || 'en';
  const snippet = buildSnippet({ ...meta, listing_copy: { ...meta.listing_copy, title } }, tags, language);
  return {
    package_id: draftId, sha256, youtube_channel_id: youtubeChannelId, forgeai_channel_id: channel.id,
    video_type: meta.generation_details?.video_type || meta.video_type || null,
    title: snippet.title, description: snippet.description, tags: snippet.tags, language, category_id: UPLOAD_CATEGORY,
    made_for_kids: false, contains_synthetic_media: meta.ai_disclosure === true, submission_id: submissionId || crypto.randomBytes(12).toString('hex'),
    checks: { fact_check: meta.generation_details?.fact_check?.verified === true, length: meta.generation_details?.length_check?.within_tolerance === true, visual: Number.isInteger(meta.generation_details?.visual_loop?.accepted_round) && meta.generation_details?.visual_check?.approved !== false },
    created_at: new Date().toISOString(),
  };
}

const RESULT_STATES = new Set(['queued', 'uploading', 'unclear', 'kept', 'scheduled', 'public', 'refused', 'failed', 'removed', 'cancelled', 'gone']);
const isoOrNull = (v) => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
/** A result counts only with the uploader's signature, for exactly the package, file and channel that were sent. */
export function cleanResult(result, sent, key) {
  if (!sent || !verified(key, 'result', result)) return null;
  if (result.package_id !== sent.package_id || result.sha256 !== sent.sha256 || !RESULT_STATES.has(result.state)) return null;
  if (result.youtube_channel_id !== sent.youtube_channel_id) return null;
  if (result.submission_id !== sent.submission_id) return null; // an answer to an earlier send of this draft
  const updated = isoOrNull(result.updated_at);
  if (!updated) return null;
  const videoId = typeof result.video_id === 'string' && /^[A-Za-z0-9_-]{6,20}$/.test(result.video_id) ? result.video_id : null;
  // "On YouTube" without a video id and a time is not an answer we can record.
  if (['scheduled', 'public'].includes(result.state) && (!videoId || !isoOrNull(result.publish_at))) return null;
  return { state: result.state, reason: typeof result.reason === 'string' ? result.reason.replace(/[\u0000-\u001f<>]/g, ' ').slice(0, 500) : null,
    video_id: videoId, publish_at: isoOrNull(result.publish_at), public_at: isoOrNull(result.public_at), updated_at: updated };
}

// What the uploader reported becomes the draft's YouTube record, so the Growth page and the daily counts keep working.
// A record made by the dashboard's own Publish button is never touched, and a video that went public stays public.
export function applyResult(meta, rawResult, key) {
  const result = cleanResult(rawResult, meta.uploader, key);
  if (!result) return false;
  if (meta.youtube?.video_id && meta.youtube.publish_mode !== 'uploader') return false;
  if (meta.uploader.state === 'public') return false;
  if (meta.uploader.checked_at && Date.parse(result.updated_at) < Date.parse(meta.uploader.checked_at)) return false;
  const before = JSON.stringify([meta.uploader, meta.youtube]);
  meta.uploader = { ...meta.uploader, state: result.state, reason: result.reason, checked_at: result.updated_at };
  if (result.video_id && result.publish_at && ['scheduled', 'public'].includes(result.state)) {
    meta.youtube = {
      ...meta.youtube, video_id: result.video_id, url: `https://www.youtube.com/shorts/${result.video_id}`, privacy: result.state === 'public' ? 'public' : 'private',
      published_at: meta.youtube?.published_at || result.updated_at, made_for_kids: false, publish_at: result.publish_at, publish_mode: 'uploader',
      ...(result.state === 'public' && { released_at: result.public_at || result.publish_at }),
    };
  } else if (meta.youtube?.publish_mode === 'uploader' && ['cancelled', 'gone'].includes(result.state)) {
    meta.youtube = { ...meta.youtube, privacy: 'private', publish_at: null, release_error: result.reason || result.state };
  }
  return JSON.stringify([meta.uploader, meta.youtube]) !== before;
}

function syncDraft(draft, share, key) {
  if (!draft.meta?.uploader || publishing.has(draft.draftId)) return;
  if (applyResult(draft.meta, readResult(share, draft.meta.uploader.package_id), key)) fs.writeFileSync(draft.metaPath, JSON.stringify(draft.meta, null, 2));
}

/** Reads the uploader's results for every draft that was sent. Called from the dashboard's one schedule loop; never uploads. */
export function syncUploaderResults() {
  let names = [];
  try { names = fs.readdirSync(draftsDir(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return; }
  const share = uploaderShare();
  if (!shareReady(share)) return;
  let key;
  try { key = handoverKey(); } catch { return; }
  for (const name of names) {
    const draft = readDraft(name);
    if (draft.meta?.uploader && draft.meta.uploader.state !== 'public') { try { syncDraft(draft, share, key); } catch { /* next pass */ } }
  }
}

export function uploaderStatusHandler(req, res) {
  const draft = readDraft(req.params.draftId);
  if (!draft.meta) return res.status(404).json({ error: 'Draft not found' });
  const share = uploaderShare();
  const ok = shareReady(share);
  if (ok) { try { syncDraft(draft, share, handoverKey()); } catch { /* shown as it is */ } }
  const channel = getChannelById(draft.meta.channel_id || 'default');
  res.json({
    share_ok: ok,
    channel: channel ? { name: channel.name, youtube_channel_id: channel.youtube_channel_id || null } : null,
    sent: draft.meta.uploader || null,
    youtube: draft.meta.youtube || null,
  });
}

// Sent once. Again only after the uploader refused it or the owner removed it there (a new title can then go).
export const canSendAgain = (sent) => !sent || sent.state === 'refused' || sent.state === 'removed';
// "sent" with no answer yet: the package may wait in the inbox, or a crash mid-copy left nothing or half of it. Sending
// again is safe because it reuses the SAME send id: the uploader takes one send once and ignores a second copy of it.
// -> 'waiting' (a complete package is in the inbox: nothing to do) | 'resend' | null (not in this state)
function unanswered(sent, share) {
  if (sent?.state !== 'sent') return null;
  let entries = null;
  try { entries = fs.readdirSync(path.join(share, 'inbox', sent.package_id)); } catch { /* not in the inbox */ }
  return entries?.includes('READY') ? 'waiting' : 'resend';
}

export async function uploaderSendHandler(req, res) {
  const first = readDraft(req.params.draftId);
  const { draftId, folder, metaPath } = first;
  if (!first.meta) return res.status(404).json({ error: `Draft "${draftId}" not found` });
  // One lock for this draft, shared with the dashboard's own Publish button: the two ways out can never run together.
  if (publishing.has(draftId)) return res.status(409).json({ error: 'This video is already being uploaded or sent.' });
  publishing.add(draftId);
  try {
    const share = uploaderShare();
    if (!shareReady(share)) return res.status(503).json({ error: `The uploader folder is not usable: ${share}` });
    const key = handoverKey();
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); // read again under the lock
    if (applyResult(meta, readResult(share, meta.uploader?.package_id), key)) fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    if (!meta.video_file) return res.status(400).json({ error: 'This draft has no video.' });
    if (meta.youtube?.video_id) return res.status(409).json({ error: 'This video is already on YouTube.' });
    const open = unanswered(meta.uploader, share);
    if (open === 'waiting') return res.status(409).json({ error: 'This video is in the uploader folder, waiting to be taken. Is the uploader running?', sent: meta.uploader });
    if (!canSendAgain(meta.uploader) && open !== 'resend') return res.status(409).json({ error: 'This video was already sent to the uploader.', sent: meta.uploader });
    const videoFile = path.join(folder, path.basename(meta.video_file));
    const title = (typeof req.body?.title === 'string' && req.body.title.trim()) || meta.listing_copy?.title || meta.product?.title || meta.social?.caption || '';
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.slice(0, 50) : undefined;
    const channel = getChannelById(meta.channel_id || 'default');
    const fileHash = await sha256File(videoFile);
    // The same send again must be the same video for the same channel; otherwise the first one's answer could never land.
    if (open === 'resend' && (meta.uploader.sha256 !== fileHash || meta.uploader.youtube_channel_id !== String(channel?.youtube_channel_id || '').trim())) {
      return res.status(409).json({ error: 'This draft was already sent with another video file or for another channel. Wait for the uploader to answer, or remove it on the uploader page first.', sent: meta.uploader });
    }
    const manifest = JSON.parse(JSON.stringify(buildManifest({ draftId, meta, channel, title, tags, sha256: fileHash, submissionId: open === 'resend' ? meta.uploader.submission_id : undefined })));
    manifest.mac = sign(key, 'manifest', manifest);
    const target = path.join(share, 'inbox', draftId);
    if (!clearInboxFolder(target)) return res.status(409).json({ error: 'An earlier copy of this video is still in the uploader folder and could not be cleared.' });
    // The send is recorded before the package becomes visible, so a crash in between cannot lead to a second send.
    meta.listing_copy = { ...meta.listing_copy, title: manifest.title };
    const earlier = meta.uploader || null;
    meta.uploader = { package_id: draftId, submission_id: manifest.submission_id, sent_at: new Date().toISOString(), youtube_channel_id: manifest.youtube_channel_id, sha256: manifest.sha256, state: 'sent', reason: null };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    try {
      fs.mkdirSync(target);
      fs.copyFileSync(videoFile, path.join(target, 'video.mp4'), fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
      fs.writeFileSync(path.join(target, 'READY'), '', { flag: 'wx' }); // last: the uploader takes nothing without it
    } catch (err) {
      // Without READY the uploader never saw it: take the half copy back and forget the send.
      try { clearInboxFolder(target); } catch { /* left for the next send to clear */ }
      if (earlier) meta.uploader = earlier; else delete meta.uploader;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      throw err;
    }
    res.json({ sent: meta.uploader, channel: { name: channel.name, youtube_channel_id: manifest.youtube_channel_id } });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error(`Send to uploader ${draftId} failed:`, err.message);
    sendGeneric5xx(req, res, 500, err);
  } finally { publishing.delete(draftId); }
}
