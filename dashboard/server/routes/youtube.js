import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { askGemini, GEMINI_LITE_MODEL } from './gemini.js';
import { sendGeneric5xx } from './redact.js';
import { getActiveChannel, getChannelToken, saveChannelToken, getChannelById, safeChildDir } from './channelsManager.js';
import { isSemanticDraft, semanticGate, withSemanticReview } from './semanticReview.js'; // KAN-778
import { readCostSummary } from '../perf/creationCost.js';

// YouTube publishing: one-time OAuth sign-in (uploads need the channel owner's consent; API keys can't upload),
// then resumable uploads of finished video drafts.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.FORGEAI_ROOT || path.resolve(__dirname, '../../../');
const DRAFTS_DIR = process.env.FORGEAI_DRAFTS_DIR || path.join(REPO_ROOT, 'output/drafts');
const TOKEN_FILE = process.env.YOUTUBE_TOKEN_FILE || path.join(REPO_ROOT, 'data/youtube_token.json');
const REDIRECT_URI = process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:3000/api/youtube/callback';
// Full youtube scope: scheduled Shorts are switched from unlisted to public later with videos.update.
const FULL_SCOPE = 'https://www.googleapis.com/auth/youtube';
const canSchedule = (token) => String(token?.scope || '').split(' ').includes(FULL_SCOPE);
const MAX_SCHEDULE_DAYS = 60;
export const PRIVACY = ['private', 'unlisted', 'public'];

const pendingStates = new Map(); // OAuth CSRF guard: state -> channelId
const publishing = new Set(); // drafts mid-upload, so a double click can't upload twice

const clientId = () => process.env.YOUTUBE_CLIENT_ID;
const clientSecret = () => process.env.YOUTUBE_CLIENT_SECRET;

export function readToken(req = null, draftChannelId = null) {
  // A scheduled draft belongs to its recorded channel, regardless of the UI's active channel.
  if (draftChannelId) {
    const targetToken = getChannelToken(draftChannelId);
    return targetToken?.refresh_token ? targetToken : null;
  }
  if (req) {
    const channel = getActiveChannel(req);
    if (channel?.id) {
      const channelTok = getChannelToken(channel.id);
      if (channelTok?.refresh_token) return channelTok;
    }
  }
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function googleToken(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google sign-in failed: ${data.error_description || data.error || res.status}`);
  return data;
}

async function googleError(res) {
  const data = await res.json().catch(() => ({}));
  const reason = data.error?.errors?.[0]?.reason;
  return `YouTube HTTP ${res.status}${reason ? ` (${reason})` : ''}: ${data.error?.message || res.statusText}`;
}

const clean = (s = '') => String(s).replace(/[<>]/g, '').trim();

// YouTube tags: no "#", no spaces or punctuation, deduped (case-insensitive).
// YouTube ignores every description hashtag past 15, and caps tags at 500 characters in total.
export function normalizeTags(list = []) {
  const seen = new Set();
  const tags = [];
  for (const raw of list) {
    const tag = String(raw).replace(/[^\p{L}\p{N}_]/gu, '');
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  const fitted = [];
  let chars = 0;
  for (const tag of tags.slice(0, 15)) {
    if ((chars += tag.length + 1) > 500) break;
    fitted.push(tag);
  }
  return fitted;
}

export const AI_NOTICE = '(Visual simulation and narration created with the assistance of 3D modeling and AI.)';
export const DEFAULT_MAX_DAILY_POSTS = 2;

// Return a user-facing error, or null when a draft's editable listing title is suitable to upload.
export function uploadTitleError(value, draftId) {
  const title = clean(value);
  if (!title) return 'Add a title before uploading this video.';
  if (title.length > 100) return 'The title must be 100 characters or fewer.';
  if (title === String(draftId ?? '')) return 'Replace the draft ID with a title that describes the video.';
  // Dates are recognized in common year-first or day-first numeric forms, with any Unicode digits.
  const datePattern = /^\p{N}{1,4}[./-]\p{N}{1,2}[./-]\p{N}{1,4}$/u;
  if (datePattern.test(title)) return 'Use a descriptive title; a date alone cannot be uploaded.';
  const compact = title.replace(/[\s.,/\\_-]+/gu, '');
  if (/^\p{N}+$/u.test(compact)) return 'Use a descriptive title; a title made only of digits cannot be uploaded.';
  return null;
}

// Title/description/tags from the draft's metadata; YouTube rejects < and > in titles.
// tags: the user's chosen tags; defaults to the draft's own hashtags.
export function buildSnippet(meta, tags, language = 'en') {
  const listing = meta.listing_copy || {};
  const chosen = normalizeTags(tags || [...(meta.social?.hashtags || []), ...(listing.tags || [])]);
  const title = clean(listing.title || meta.product?.title || meta.social?.caption || '');
  const firstSentence = (clean(listing.description || meta.script || title) || title).split(/(?<=[.!?])\s+/u)[0];
  const summary = /[.!?]$/u.test(firstSentence) ? firstSentence : `${firstSentence}.`;
  const loop = meta.production_choices?.type === 'loop' || meta.choices?.type === 'loop' || meta.generation_details?.production_choices?.type === 'loop' || meta.generation_details?.choices?.type === 'loop' || meta.episode_draft?.choices?.type === 'loop' || meta.type === 'loop';
  const narration = loop ? '' : clean(meta.script || listing.description);
  const hashtags = chosen.slice(0, 5).map((t) => `#${t}`).join(' ');
  const description = [summary, narration, AI_NOTICE, hashtags].filter(Boolean).join('\n\n').slice(0, 5000);
  const snippet = { title, description, tags: chosen, categoryId: '24', defaultLanguage: language || 'en' };
  if (!loop) snippet.defaultAudioLanguage = language || 'en';
  return snippet;
}

export function youtubeStatusHandler(req, res) {
  const token = readToken(req);
  res.json({
    configured: Boolean(clientId() && clientSecret()),
    connected: Boolean(token?.refresh_token),
    channel: token?.channel || null,
    can_schedule: canSchedule(token),
  });
}

export function youtubeConnectHandler(req, res) {
  if (!clientId() || !clientSecret()) return res.status(400).send('Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env, then restart the dashboard.');
  const state = crypto.randomBytes(16).toString('hex');
  const channel = getActiveChannel(req);
  pendingStates.set(state, channel?.id || 'default');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId(), redirect_uri: REDIRECT_URI, response_type: 'code', scope: FULL_SCOPE,
    access_type: 'offline', prompt: 'consent', state,
  });
  res.redirect(url.toString());
}

