import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getActiveChannel, getAllChannels, isSafeId } from './channelsManager.js';
import { recordAndAttach, snapshotFile } from '../growth/snapshots.js';
import { parseIsoDuration } from './trends.js';

// Reads YouTube Analytics / Data API for our channel to rank what actually performed.
// Ranks published shorts by views-per-hour, finds the best-performing voices, styles, and themes,
// and saves the results to data/trends/channel.json so the themes scan and Studio auto mode
// can double down on what works for OUR audience instead of guessing from global trends.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.FORGEAI_ROOT || path.resolve(__dirname, '../../../');
const DRAFTS_DIR = process.env.FORGEAI_DRAFTS_DIR || path.join(REPO_ROOT, 'output/drafts');
const TRENDS_DIR = path.join(REPO_ROOT, 'data/trends');
const CHANNEL_FILE = path.join(REPO_ROOT, 'data/trends/channel.json');
const LEGACY_CACHE_FILE = path.join(TRENDS_DIR, 'channel_performance.json');
const TOKEN_FILE = process.env.YOUTUBE_TOKEN_FILE || path.join(REPO_ROOT, 'data/youtube_token.json');
const YT_API = 'https://www.googleapis.com/youtube/v3';

function readToken() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function getChannelId() {
  if (process.env.YOUTUBE_CHANNEL_ID) return process.env.YOUTUBE_CHANNEL_ID;
  const token = readToken();
  if (token?.channel_id) return token.channel_id;
  return 'UCrYSf42sxY0hEa2pWSZ140w';
}

const getChannelCacheFile = (channelId, trendsDir = TRENDS_DIR) => {
  if (!channelId || channelId === 'default') {
    return trendsDir === TRENDS_DIR ? CHANNEL_FILE : path.join(trendsDir, 'channel.json');
  }
  if (!isSafeId(channelId)) throw new Error('Invalid channel id');
  return path.join(trendsDir, `channel_${channelId}.json`);
};

// Find all drafts that have a recorded YouTube video ID (uploaded via the app or marked published).
function readPublishedDrafts(filterChannelId = null) {
  if (!fs.existsSync(DRAFTS_DIR)) return [];
  const drafts = [];
  for (const entry of fs.readdirSync(DRAFTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(DRAFTS_DIR, entry.name, 'metadata.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (filterChannelId && meta.channel_id && meta.channel_id !== filterChannelId) {
        continue;
      }
      const ytId = meta.youtube?.video_id || meta.social?.platforms?.youtube_shorts?.video_id || meta.youtube_id;
      if (ytId) {
        drafts.push({
          draft_id: meta.draft_id || entry.name,
          channel_id: meta.channel_id || 'default',
          youtube_id: ytId,
          voice: meta.voice || meta.audio?.voice || '',
          instruct: meta.instruct || meta.audio?.instruct || '',
          theme: meta.theme || meta.listing_copy?.title || '',
          product: meta.product || null,
          created_at: meta.created_at || null,
          url: meta.youtube?.url || null,
          youtube: meta.youtube || { video_id: ytId, url: meta.youtube?.url },
        });
      }
    } catch {
      // corrupt metadata file; skip
    }
  }
  return drafts;
}

async function fetchChannelUploadVideoIds(key, channelId) {
  if (!channelId) return [];
  try {
    const playlistId = channelId.startsWith('UC') ? `UU${channelId.slice(2)}` : channelId;
    const items = [];
    let pageToken = '';
    for (let page = 0; page < 2; page++) {
      const params = new URLSearchParams({
        key,
        part: 'contentDetails',
        playlistId,
        maxResults: '50',
        ...(pageToken ? { pageToken } : {}),
      });
      const res = await fetch(`${YT_API}/playlistItems?${params}`);
      const data = await res.json();
      if (data.error) {
        console.warn(`YouTube playlistItems warning for ${channelId}:`, data.error.message);
        break;
      }
      items.push(...(data.items || []));
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return items.map((i) => i.contentDetails?.videoId).filter(Boolean);
  } catch (err) {
    console.warn(`Failed to fetch uploads for channel ${channelId}:`, err.message, err.cause?.code || err.cause?.message || '');
    return [];
  }
}

// Fetch YouTube video statistics (views, likes, comments, duration) in batches of 50.
async function fetchVideoStats(videoIds, apiKey) {
  if (!apiKey || !videoIds.length) return [];
  const results = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const params = new URLSearchParams({
      part: 'snippet,statistics,contentDetails',
      id: chunk.join(','),
      key: apiKey,
    });
    const res = await fetch(`${YT_API}/videos?${params}`);
    if (!res.ok) {
      const err = await res.text();
      let errMsg = err;
      try {
        const errJson = JSON.parse(err);
        if (errJson.error?.message) errMsg = errJson.error.message;
      } catch {}
      throw new Error(`YouTube API error (${res.status}): ${errMsg.slice(0, 200)}`);
    }
    const data = await res.json();
    if (data.error) {
      throw new Error(`YouTube API error: ${data.error.message || JSON.stringify(data.error)}`);
    }
    if (data.items) results.push(...data.items);
  }
  return results;
}

