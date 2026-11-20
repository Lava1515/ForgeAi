// "Send to uploader": ForgeAi hands a finished draft to the separate uploader (uploader/ in this repo) through a folder.
// ForgeAi writes   <share>/inbox/<draft id>/ video.mp4, manifest.json, then an empty READY file (READY last).
// The uploader writes <share>/results/<draft id>.json, which is read back here. Only the owner's button calls the send route.
// claude-pro · claude-fable-5-2 · 2026-11-20. Plan: docs/plans/2026-11-20-uploader-service-plan.md
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getChannelById, safeChildDir } from './channelsManager.js';
import { buildSnippet, uploadTitleError } from './youtube.js';
import { sendGeneric5xx } from './redact.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.FORGEAI_ROOT || path.resolve(__dirname, '../../../');
const draftsDir = () => process.env.FORGEAI_DRAFTS_DIR || path.join(REPO_ROOT, 'output/drafts');
export const uploaderShare = () => path.resolve(process.env.UPLOADER_SHARE || path.join(REPO_ROOT, 'output/uploader-share'));
export const UPLOAD_CATEGORY = '27'; // Education
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const sending = new Set();

function readDraft(id) {
  const draftId = path.basename(String(id));
  const folder = safeChildDir(draftsDir(), draftId);
  if (!folder) return { draftId, meta: null };
  const metaPath = path.join(folder, 'metadata.json');
  try { return { draftId, folder, metaPath, meta: JSON.parse(fs.readFileSync(metaPath, 'utf8')) }; } catch { return { draftId, meta: null }; }
}
const readResult = (share, id) => { try { return JSON.parse(fs.readFileSync(path.join(share, 'results', `${id}.json`), 'utf8')); } catch { return null; } };
const sha256File = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file).on('error', reject).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex')));
});

/** The manifest the uploader gets: everything YouTube needs, decided here. Throws an Error with .status 400 on a draft that cannot go. */
export function buildManifest({ draftId, meta, channel, title, tags, sha256 }) {
  const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  const youtubeChannelId = String(channel?.youtube_channel_id || '').trim();
  if (!channel) fail('This draft has no channel in ForgeAi.');
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
    made_for_kids: false, contains_synthetic_media: meta.ai_disclosure === true,
    checks: { fact_check: meta.generation_details?.fact_check?.verified === true, length: meta.generation_details?.length_check?.within_tolerance === true, visual: Number.isInteger(meta.generation_details?.visual_loop?.accepted_round) && meta.generation_details?.visual_check?.approved !== false },
    created_at: new Date().toISOString(),
  };
}

// What the uploader reported becomes the draft's YouTube record, so the Growth page and the daily counts keep working.
function applyResult(meta, result) {
  if (!result || !meta.uploader) return false;
  const before = JSON.stringify([meta.uploader, meta.youtube]);
  meta.uploader = { ...meta.uploader, state: result.state, reason: result.reason || null, checked_at: result.updated_at || null };
  if (result.video_id && ['scheduled', 'public'].includes(result.state)) {
    meta.youtube = {
      ...meta.youtube, video_id: result.video_id, url: result.url, privacy: result.state === 'public' ? 'public' : 'private',
      published_at: meta.youtube?.published_at || result.updated_at, made_for_kids: false, publish_at: result.publish_at, publish_mode: 'uploader',
      ...(result.state === 'public' && { released_at: result.public_at || result.publish_at }),
    };
  } else if (meta.youtube?.publish_mode === 'uploader' && ['cancelled', 'gone'].includes(result.state)) {
    meta.youtube = { ...meta.youtube, privacy: 'private', publish_at: null, release_error: result.reason || result.state };
  }
  return JSON.stringify([meta.uploader, meta.youtube]) !== before;
}

function syncDraft(draft, share = uploaderShare()) {
  if (!draft.meta?.uploader) return;
  if (applyResult(draft.meta, readResult(share, draft.meta.uploader.package_id))) fs.writeFileSync(draft.metaPath, JSON.stringify(draft.meta, null, 2));
}

/** Reads the uploader's results for every draft that was sent. Called from the dashboard's one schedule loop; never uploads. */
export function syncUploaderResults() {
  let names = [];
  try { names = fs.readdirSync(draftsDir(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return; }
  const share = uploaderShare();
  for (const name of names) {
    const draft = readDraft(name);
    if (draft.meta?.uploader && draft.meta.uploader.state !== 'public') { try { syncDraft(draft, share); } catch { /* next pass */ } }
  }
}

const shareReachable = (share) => { try { fs.mkdirSync(path.join(share, 'inbox'), { recursive: true }); return true; } catch { return false; } };

export function uploaderStatusHandler(req, res) {
  const draft = readDraft(req.params.draftId);
  if (!draft.meta) return res.status(404).json({ error: 'Draft not found' });
  const share = uploaderShare();
  try { syncDraft(draft, share); } catch { /* shown as it is */ }
  const channel = getChannelById(draft.meta.channel_id || 'default');
  res.json({
    share_ok: shareReachable(share),
    channel: channel ? { name: channel.name, youtube_channel_id: channel.youtube_channel_id || null } : null,
    sent: draft.meta.uploader || null,
    youtube: draft.meta.youtube || null,
  });
}

export async function uploaderSendHandler(req, res) {
  const draft = readDraft(req.params.draftId);
  const { draftId, folder, metaPath, meta } = draft;
  if (!meta) return res.status(404).json({ error: `Draft "${draftId}" not found` });
  if (!meta.video_file) return res.status(400).json({ error: 'This draft has no video.' });
  if (meta.youtube?.video_id) return res.status(409).json({ error: 'This video is already on YouTube.' });
  const share = uploaderShare();
  try { syncDraft(draft, share); } catch { /* decided below from what is known */ }
  // Sent once. Again only after the uploader refused it or the owner removed it there (a new title can then go).
  if (meta.uploader && !['refused', 'removed'].includes(meta.uploader.state)) return res.status(409).json({ error: 'This video was already sent to the uploader.', sent: meta.uploader });
  if (sending.has(draftId)) return res.status(409).json({ error: 'This video is being sent.' });
  if (!shareReachable(share)) return res.status(503).json({ error: `The uploader folder is not reachable: ${share}` });
  sending.add(draftId);
  try {
    const videoFile = path.join(folder, path.basename(meta.video_file));
    const title = (typeof req.body?.title === 'string' && req.body.title.trim()) || meta.listing_copy?.title || meta.product?.title || meta.social?.caption || '';
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.slice(0, 50) : undefined;
    const channel = getChannelById(meta.channel_id || 'default');
    const manifest = buildManifest({ draftId, meta, channel, title, tags, sha256: await sha256File(videoFile) });
    const target = path.join(share, 'inbox', draftId);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(videoFile, path.join(target, 'video.mp4'));
    fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.rmSync(path.join(share, 'results', `${draftId}.json`), { force: true }); // an old refusal must not be read as the answer to this send
    fs.writeFileSync(path.join(target, 'READY'), ''); // last: the uploader takes nothing without it
    meta.listing_copy = { ...meta.listing_copy, title: manifest.title };
    meta.uploader = { package_id: draftId, sent_at: new Date().toISOString(), youtube_channel_id: manifest.youtube_channel_id, sha256: manifest.sha256, state: 'sent', reason: null };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    res.json({ sent: meta.uploader, channel: { name: channel.name, youtube_channel_id: manifest.youtube_channel_id } });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error(`Send to uploader ${draftId} failed:`, err.message);
    sendGeneric5xx(req, res, 500, err);
  } finally { sending.delete(draftId); }
}