export async function youtubeCallbackHandler(req, res) {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/?youtube=${encodeURIComponent(error)}`);
  if (!state || !pendingStates.has(state)) return res.status(400).send('This sign-in link expired. Click "Connect YouTube" again.');
  const targetChannelId = pendingStates.get(state);
  pendingStates.delete(state);
  try {
    const token = await googleToken({ code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI });
    if (!token.refresh_token) throw new Error('Google returned no refresh token. Remove ForgeAI at myaccount.google.com/permissions and connect again.');
    const channelRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const channelItem = channelRes.ok ? (await channelRes.json()).items?.[0] : null;
    const channel = channelItem?.snippet?.title || null;
    const channel_id = channelItem?.id || null;
    const tokenPayload = { refresh_token: token.refresh_token, scope: token.scope, channel, channel_id };
    
    // Save to global fallback
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenPayload, null, 2), { mode: 0o600 });
    
    // Also save to channel specific storage if applicable
    if (targetChannelId) {
      saveChannelToken(targetChannelId, tokenPayload);
    }
    
    res.redirect('/?youtube=connected');
  } catch (err) {
    sendGeneric5xx(req, res, 502, err);
  }
}

export function youtubeDisconnectHandler(req, res) {
  const channel = getActiveChannel(req);
  if (channel?.id) {
    saveChannelToken(channel.id, null);
  }
  fs.rmSync(TOKEN_FILE, { force: true });
  res.json({ connected: false });
}

function readDraft(id) {
  const draftId = path.basename(id);
  const folder = safeChildDir(DRAFTS_DIR, draftId);
  if (!folder) return { draftId, meta: null }; // '..' and friends: path.basename() keeps them (KAN-427 F1)
  const metaPath = path.join(folder, 'metadata.json');
  try {
    return { draftId, folder, metaPath, meta: JSON.parse(fs.readFileSync(metaPath, 'utf8')) };
  } catch {
    return { draftId, meta: null };
  }
}

// Topic-specific tags from Gemini (the drafts' own hashtags are generic: #storytime, #fyp...).
export async function youtubeSuggestTagsHandler(req, res) {
  const { draftId, meta } = readDraft(req.params.draftId);
  if (!meta) return res.status(404).json({ error: `Draft "${draftId}" not found` });
  const title = meta.listing_copy?.title || meta.product?.title || '';
  const script = String(meta.script || meta.listing_copy?.description || '').slice(0, 1500);
  try {
    const channel = getActiveChannel(req);
    const growthEnabled = channel?.growth_profile_prompts === true;
    const growthGuidance = growthEnabled ? `\nSEO metadata guidance: write a searchable 20-40 character title with the primary keyword first; make the first 125 description characters carry the topic and value; suggest 3-5 relevant hashtags; return 10-12 relevant tags.` : '';
    const raw = await askGemini(`Suggest YouTube Shorts tags for this video.${growthGuidance}\nTitle: ${title}\nVoice-over: ${script}\n\nReturn ONLY JSON: {"tags": ["..."]} with 10-12 tags. No "#", no spaces inside a tag (join words: dyatlovpass).\nMix: 4-5 about the exact subject (names, places, events), 3-4 for the wider niche, 2-3 broad terms people search.\nNo "fyp", "viral" or "foryou" (they do nothing on YouTube). English, lowercase.`, { model: GEMINI_LITE_MODEL });
    if (!raw) return res.status(503).json({ error: 'GEMINI_API_KEY is not set.' });
    const tags = normalizeTags(Array.isArray(raw.tags) ? raw.tags : []);
    if (tags.length < 2) throw new Error('Gemini returned no usable tags');
    res.json({ tags });
  } catch (err) {
    sendGeneric5xx(req, res, 502, err);
  }
}

// publishAt: upload unlisted now and let releaseDue() make it public at that time (unlisted, not private, so
// YouTube's copyright check runs before it goes public).
export function parsePublishAt(value, now = Date.now()) {
  if (value == null || value === '') return { at: null };
  const at = new Date(value);
  if (Number.isNaN(at.getTime()) || at.getTime() <= now || at.getTime() > now + MAX_SCHEDULE_DAYS * 86400000) {
    return { error: `Schedule time must be in the next ${MAX_SCHEDULE_DAYS} days.` };
  }
  return { at: at.toISOString() };
}

// YouTube's altered/synthetic content flag (videos.insert status.containsSyntheticMedia, Oct 2024) for AI-made drafts.
export const uploadStatus = (meta, privacy, madeForKids) => ({
  privacyStatus: privacy,
  selfDeclaredMadeForKids: madeForKids,
  ...(meta.ai_disclosure && { containsSyntheticMedia: true }),
});

// The UTC day a draft goes (or went) public: its schedule time, or its upload time for a direct public upload.
// ponytail: UTC days; a creator far from UTC posting near midnight may see a slot land on the neighbouring day.
const releaseDay = (meta) => String(meta.youtube?.publish_at || (meta.youtube?.privacy === 'public' && meta.youtube?.published_at) || '').slice(0, 10);

// Growth cap (one niche, steady pace): at most `max` releases per channel per day -> null, or that day and the next free slot.
export function capCheck(drafts, channelId, at, max) {
  const used = (day) => drafts.filter(({ meta }) => (meta.channel_id || 'default') === channelId && releaseDay(meta) === day).length;
  const day = at.slice(0, 10);
  if (used(day) < max) return null;
  for (let d = 1; d <= MAX_SCHEDULE_DAYS; d++) {
    const next = new Date(new Date(at).getTime() + d * 86400000).toISOString();
    if (used(next.slice(0, 10)) < max) return { day, next };
  }
  return { day, next: null };
}

export async function youtubePublishHandler(req, res) {
  const scheduled = parsePublishAt(req.body?.publishAt);
  if (scheduled.error) return res.status(400).json({ error: scheduled.error });
  const privacy = scheduled.at ? 'unlisted' : PRIVACY.includes(req.body?.privacy) ? req.body.privacy : 'public';
  const tags = Array.isArray(req.body?.tags) ? req.body.tags.slice(0, 50) : undefined;
  const { draftId, folder, metaPath, meta } = readDraft(req.params.draftId);
  if (!meta) return res.status(404).json({ error: `Draft "${draftId}" not found` });
  if (!meta.video_file) return res.status(400).json({ error: 'This draft has no video to publish.' });
  if (meta.youtube?.video_id && req.body?.force !== true) return res.status(409).json({ error: 'Already published to YouTube. Set force to true to upload this draft again.', youtube: meta.youtube });
  const requestedTitle = typeof req.body?.title === 'string' ? req.body.title : meta.listing_copy?.title;
  const titleError = uploadTitleError(requestedTitle, draftId);
  if (titleError) return res.status(400).json({ error: titleError });
  // KAN-778: a semantic explainer needs a current server-validated review receipt for every upload (public, unlisted, private or scheduled). Nothing in the body counts.
  const semanticRefusal = isSemanticDraft({ folder, meta }) ? await semanticGate({ draftId, folder, meta }) : null;
  if (semanticRefusal) return res.status(409).json(semanticRefusal);
  // Made for kids: the draft's made_for_kids flag is the default; an explicit body value still wins.
  const madeForKids = req.body?.madeForKids === undefined ? Boolean(meta.made_for_kids) : req.body.madeForKids === true;
  const token = meta.channel_id ? readToken(req, meta.channel_id) : readToken(req);
  if (!token?.refresh_token) return res.status(401).json({ error: 'Connect YouTube first.' });
  if (publishing.has(draftId)) return res.status(409).json({ error: 'This video is already uploading.' });
  if (scheduled.at && !canSchedule(token)) {
    return res.status(401).json({ error: 'Scheduling needs more YouTube access. Disconnect and connect YouTube again.' });
  }
  const releaseAt = scheduled.at || (privacy === 'public' ? new Date().toISOString() : null);
  if (releaseAt) {
    const channelId = meta.channel_id || 'default';
    const max = Number(getChannelById(channelId)?.max_daily_posts) || DEFAULT_MAX_DAILY_POSTS;
    const full = capCheck(allDrafts(), channelId, releaseAt, max);
    if (full) {
      return res.status(409).json({ error: `This channel already has ${max} video(s) going public on ${full.day}.${full.next ? ` Next free slot: ${full.next}.` : ''}`, next_free: full.next });
    }
  }
  meta.listing_copy = { ...meta.listing_copy, title: clean(requestedTitle) };
  const channel = getChannelById(meta.channel_id || getActiveChannel(req)?.id);
  const language = channel?.profile?.language || 'en';

  publishing.add(draftId);
  try {
    const { access_token: accessToken } = await googleToken({ refresh_token: token.refresh_token, grant_type: 'refresh_token' });
    const video = fs.readFileSync(path.join(folder, path.basename(meta.video_file)));

    const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(video.length),
      },
      body: JSON.stringify({ snippet: buildSnippet(meta, tags, language), status: uploadStatus(meta, privacy, madeForKids) }),
    });
    if (!init.ok) throw new Error(await googleError(init));
    const upload = await fetch(init.headers.get('location'), { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: video });
    if (!upload.ok) throw new Error(await googleError(upload));
    const uploaded = await upload.json();

    meta.youtube = {
      video_id: uploaded.id,
      url: `https://www.youtube.com/shorts/${uploaded.id}`,
      privacy: uploaded.status?.privacyStatus || privacy,
      published_at: new Date().toISOString(),
      made_for_kids: madeForKids,
      ...(scheduled.at && { publish_at: scheduled.at }),
    };
    delete meta.future_upload_at;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    res.json(meta.youtube);
  } catch (err) {
    console.error(`YouTube publish ${draftId} failed:`, err.message);
    // Daily upload cap hit: park it in the Drafts tab to publish once the limit resets.
    if (/uploadLimitExceeded/.test(err.message)) {
      meta.future_upload_at = new Date().toISOString();
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      return res.status(429).json({ error: 'YouTube upload limit reached. Saved to Drafts; publish it from there once the limit resets (about 24h).', drafted: true });
    }
    sendGeneric5xx(req, res, 502, err);
  } finally {
    publishing.delete(draftId);
  }
}