// Average views/hour per value of key(video); videos without that value are left out.
const leaderboard = (videos, key) => {
  const groups = new Map();
  for (const v of videos) {
    const k = key(v);
    if (k) groups.set(k, [...(groups.get(k) || []), v]);
  }
  return [...groups].map(([name, vs]) => ({
    name,
    videos: vs.length,
    views: vs.reduce((n, v) => n + v.views, 0),
    views_per_hour: Math.round(vs.reduce((n, v) => n + v.views_per_hour, 0) / vs.length),
  })).sort((a, b) => b.views_per_hour - a.views_per_hour);
};

// drafts: our metadata.json files or channel upload entries; items: YouTube videos.list items.
export function rankChannel(drafts, items, now = Date.now()) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const videoId = (d) => d.youtube?.video_id || d.video_id || d.youtube_id;

  const videos = drafts.filter((d) => byId.has(videoId(d))).map((d) => {
    const yt = byId.get(videoId(d));
    const views = Number(yt.statistics?.viewCount || 0);
    const hours = Math.max(1, (now - new Date(yt.snippet?.publishedAt).getTime()) / 3600000);
    const duration = parseIsoDuration(yt.contentDetails?.duration);
    const url = d.youtube?.url || d.url || (duration > 0 && duration <= 180 ? `https://www.youtube.com/shorts/${yt.id}` : `https://www.youtube.com/watch?v=${yt.id}`);

    return {
      draft_id: d.draft_id || yt.id,
      video_id: yt.id,
      url,
      title: yt.snippet?.title || '',
      thumbnail: yt.snippet?.thumbnails?.medium?.url || yt.snippet?.thumbnails?.default?.url || '',
      published_at: yt.snippet?.publishedAt || '',
      duration_s: duration,
      format: duration > 0 && duration <= 180 ? 'short' : 'video',
      views,
      likes: Number(yt.statistics?.likeCount || 0),
      comments: Number(yt.statistics?.commentCount || 0),
      views_per_hour: Math.round(views / hours),
      voice: d.voice || '',
      instruct: d.instruct || '',
      theme: d.theme || '',
      visual_style: d.product?.visual_style || d.visual_style || '',
    };
  }).sort((a, b) => b.views_per_hour - a.views_per_hour);

  return {
    scanned_at: new Date(now).toISOString(),
    published: drafts.length,
    videos,
    best: {
      voices: leaderboard(videos, (v) => v.voice),
      styles: leaderboard(videos, (v) => v.instruct && `${v.voice}|${v.instruct}`)
        .map((s) => ({ ...s, voice: s.name.split('|')[0], instruct: s.name.slice(s.name.indexOf('|') + 1) })),
      themes: leaderboard(videos, (v) => v.theme),
    },
  };
}


export async function scanChannel(channelOrReq = null) {
  let targetChannel = null;
  if (channelOrReq && typeof channelOrReq === 'object') {
    // Express requests also carry an .id (request id), so test for a request first.
    if (channelOrReq.headers || channelOrReq.query) {
      targetChannel = getActiveChannel(channelOrReq);
    } else if (channelOrReq.id) {
      targetChannel = channelOrReq;
    }
  }
  if (!targetChannel) targetChannel = getActiveChannel();

  const apiKey = targetChannel?.api_key || targetChannel?.youtube_api_key;
  if (!apiKey) {
    throw new Error('YOUTUBE_API_KEY is not set for this channel. Add it to channel settings to scan video performance.');
  }

  const channelId = targetChannel?.id || 'default';
  const ytChannelId = targetChannel?.youtube_channel_id || targetChannel?.token?.channel_id || (targetChannel?.id?.startsWith('UC') ? targetChannel.id : null) || getChannelId();

  const knownMap = new Map();

  // 1. Recover previously cached metadata so voice/instruct/theme associations are preserved
  const cached = readCachedChannel(targetChannel);
  if (cached?.videos && Array.isArray(cached.videos)) {
    for (const v of cached.videos) {
      const vid = v.video_id;
      if (vid) {
        knownMap.set(vid, {
          draft_id: v.draft_id || vid,
          voice: v.voice || '',
          instruct: v.instruct || '',
          theme: v.theme || '',
          visual_style: v.visual_style || '',
          url: v.url,
          youtube: { video_id: vid, url: v.url },
        });
      }
    }
  }

  // 2. Discover local disk drafts (freshest local metadata)
  const diskDrafts = readPublishedDrafts(channelId !== 'default' ? channelId : null);
  for (const d of diskDrafts) {
    const vid = d.youtube?.video_id || d.video_id || d.youtube_id;
    if (vid) {
      knownMap.set(vid, {
        draft_id: d.draft_id,
        voice: d.voice || '',
        instruct: d.instruct || '',
        theme: d.theme || '',
        visual_style: d.product?.visual_style || d.visual_style || '',
        url: d.youtube?.url || d.url,
        youtube: d.youtube || { video_id: vid, url: d.url },
      });
    }
  }

  // 3. Scan YouTube channel uploads directly so published videos are found even if local drafts aren't on disk
  if (ytChannelId) {
    const channelVideoIds = await fetchChannelUploadVideoIds(apiKey, ytChannelId);
    for (const vid of channelVideoIds) {
      if (!knownMap.has(vid)) {
        knownMap.set(vid, {
          draft_id: vid,
          voice: '',
          instruct: '',
          theme: '',
          visual_style: '',
          url: `https://www.youtube.com/shorts/${vid}`,
          youtube: { video_id: vid, url: `https://www.youtube.com/shorts/${vid}` },
        });
      }
    }
  }

  const drafts = [...knownMap.values()];
  const ids = Array.from(new Set(drafts.map((d) => d.youtube?.video_id || d.video_id || d.youtube_id).filter(Boolean)));
  const ytVideos = await fetchVideoStats(ids, apiKey);
  const report = {
    channel_id: channelId,
    channel_name: targetChannel?.name || 'Default Channel',
    ...rankChannel(drafts, ytVideos),
  };
  // G3: keep the numbers over time, so videos can be compared at the same age (1, 2, 7, 28 days).
  report.videos = recordAndAttach(snapshotFile(TRENDS_DIR, channelId), report.videos);

  const cacheFile = getChannelCacheFile(channelId);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(report, null, 2));

  if (channelId === 'default') {
    try {
      fs.writeFileSync(LEGACY_CACHE_FILE, JSON.stringify(report, null, 2));
    } catch {}
  }

  return report;
}