function allDrafts() {
  if (!fs.existsSync(DRAFTS_DIR)) return [];
  return fs.readdirSync(DRAFTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => readDraft(e.name))
    .filter((d) => d.meta);
}

// Scheduled uploads whose time has come and are still unlisted.
export const dueReleases = (drafts, now = Date.now()) =>
  drafts.filter(({ meta }) => meta.youtube?.publish_at && meta.youtube.privacy === 'unlisted' && new Date(meta.youtube.publish_at).getTime() <= now);

// KAN-778: the unattended release never flips a semantic explainer public without a current review receipt (the video stays unlisted); ordinary drafts pass untouched.
async function reviewedOnly(drafts) {
  const kept = [];
  for (const d of drafts) {
    const refusal = isSemanticDraft(d) ? await semanticGate(d) : null;
    if (!refusal) { kept.push(d); continue; }
    if (d.meta.youtube.release_error !== refusal.error) {
      d.meta.youtube = { ...d.meta.youtube, release_error: refusal.error };
      fs.writeFileSync(d.metaPath, JSON.stringify(d.meta, null, 2));
    }
  }
  return kept;
}

// Runs every minute from index.js. A failure is recorded on the draft and retried next minute.
export async function releaseDue(now = Date.now()) {
  const due = await reviewedOnly(dueReleases(allDrafts(), now));
  if (!due.length) return;
  const legacy = readToken(); // channel-less drafts keep using the single legacy sign-in
  const accessTokens = new Map(); // refresh_token -> access token (or null after a failed sign-in)
  for (const { draftId, metaPath, meta } of due) {
    // A draft with a recorded channel only ever uses that channel's token; it never falls back to another one.
    const token = meta.channel_id ? readToken(null, meta.channel_id) : legacy;
    if (!token?.refresh_token) {
      if (!meta.channel_id) continue; // not signed in: nothing to do, and no metadata churn each minute
      const error = `No YouTube connection for channel "${meta.channel_id}"; reconnect it to release this video.`;
      if (meta.youtube.release_error !== error) {
        meta.youtube = { ...meta.youtube, release_error: error };
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      }
      continue;
    }
    if (!accessTokens.has(token.refresh_token)) {
      try {
        const { access_token } = await googleToken({ refresh_token: token.refresh_token, grant_type: 'refresh_token' });
        accessTokens.set(token.refresh_token, access_token);
      } catch (err) {
        console.error('YouTube release: sign-in failed:', err.message);
        accessTokens.set(token.refresh_token, null);
      }
    }
    const accessToken = accessTokens.get(token.refresh_token);
    if (!accessToken) continue;
    const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: meta.youtube.video_id, status: uploadStatus(meta, 'public', Boolean(meta.youtube.made_for_kids)) }),
    });
    if (r.ok) {
      meta.youtube = { ...meta.youtube, privacy: 'public', released_at: new Date().toISOString(), release_error: undefined };
    } else {
      meta.youtube = { ...meta.youtube, release_error: await googleError(r) };
      console.error(`YouTube release ${draftId} failed: ${meta.youtube.release_error}`);
    }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
}