// G3 stats watcher: called from the host dashboard's schedule loop (every minute). Rescans each channel that has its own
// API key at most once per WATCH_INTERVAL_MS (also after a failed attempt). Reads public numbers only; never uploads.
export const WATCH_INTERVAL_MS = 3 * 60 * 60 * 1000;
const lastWatch = new Map();
export async function channelWatchRun(now = Date.now(), { channels = getAllChannels, scan = scanChannel, cached = readCachedChannel, log = console.warn } = {}) {
  const done = [];
  for (const channel of (channels() || []).filter((c) => c?.id && (c.api_key || c.youtube_api_key))) {
    const scannedAt = Date.parse(cached(channel)?.scanned_at);
    const last = Math.max(lastWatch.get(channel.id) || 0, Number.isFinite(scannedAt) ? scannedAt : 0);
    if (now - last < WATCH_INTERVAL_MS) continue;
    lastWatch.set(channel.id, now);
    try { await scan(channel); done.push(channel.id); } catch (err) { log(`channel watch ${channel.id} failed: ${err?.message || err}`); }
  }
  return done;
}

export function readCachedChannel(channelOrReq = null, optionsOrTrendsDir = {}) {
  let targetChannel = null;
  if (channelOrReq && typeof channelOrReq === 'object') {
    if (channelOrReq.headers || channelOrReq.query) targetChannel = getActiveChannel(channelOrReq);
    else if (channelOrReq.id) targetChannel = channelOrReq;
  } else if (typeof channelOrReq === 'string') {
    targetChannel = { id: channelOrReq };
  }
  if (!targetChannel) targetChannel = getActiveChannel();

  let trendsDir = TRENDS_DIR;
  if (typeof optionsOrTrendsDir === 'string') {
    trendsDir = optionsOrTrendsDir;
  } else if (optionsOrTrendsDir && typeof optionsOrTrendsDir === 'object' && optionsOrTrendsDir.trendsDir) {
    trendsDir = optionsOrTrendsDir.trendsDir;
  } else if (channelOrReq && typeof channelOrReq === 'object' && channelOrReq.trendsDir) {
    trendsDir = channelOrReq.trendsDir;
  }

  const channelId = targetChannel?.id || 'default';
  if (channelId !== 'default' && !isSafeId(channelId)) return null;
  const cacheFile = getChannelCacheFile(channelId, trendsDir);
  const legacyCacheFile = path.join(trendsDir, 'channel_performance.json');
  if (!fs.existsSync(cacheFile)) {
    if (channelId === 'default' && fs.existsSync(legacyCacheFile)) {
      try {
        const legacy = JSON.parse(fs.readFileSync(legacyCacheFile, 'utf8'));
        if (legacy?.videos?.length) return legacy;
      } catch {}
    }
    return null;
  }
  try {
    const report = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if ((!report?.videos || report.videos.length === 0) && channelId === 'default' && fs.existsSync(legacyCacheFile)) {
      try {
        const legacy = JSON.parse(fs.readFileSync(legacyCacheFile, 'utf8'));
        if (legacy?.videos?.length) return legacy;
      } catch {}
    }
    return report;
  } catch {
    return null;
  }
}

export async function getChannelHandler(req, res) {
  try {
    const report = readCachedChannel(req);
    res.json(report || { scanned_at: null, published: 0, videos: [], best: { voices: [], styles: [], themes: [] } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function scanChannelHandler(req, res) {
  try {
    const report = await scanChannel(req);
    res.json(report);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