// Cancel a scheduled release: the video stays unlisted on YouTube.
export function youtubeCancelScheduleHandler(req, res) {
  const { draftId, metaPath, meta } = readDraft(req.params.draftId);
  if (!meta) return res.status(404).json({ error: `Draft "${draftId}" not found` });
  if (!meta.youtube?.publish_at || meta.youtube.privacy !== 'unlisted') return res.status(409).json({ error: 'This video is not waiting to go public.' });
  const { publish_at: _, release_error: __, ...rest } = meta.youtube;
  meta.youtube = rest;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  res.json(meta.youtube);
}

const queueItem = ({ draftId, meta }) => ({
  id: draftId,
  cost: readCostSummary(path.join(DRAFTS_DIR, draftId)),
  title: meta.listing_copy?.title || meta.product?.title || draftId,
  tags: meta.listing_copy?.tags || [],
  created_at: meta.created_at,
  duration: meta.social?.duration_seconds || meta.duration,
  video_url: `/api/drafts/media/${draftId}/${meta.video_file}`,
  audio_url: meta.audio_file ? `/api/drafts/media/${draftId}/${meta.audio_file}` : `/api/drafts/media/${draftId}/voiceover.wav`,
  voice: meta.voice || '',
  instruct: meta.instruct || '',
  dynamic_tone: meta.dynamic_tone !== false,
  script: meta.script || (Array.isArray(meta.sentences) ? meta.sentences.map((s) => s.text).join(' ') : (meta.listing_copy?.description || '')),
  youtube: meta.youtube || null,
  engine: meta.engine || undefined,
  style: meta.style || undefined,
  provenance: meta.provenance || undefined,
});

// Shorts tab: auto videos waiting for review, and the ones scheduled or released (newest first).
// KAN-778: semantic drafts carry semantic_review (status, blockers, links); with none in the list the answer is built synchronously, byte for byte as before.
const whenReady = (parts, send) => (parts.some((p) => p instanceof Promise) ? Promise.all(parts).then(send) : send(parts));
export function shortsQueueHandler(req, res) {
  const autos = allDrafts().filter(({ meta }) => meta.auto && meta.video_file).sort((a, b) => String(b.meta.created_at).localeCompare(String(a.meta.created_at)));
  return whenReady([
    withSemanticReview(autos.filter(({ meta }) => !meta.youtube && !meta.future_upload_at), queueItem),
    withSemanticReview(autos.filter(({ meta }) => meta.youtube).slice(0, 30), queueItem),
  ], ([review, scheduled]) => res.json({ review, scheduled }));
}

// Drafts tab: future uploads (marked by hand or parked by the upload limit), not published yet, oldest first.
export function youtubeDraftsHandler(req, res) {
  const queued = allDrafts()
    .filter(({ meta }) => meta.future_upload_at && meta.video_file && !meta.youtube)
    .sort((a, b) => a.meta.future_upload_at.localeCompare(b.meta.future_upload_at));
  return whenReady([withSemanticReview(queued, queueItem)], ([items]) => res.json(items));
}
