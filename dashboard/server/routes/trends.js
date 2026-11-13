import { enforceWhatIfPremise } from './studioPlan.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askGemini, getLastGeminiFallback, GEMINI_MID_MODEL, GEMINI_LITE_MODEL } from './gemini.js';
import { getChannelYouTubeApiKey } from './channelsManager.js';
import { QWEN_SPEAKERS } from '../episode/voice.js';

// Who a theme may suggest as narrator: the Qwen3 built-in speakers.
const narrators = () => [...QWEN_SPEAKERS];
import { sendGeneric5xx } from './redact.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = process.env.FORGEAI_ROOT || path.resolve(__dirname, '../../../');
const TRENDS_DIR = path.join(REPO_ROOT, 'data/trends');
const YT_API = 'https://www.googleapis.com/youtube/v3';
const FRESH_MS = 12 * 60 * 60 * 1000;
// Only learn from longer Shorts (1-3 min) that are still trending; the 15-50s ones are mostly loops and clips.
const MIN_SHORT_SECONDS = 60;

export const AUDIENCES = {
  preschool: {
    label: 'Preschool (2–5)',
    // Quoted phrases: unquoted words match anything (e.g. "funny" pulled in adult comedy).
    query: '"nursery rhymes"|"toddler learning"|"kids songs"|"baby animals"|"colors for kids"',
    brief: 'preschoolers aged 2-5: bright friendly colors, cute animals and simple shapes, counting, colors, gentle music and sing-along rhythm, slow calm motion, nothing scary.',
  },
  kids: {
    label: 'Kids (6–12)',
    query: '"for kids"|"kids cartoon"|"satisfying for kids"|"kids challenge"|"funny animals for kids"',
    brief: 'kids aged 6-12: funny animals, oddly satisfying, surprising transformations, mini challenges, playful sound effects, high energy but never violent or scary.',
  },
};

// Safety rules appended to every kids concept and trend analysis.
export const KIDS_SAFETY = `This is made-for-kids content. Strict rules: no violence, danger, scary or creepy imagery, no horror, no weapons, no real children, no unsafe stunts kids could copy, no food/toy brands, and NO existing characters or IP (no Peppa, Bluey, Cocomelon, Disney, Pokemon, Minecraft, Roblox, Skibidi, etc.); invent original characters instead.`;

const fileFor = (age) => path.join(TRENDS_DIR, `kids_${age}.json`);

export function parseIsoDuration(iso) {
  const m = String(iso || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

// Keeps short videos (Shorts are at most 3 min) and ranks by views per hour since upload.
export function rankShorts(items, now = Date.now()) {
  return items
    .map((v) => {
      const views = Number(v.statistics?.viewCount || 0);
      const hours = Math.max(1, (now - new Date(v.snippet.publishedAt).getTime()) / 3600000);
      return {
        id: v.id,
        title: v.snippet.title,
        description: v.snippet.description || '',
        channel: v.snippet.channelTitle,
        thumbnail: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url,
        url: `https://www.youtube.com/shorts/${v.id}`,
        published_at: v.snippet.publishedAt,
        duration_s: parseIsoDuration(v.contentDetails?.duration),
        views,
        likes: Number(v.statistics?.likeCount || 0),
        views_per_hour: Math.round(views / hours),
        made_for_kids: Boolean(v.status?.madeForKids),
      };
    })
    .filter((v) => v.duration_s > 0 && v.duration_s <= 180)
    .sort((a, b) => b.views_per_hour - a.views_per_hour);
}

// The last `days` days' most-viewed matching Shorts, 1-3 min, ranked by views/hour.
// search.list costs 100 quota units; videos.list costs 1. Free daily quota is 10,000.
async function searchShorts(q, safeSearch, apiKey = undefined, days = 7, durationRange = null) {
  const key = (apiKey !== undefined ? apiKey : getChannelYouTubeApiKey())?.trim();
  if (!key) throw new Error('Scanning YouTube needs an API key configured in channel settings.');
  const publishedAfter = new Date(Date.now() - days * 24 * 3600000).toISOString();
  const search = new URLSearchParams({
    key, part: 'snippet', type: 'video', videoDuration: 'short', order: 'viewCount',
    safeSearch, relevanceLanguage: 'en', regionCode: 'US', maxResults: '50', publishedAfter, q,
  });
  const found = await fetch(`${YT_API}/search?${search}`).then((r) => r.json());
  if (found.error) throw new Error(`YouTube search: ${found.error.message}`);
  const ids = (found.items || []).map((i) => i.id.videoId).filter(Boolean);
  if (ids.length === 0) return [];

  const details = new URLSearchParams({ key, part: 'snippet,statistics,contentDetails,status', id: ids.join(',') });
  const videos = await fetch(`${YT_API}/videos?${details}`).then((r) => r.json());
  if (videos.error) throw new Error(`YouTube videos: ${videos.error.message}`);
  const range = durationRange || { min_seconds: MIN_SHORT_SECONDS, max_seconds: 180 };
  return rankShorts(videos.items || []).filter((v) => v.duration_s >= range.min_seconds && v.duration_s <= range.max_seconds);
}

async function fetchYouTubeShorts(age, apiKey = undefined) {
  // Only trust videos the uploader declared "made for kids" (YouTube's COPPA flag); search terms alone let adult content in.
  return (await searchShorts(`${AUDIENCES[age].query} #shorts`, 'strict', apiKey)).filter((v) => v.made_for_kids).slice(0, 12);
}

const ANALYSIS_FORMAT = `Return ONLY a JSON object: {"patterns": string[] (4-6 short observations about what makes these videos work: formats, hooks, sounds, pacing, themes), "concepts": [{"title": string, "idea": string (1-2 sentences describing an ORIGINAL 5-second vertical AI video we could make)}] (exactly 5)}.`;

export async function scanKidsTrends(age, optionsOrKey = {}) {
  if (!AUDIENCES[age]) throw new Error(`Unknown audience "${age}"`);
  const audience = AUDIENCES[age];
  const apiKey = typeof optionsOrKey === 'string' ? optionsOrKey : optionsOrKey?.apiKey;
  const key = (apiKey !== undefined ? apiKey : getChannelYouTubeApiKey())?.trim();
  let source;
  let videos = [];
  let analysis;

  if (key) {
    source = 'youtube';
    videos = await fetchYouTubeShorts(age, key);
    if (videos.length) {
      const list = videos
        .map((v, i) => `${i + 1}. "${v.title}" by ${v.channel}: ${v.views.toLocaleString()} views, ${v.views_per_hour.toLocaleString()} views/hour, ${v.duration_s}s`)
        .join('\n');
      const prompt = `These are the fastest-growing 1-3 minute YouTube Shorts made for ${audience.brief} from the last 7 days:\n${list}\n\n${KIDS_SAFETY}\n\nAnalyse what is working and propose 5 fresh, original video ideas that fit these patterns.\n${ANALYSIS_FORMAT}`;
      try {
        analysis = await askGemini(prompt, { maxTokens: 2048, model: GEMINI_LITE_MODEL });
      } catch (err) {
        console.warn('Gemini trend analysis failed, falling back to basic patterns:', err.message);
      }
    }
  }

  if (!analysis) {
    source = 'rules';
    analysis = {
      patterns: [
        'Single character facing a gentle puzzle or surprise',
        'Strong primary colors and soft rounded geometry',
        'Repetitive, rhythmic sound cues',
        'Zero dialogue; physical and visual storytelling',
        'Slow camera motion keeping the focal subject clear',
      ],
      concepts: [
        { title: 'Dancing Polka Dots', idea: 'Three giant colorful dots roll into frame, bounce to a rhythm, and gently transform into friendly smiling animal faces.' },
        { title: 'The Sleepy Little Train', idea: 'A soft pastel steam train chugs along a rainbow hill, yawning and collecting glowing star lanterns on its way.' },
        { title: 'Fruit Orchestra', idea: 'An apple, a banana and an orange take turns tapping their feet to a bright xylophone beat.' },
        { title: 'Magic Paint Splash', idea: 'A single paintbrush taps an empty canvas, sending ripple waves of cheerful yellow and sky blue across the screen.' },
        { title: 'Gentle Cloud Hug', idea: 'Two fluffy, smiling clouds float toward each other, share a warm hug, and sprinkle glowing stardust down.' },
      ],
    };
  }

  const result = {
    age,
    audience: audience.label,
    source,
    scanned_at: new Date().toISOString(),
    videos,
    patterns: analysis.patterns || [],
    concepts: analysis.concepts || [],
  };
  fs.mkdirSync(TRENDS_DIR, { recursive: true });
  fs.writeFileSync(fileFor(age), JSON.stringify(result, null, 2));
  return result;
}

const knownAge = (age) => typeof age === 'string' && Object.hasOwn(AUDIENCES, age);

function readKidsTrends(age) {
  if (age !== undefined && !knownAge(age)) return null; // the age becomes a file name: allowlist only (KAN-427 F2)
  try {
    return JSON.parse(fs.readFileSync(fileFor(age), 'utf8'));
  } catch {
    return null;
  }
}

// Used by Auto-Pilot: reuse a scan from the last 12h, otherwise scan again.
export async function freshKidsTrends(age, optionsOrKey = {}) {
  const cached = readKidsTrends(age);
  if (cached && Date.now() - new Date(cached.scanned_at).getTime() < FRESH_MS && cached.concepts.length) return cached;
  return scanKidsTrends(age, optionsOrKey);
}

export function getKidsTrendsHandler(req, res) {
  const { age } = req.query;
  if (age !== undefined && !knownAge(age)) return res.status(400).json({ error: `Unknown audience (use ${Object.keys(AUDIENCES).join(' or ')})` });
  res.json(readKidsTrends(req.query.age) || { age: req.query.age, scanned_at: null, videos: [], patterns: [], concepts: [] });
}

export async function scanKidsTrendsHandler(req, res) {
  try {
    res.json(await scanKidsTrends(req.body?.age, { apiKey: getChannelYouTubeApiKey(req?.channel || req) }));
  } catch (err) {
    if (err.message && err.message.startsWith('Unknown audience')) {
      return res.status(400).json({ error: err.message });
    }
    sendGeneric5xx(req, res, 502, err);
  }
}

// ---- Trending themes for Studio: what longer (1-3 min) Shorts are growing fastest this week ----
export const THEMES_FILE = path.join(TRENDS_DIR, 'themes.json');
export const DEFAULT_THEME_NICHE = 'mystery, history, true story, science facts';
export const THEMES_TTL_MS = 60 * 60 * 1000; // 1 hour (3,600,000 ms)
export const THEMES_MAX_RUNS = 5;

const DISCOVERY_PROFILE_KEYS = ['version', 'family_id', 'duration_range'];
const DURATION_RANGE_KEYS = ['min_seconds', 'max_seconds'];
export function validateDiscoveryProfile(raw) {
  if (raw === undefined) return null;
  const invalid = () => { throw new TypeError('Invalid discovery profile.'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Reflect.ownKeys(raw).some((key) => typeof key !== 'string' || !DISCOVERY_PROFILE_KEYS.includes(key)) ||
      DISCOVERY_PROFILE_KEYS.some((key) => !Object.hasOwn(raw, key)) || raw.version !== 1 || raw.family_id !== 'engines_automotive') invalid();
  const range = raw.duration_range;
  if (!range || typeof range !== 'object' || Array.isArray(range) || Reflect.ownKeys(range).some((key) => typeof key !== 'string' || !DURATION_RANGE_KEYS.includes(key)) ||
      DURATION_RANGE_KEYS.some((key) => !Object.hasOwn(range, key)) ||
      typeof range.min_seconds !== 'number' || !Number.isFinite(range.min_seconds) ||
      typeof range.max_seconds !== 'number' || !Number.isFinite(range.max_seconds) ||
      range.min_seconds <= 0 || range.min_seconds > range.max_seconds || range.max_seconds > 180) invalid();
  return { version: 1, family_id: 'engines_automotive', duration_range: { min_seconds: range.min_seconds, max_seconds: range.max_seconds } };
}

export function automotiveDurationBucket(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > 180) throw new RangeError('Duration is outside automotive discovery range.');
  if (seconds < 10) return 'under_10';
  if (seconds <= 30) return '10_30';
  if (seconds <= 60) return '31_60';
  return '61_180';
}

export function automotiveCacheFile(filePath, profile, niche = '', contentMode = 'factual') {
  const normalized = validateDiscoveryProfile(profile);
  return normalized ? `${filePath}.automotive-${Buffer.from(JSON.stringify({ profile: normalized, niche: String(niche).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), contentMode })).toString('base64url')}.json` : filePath;
}

const lowerMetadata = (video) => `${video?.title || ''} ${video?.topic || ''} ${video?.description || ''}`.toLowerCase();
const matchesAutomotiveTopic = (video, niche) => {
  const metadata = lowerMetadata(video);
  const query = String(niche || '').toLowerCase();
  const automotive = /\b(car|automotive|vehicle|turbocharger|turbo|piston|crankshaft|brakes?|disc brake|clutch|differential|transmission)\b/.test(metadata);
  if (/\b(unreal|chess|search|game|software)\b/.test(metadata) && /\b(engine|motor)\b/.test(metadata) && !automotive) return false;
  const matches = [
    [/turbocharger|\bturbo\b/, /\b(turbocharger|turbo)\b/], [/brake/, /\bbrakes?\b/],
    [/piston|four.?stroke/, /\b(piston|four.stroke)\b/], [/crank/, /\bcrankshaft?\b/],
    [/clutch/, /\bclutch\b/], [/differential/, /\bdifferential\b/], [/transmission/, /\btransmission\b/],
  ];
  const specific = matches.filter(([term]) => term.test(query));
  if (specific.length) return automotive && specific.some(([, re]) => re.test(metadata));
  return automotive && (!/\b(engine|motor|car|automotive)\b/.test(query) || /\b(car|automotive|vehicle|turbocharger|turbo|piston|crankshaft|brakes?|cylinder)\b/.test(metadata));
};

const observedSubject = (video) => {
  const metadata = lowerMetadata(video);
  const subjects = [];
  if (/\b(turbocharger|turbo)\b/.test(metadata)) subjects.push({ subject_id: 'turbocharger', controller_id: 'turbo_shaft_v1' });
  if (/\bbrakes?\b/.test(metadata)) subjects.push({ subject_id: 'disc_brake', controller_id: 'disc_brake_schematic_v1' });
  if (/\b(piston|four.stroke|cylinder|crankshaft)\b/.test(metadata)) subjects.push({ subject_id: 'four_stroke_single_cylinder', controller_id: 'slider_crank_four_stroke_v1' });
  return subjects.length === 1 ? subjects[0] : null;
};

export function classifyAutomotiveFormat(video, niche = '') {
  const metadata = lowerMetadata(video);
  // Explicit crash/driving categories win unless the requested topic is visibly described as a mechanism.
  const topicMatch = matchesAutomotiveTopic(video, niche);
  const mechanismEvidence = /\b(cutaway|how .* (works?|spins?|moves?|flows?|clamp?)|why .* (spins?|moves?|works?|clamp?)|mechanism explainer|inside the .* (engine|turbo|brake)|explains? how|four.stroke cycle)\b/.test(metadata);
  if (topicMatch && mechanismEvidence) return 'mechanism_explainer';
  if (/\b(crash|collision|wreck|impact simulation)\b/.test(metadata)) return 'crash_simulation';
  if (/\b(driving|drive|racing|race|drift|scenic|beauty|road trip)\b/.test(metadata)) return 'driving_beauty';
  if (/\b(vs\.?|versus|comparison|compare|difference between)\b/.test(metadata)) return 'comparison';
  if (/\b(myth|failure|fail|broken|breaks?|problem|misconception|doesn.t|won.t)\b/.test(metadata)) return 'failure_myth';
  return 'unknown';
}

export function computeFreshVelocity(observations, videoId, now = Date.now()) {
  const entries = (Array.isArray(observations) ? observations : []).filter((entry) => entry?.video_id === videoId)
    .slice(-2);
  if (entries.length !== 2) return null;
  const [previous, current] = entries;
  const older = Date.parse(previous.observed_at), newer = Date.parse(current.observed_at);
  if (!Number.isFinite(older) || !Number.isFinite(newer) || newer <= older || newer > now ||
      !Number.isFinite(previous.views) || !Number.isFinite(current.views) || previous.views < 0 || current.views < previous.views) return null;
  return Math.round(((current.views - previous.views) / ((newer - older) / 3600000)) * 100) / 100;
}

function automotiveCandidate(video, niche, observations, scannedAt) {
  const format = classifyAutomotiveFormat(video, niche);
  const subject = observedSubject(video);
  const fallback = { turbocharger: { subject_id: 'turbocharger', controller_id: 'turbo_shaft_v1' }, disc_brake: { subject_id: 'disc_brake', controller_id: 'disc_brake_schematic_v1' }, four_stroke_single_cylinder: { subject_id: 'four_stroke_single_cylinder', controller_id: 'slider_crank_four_stroke_v1' } }[String(niche).toLowerCase().trim()];
  const requirements = format === 'mechanism_explainer' ? (subject || fallback || null) : null;
  const subjectName = requirements?.subject_id.replaceAll('_', ' ') || 'automotive mechanism';
  const demonstration = requirements?.subject_id === 'turbocharger'
    ? 'Show exhaust flow turning the turbine wheel, its shared shaft turning the compressor wheel, and intake flow being compressed.'
    : requirements?.subject_id === 'disc_brake'
      ? 'Show opposing pads approach a rotating disc, contact, and the disc slow while pads remain clamped.'
      : requirements?.subject_id === 'four_stroke_single_cylinder'
        ? 'Show the piston, connecting rod, and crank move together through one labelled four-stroke cycle.'
        : 'Choose one visible causal relationship and present it as an original bounded schematic demonstration.';
  const brief = `Create an original ${format.replaceAll('_', ' ')} about ${subjectName}. ${demonstration} Use metadata only as a discovery lead; verify engineering background facts independently. Write new narration and visuals; do not reuse the source title, script, frames, footage, or model.`;
  const trend = windowTrend([{ ...video, views_per_hour: Number(video.views_per_hour) || 0 }], Date.parse(scannedAt));
  return {
    id: video.id, source_video_url: video.url, source_video_id: video.id,
    observed_metadata: { title: video.title, description: video.description || '', channel: video.channel, duration_s: video.duration_s, views: video.views, likes: video.likes, published_at: video.published_at },
    observed_at: scannedAt, duration_bucket: automotiveDurationBucket(video.duration_s),
    inferred_format: format, format_inferred: true, evidence_basis: 'metadata_only',
    lifetime_average_views_per_hour: video.lifetime_average_views_per_hour ?? video.views_per_hour ?? null,
    current_growth_views_per_hour: computeFreshVelocity(observations, video.id, Date.parse(scannedAt)),
    trend,
    channel_relative_evidence: { status: 'unavailable', score: null },
    original_brief: brief,
    novelty_explanation: `Original ${format.replaceAll('_', ' ')} demonstration for ${subjectName}; metadata is not engineering verification.`,
    required_subject_controller: requirements,
    required_render_capabilities: requirements ? ['validated_mechanism_definition', 'supported_controller', 'original_required_parts', 'verified_source_package'] : ['mechanism_kinematics_review', 'validated_mechanism_definition', 'verified_source_package'],
    feasibility_reasons: requirements ? ['Discovery candidate only; server mechanism and source readiness gates remain pending.'] : ['Mechanism or kinematics cannot be established from metadata; needs_review.'],
    discovery_feasibility: 'pending_server_gate',
    mechanism_feasibility: format === 'unknown' || (format === 'mechanism_explainer' && !requirements) ? 'needs_review' : 'pending_server_gate',
    render_readiness: 'pending_server_gate',
  };
}

export function validateContentMode(contentMode) {
  if (contentMode === undefined) return 'factual';
  if (contentMode === 'factual' || contentMode === 'whatif') return contentMode;
  throw new TypeError('Invalid content mode. Use "factual" or "whatif".');
}

export const getThemesFilePath = (contentMode) => {
  contentMode = validateContentMode(contentMode);
  if (process.env.FORGEAI_THEMES_FILE) return process.env.FORGEAI_THEMES_FILE;
  if (contentMode === 'whatif') {
    return path.join(TRENDS_DIR, `themes_${contentMode}.json`);
  }
  return THEMES_FILE;
};

export function readThemes(filePath = getThemesFilePath()) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function writeThemes(data, filePath = getThemesFilePath()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return data;
}

export function isThemesCacheValid(cached, { niche = '', maxAgeMs = THEMES_TTL_MS, maxRuns = THEMES_MAX_RUNS, now = Date.now(), contentMode = 'factual' } = {}) {
  if (!cached || typeof cached !== 'object') return false;
  if (!Array.isArray(cached.themes) || cached.themes.length === 0) return false;
  if (!cached.scanned_at) return false;

  const scannedTime = new Date(cached.scanned_at).getTime();
  if (Number.isNaN(scannedTime)) return false;

  const age = now - scannedTime;
  if (age < 0 || age >= maxAgeMs) return false;

  const runsCount = typeof cached.runs_count === 'number' ? cached.runs_count : 0;
  if (runsCount >= maxRuns) return false;

  const want = niche || cached.niche || DEFAULT_THEME_NICHE;
  if (cached.niche && want && cached.niche !== want) return false;

  const cachedMode = cached.contentMode || cached.content_mode || 'factual';
  const wantMode = contentMode || 'factual';
  if (cachedMode !== wantMode) return false;

  return true;
}

// "a, b c" -> '"a"|"b c"': quoted so each phrase is matched whole (YouTube's OR syntax).
export const themeQuery = (niche) => `${String(niche).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6).map((s) => `"${s.replace(/"/g, '')}"`).join('|')} #shorts`;

// Themes are rated on three upload windows: the day and week drive the pick, the month is mostly an indicator.
export const TREND_WINDOWS = { day: { days: 1, weight: 0.5 }, week: { days: 7, weight: 0.4 }, month: { days: 30, weight: 0.1 } };
const windowOf = (v, now) => Object.keys(TREND_WINDOWS).find((w) => now - new Date(v.published_at).getTime() <= TREND_WINDOWS[w].days * 864e5) || 'month';

// Average views/hour of a theme's example videos uploaded within each window (0 when it has none there).
export function windowTrend(videos, now = Date.now()) {
  return Object.fromEntries(Object.entries(TREND_WINDOWS).map(([w, { days }]) => {
    const inWindow = videos.filter((v) => now - new Date(v.published_at).getTime() <= days * 864e5);
    return [w, inWindow.length ? Math.round(inWindow.reduce((n, v) => n + v.views_per_hour, 0) / inWindow.length) : 0];
  }));
}

// score 0-1: each window scaled to its best theme (a day-old video's views/hour always beats a month-old one's), then weighted.
export function scoreThemes(themes) {
  const max = Object.fromEntries(Object.keys(TREND_WINDOWS).map((w) => [w, Math.max(0, ...themes.map((t) => t.trend[w]))]));
  return themes
    .map((t) => ({ ...t, score: +Object.entries(TREND_WINDOWS).reduce((s, [w, { weight }]) => s + (max[w] ? (weight * t.trend[w]) / max[w] : 0), 0).toFixed(3) }))
    .sort((a, b) => b.score - a.score);
}

export async function scanThemes(niche = DEFAULT_THEME_NICHE, optionsOrKey = {}) {
  const discoveryProfile = validateDiscoveryProfile(typeof optionsOrKey === 'object' && optionsOrKey !== null ? optionsOrKey.discovery_profile : undefined);
  const contentMode = validateContentMode(typeof optionsOrKey === 'object' && optionsOrKey !== null
    ? (Object.hasOwn(optionsOrKey, 'contentMode') ? optionsOrKey.contentMode : optionsOrKey.content_mode)
    : undefined);
  const model = (typeof optionsOrKey === 'object' && optionsOrKey.model) || GEMINI_MID_MODEL;
  const apiKey = typeof optionsOrKey === 'string' ? optionsOrKey : optionsOrKey?.apiKey;
  const searchVideos = typeof optionsOrKey?.searchShorts === 'function' ? optionsOrKey.searchShorts : searchShorts;
  const ask = typeof optionsOrKey?.ask === 'function' ? optionsOrKey.ask : askGemini;
  const hasSearchStub = searchVideos !== searchShorts;
  const baseThemesFile = (typeof optionsOrKey === 'object' && optionsOrKey.themesFile) || getThemesFilePath(contentMode);
  const themesFile = optionsOrKey?._resolvedDiscoveryCache ? baseThemesFile : automotiveCacheFile(baseThemesFile, discoveryProfile || undefined, niche, contentMode);
  const initialRunsCount = (typeof optionsOrKey === 'object' && typeof optionsOrKey.runs_count === 'number')
    ? optionsOrKey.runs_count
    : 0;
  const key = (apiKey !== undefined ? apiKey : getChannelYouTubeApiKey())?.trim();
  if (!key && !hasSearchStub) throw new Error('Scanning YouTube needs an API key configured in channel settings.');
  // One search per window (~300 quota units), top 12 of each, merged.
  const found = await Promise.all(Object.values(TREND_WINDOWS).map(({ days }) => searchVideos(themeQuery(niche), 'moderate', key, days, discoveryProfile?.duration_range)));
  const minimumSeconds = discoveryProfile?.duration_range.min_seconds ?? MIN_SHORT_SECONDS;
  const maximumSeconds = discoveryProfile?.duration_range.max_seconds ?? 180;
  const videos = [...new Map(found.flatMap((list) => list.slice(0, 12))
    .filter((v) => v?.id && Number.isFinite(v.duration_s) && v.duration_s >= minimumSeconds && v.duration_s <= maximumSeconds)
    .filter((v) => !discoveryProfile || (Number.isFinite(v.views) && v.views >= 0))
    .filter((v) => !discoveryProfile || matchesAutomotiveTopic(v, niche))
    .map((v) => [v.id, v])).values()].sort((a, b) => b.views_per_hour - a.views_per_hour);
  if (videos.length < (discoveryProfile ? 1 : 3)) throw new Error(`Only ${videos.length} Shorts matched "${niche}" this month. Try broader niche words.`);
  const now = typeof optionsOrKey?.now === 'function' ? optionsOrKey.now() : (Number.isFinite(optionsOrKey?.now) ? optionsOrKey.now : Date.now());
  if (discoveryProfile) {
    const scannedAt = new Date(now).toISOString();
    const cached = readThemes(themesFile);
    const previousObservations = Array.isArray(cached?.observations) ? cached.observations : [];
    const recent = new Map();
    const currentIds = new Set(videos.map((video) => video.id));
    for (const item of previousObservations) {
      if (!currentIds.has(item?.video_id) || !Number.isFinite(item.views) || !Number.isFinite(Date.parse(item.observed_at))) continue;
      const list = recent.get(item.video_id) || [];
      list.push(item);
      recent.set(item.video_id, list.slice(-1));
    }
    for (const video of videos) {
      const list = recent.get(video.id) || [];
      list.push({ video_id: video.id, observed_at: scannedAt, views: video.views });
      recent.set(video.id, list.slice(-2));
    }
    const observations = [...recent.values()].flat();
    let candidates = scoreThemes(videos.map((video) => automotiveCandidate(video, niche, observations, scannedAt)));
    if (contentMode === 'whatif') {
      const prompt = `Create original, editable hypothetical explainer briefs based on these metadata-only automotive discovery leads: ${JSON.stringify(candidates.map(({ id, observed_metadata, inferred_format, required_subject_controller }) => ({ id, observed_metadata, inferred_format, required_subject_controller })))}. Do not treat source metadata as engineering fact verification. For each candidate return a distinct topic, one explicit question starting "What if", and 1-3 explicit assumptions. The premise must describe a hypothetical outcome, not real history. Independently verified background facts remain required. Return JSON {"briefs":[{"id":"...","topic":"...","premise":"What if ...?","assumptions":["..."]}]}.`;
      const analysis = await ask(prompt, { maxTokens: 2048, model: GEMINI_LITE_MODEL });
      const briefs = new Map((Array.isArray(analysis?.briefs) ? analysis.briefs : []).map((item) => [item.id, item]));
      candidates = candidates.map((candidate) => {
        const brief = briefs.get(candidate.id);
        if (!brief || typeof brief.topic !== 'string' || !brief.topic.trim() || typeof brief.premise !== 'string' || !/^What if\b[^?]+\?$/i.test(brief.premise.trim()) || !Array.isArray(brief.assumptions) || !brief.assumptions.length || brief.assumptions.some((item) => typeof item !== 'string' || !item.trim())) return { ...candidate, whatif_valid: false, mechanism_feasibility: 'needs_review' };
        const premise = enforceWhatIfPremise(brief.premise.trim());
        return { ...candidate, topic: brief.topic.trim(), premise, assumptions: brief.assumptions.map((item) => item.trim()), whatif_label: 'Hypothetical premise; assumptions are illustrative; background facts require independent verification.', original_brief: `${candidate.original_brief}\nHypothetical premise: ${premise}\nAssumptions: ${brief.assumptions.join('; ')}`, whatif_valid: true };
      });
      if (!candidates.some((item) => item.whatif_valid)) throw new Error('What-if discovery needs an original premise and explicit assumptions for at least one candidate.');
    }
    const result = {
      niche, contentMode, discovery_profile: discoveryProfile, scanned_at: scannedAt,
      videos_scanned: videos.length, candidates, themes: candidates,
      observations, runs_count: initialRunsCount,
    };
    writeThemes(result, themesFile);
    return result;
  }
  const list = videos
    .map((v, i) => `${i + 1}. [${windowOf(v, now)}] "${v.title}" by ${v.channel}: ${v.views.toLocaleString()} views, ${v.views_per_hour.toLocaleString()} views/hour, ${v.duration_s}s`)
    .join('\n');
  const prompt = contentMode === 'whatif'
    ? `These are the fastest-growing 1-3 minute YouTube Shorts (niche: ${niche}), each tagged by upload age: [day] = last 24 hours, [week] = last 7 days, [month] = last 30 days:\n${list}\n\nGroup them into 5-10 themes for hypothetical narrated videos. For every theme, choose a real entity or subject as "topic" and create a distinct, single hypothetical premise question as "premise". A hypothetical must describe an outcome that did not happen; do not turn a real event topic into a What if question by adding a prefix. Use real entities, places, or mechanisms as background only. Do not claim the hypothetical event occurred and do not require an article about it.\nReturn ONLY JSON: {"themes": [{"name": "2-5 word theme", "why": "one sentence: why it is working", "examples": [video numbers from the list], "topic": "clean name of a real entity or subject, without a What if prefix", "premise": "one original question exactly in the form What if <hypothetical outcome>?", "hook": "an opening line under 10 words, kept separate from topic and premise", "voice": "the narrator name that best fits the theme, one of: ${narrators('fish').map((n) => `${n.name} (${n.description})`).join('; ')}", "tone": "mystery, suspense, documentary, viral_hook, or enthusiastic"}]}\nEvery premise must start with the words What if and ask one hypothetical question. Do not write a factual event premise or merely prefix a factual topic. Strongest evidence first; list matching video numbers in examples. No existing characters, brands or IP.`
    : `These are the fastest-growing 1-3 minute YouTube Shorts (niche: ${niche}), each tagged by upload age: [day] = last 24 hours, [week] = last 7 days, [month] = last 30 days:\n${list}\n\nGroup them into 5-10 recurring THEMES we could make our own narrated videos about (AI voice-over over AI images and short clips).\nReturn ONLY JSON: {"themes": [{"name": "2-5 word theme", "why": "one sentence: why it is working (hook, emotion, format)", "examples": [video numbers from the list], "topic": "one specific ORIGINAL video topic in this theme for us, never a copy of a listed video", "hook": "an opening line under 10 words", "voice": "the narrator name that best fits the theme, one of: ${narrators('fish').map((n) => `${n.name} (${n.description})`).join('; ')}. Prefer native English voices unless an accent suits the theme", "tone": "narrative tone: mystery, suspense, documentary, viral_hook, or enthusiastic"}]}\nStrongest evidence (views/hour, mostly [day] and [week]) first. List every matching video number in "examples". No existing characters, brands or IP.`;
  const analysis = await ask(prompt, { maxTokens: 4096, model });
  if (!analysis) throw new Error('Grouping themes needs GEMINI_API_KEY in .env.');

  let themes = (Array.isArray(analysis.themes) ? analysis.themes : [])
    .filter((t) => t?.name && t?.topic && (contentMode !== 'whatif' || (
      typeof t.topic === 'string' && t.topic.trim() && !/^What if\b/i.test(t.topic.trim()) &&
      typeof t.premise === 'string' && /^What if\b[^?]+\?$/i.test(t.premise.trim())
    )))
    .slice(0, 10)
    .map((t) => {
      const all = [...new Set((Array.isArray(t.examples) ? t.examples : []).map((n) => videos[Number(n) - 1]).filter(Boolean))];
      const examples = all.slice(0, 3);
      let topic = String(t.topic);
      let hook = String(t.hook || '');
      let premise;
      if (contentMode === 'whatif') {
        topic = topic.trim();
        premise = enforceWhatIfPremise(t.premise);
      }
      return {
        name: String(t.name),
        why: String(t.why || ''),
        topic,
        ...(premise && { premise }),
        hook,
        voice: String(t.voice || ''),
        tone: String(t.tone || ''),
        contentMode,
        views_per_hour: examples.length ? Math.round(examples.reduce((n, v) => n + v.views_per_hour, 0) / examples.length) : 0,
        trend: windowTrend(all, now),
        examples: examples.map(({ title, url, views, duration_s }) => ({ title, url, views, duration_s })),
      };
    });
  if (themes.length === 0) throw new Error('Gemini returned no themes; try scanning again.');
  themes = scoreThemes(themes);

  const fallbackModel = analysis?._gemini_fallback ? (analysis._gemini_model_used || getLastGeminiFallback()?.to_model) : undefined;
  const result = {
    niche,
    contentMode,
    scanned_at: new Date().toISOString(),
    videos_scanned: videos.length,
    themes,
    fallback_model: fallbackModel,
    runs_count: initialRunsCount,
  };
  writeThemes(result, themesFile);
  return result;
}

// Used by Studio auto mode: reuse a scan younger than maxAgeMs and with runs_count < maxRuns, otherwise rescan (falling back to the stale scan if that fails).
// A different niche always rescans.
export async function freshThemes(emit = () => {}, niche = '', maxAgeMs = THEMES_TTL_MS, optionsOrKey = {}) {
  const discoveryProfile = validateDiscoveryProfile(typeof optionsOrKey === 'object' && optionsOrKey !== null ? optionsOrKey.discovery_profile : undefined);
  const contentMode = (typeof optionsOrKey === 'object' && (optionsOrKey.contentMode || optionsOrKey.content_mode)) || 'factual';
  const baseThemesFile = (typeof optionsOrKey === 'object' && optionsOrKey.themesFile) || getThemesFilePath(contentMode);
  const themesFile = automotiveCacheFile(baseThemesFile, discoveryProfile || undefined, niche || DEFAULT_THEME_NICHE, contentMode);
  const maxRuns = (typeof optionsOrKey === 'object' && typeof optionsOrKey.maxRuns === 'number')
    ? optionsOrKey.maxRuns
    : THEMES_MAX_RUNS;
  const scanner = (typeof optionsOrKey === 'object' && optionsOrKey.scanner) || scanThemes;

  const cached = readThemes(themesFile);
  const want = niche || cached?.niche || DEFAULT_THEME_NICHE;

  if (isThemesCacheValid(cached, { niche: want, maxAgeMs, maxRuns, contentMode })) {
    cached.runs_count = (typeof cached.runs_count === 'number' ? cached.runs_count : 0) + 1;
    writeThemes(cached, themesFile);
    return cached;
  }

  try {
    const scanOptions = typeof optionsOrKey === 'string'
      ? { apiKey: optionsOrKey, runs_count: 1, themesFile: baseThemesFile, contentMode }
      : { ...optionsOrKey, runs_count: 1, themesFile: baseThemesFile, contentMode, ...(discoveryProfile && { discovery_profile: discoveryProfile }) };
    const fresh = await scanner(want, scanOptions);
    if (!fresh.scanned_at) fresh.scanned_at = new Date().toISOString();
    fresh.runs_count = 1;
    if (!fresh.contentMode) fresh.contentMode = contentMode;
    writeThemes(fresh, themesFile);

    if (fresh.fallback_model) {
      emit('WARN', `Gemini HTTP 503 high demand: themes generated using fallback model ${fresh.fallback_model}.`);
    }
    return fresh;
  } catch (err) {
    const cachedMode = cached?.contentMode || cached?.content_mode || 'factual';
    if (!cached?.themes?.length || cached.niche !== want || cachedMode !== contentMode) throw err;
    emit('WARN', `Theme rescan failed (${err.message}); using the scan from ${cached.scanned_at}.`);
    cached.runs_count = (typeof cached.runs_count === 'number' ? cached.runs_count : 0) + 1;
    writeThemes(cached, themesFile);
    return cached;
  }
}

export function getThemesHandler(req, res) {
  let contentMode;
  try {
    contentMode = validateContentMode(req.query && Object.hasOwn(req.query, 'contentMode') ? req.query.contentMode : req.query?.content_mode);
  } catch (err) { return res.status(400).json({ error: err.message }); }
  res.json(readThemes(getThemesFilePath(contentMode)) || { niche: DEFAULT_THEME_NICHE, contentMode, scanned_at: null, themes: [], runs_count: 0 });
}

export async function scanThemesHandler(req, res, dependencies = {}) {
  if (req.body?.niche !== undefined && typeof req.body.niche !== 'string') {
    return res.status(400).json({ error: 'niche must be a string' });
  }
  const niche = String(req.body?.niche || DEFAULT_THEME_NICHE).slice(0, 200);
  let contentMode;
  let discoveryProfile;
  try {
    discoveryProfile = validateDiscoveryProfile(req.body && Object.hasOwn(req.body, 'discovery_profile') ? req.body.discovery_profile : undefined);
    contentMode = validateContentMode(req.body && Object.hasOwn(req.body, 'contentMode') ? req.body.contentMode : req.body?.content_mode);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  try {
    const result = await scanThemes(niche, {
      apiKey: dependencies.apiKey ?? getChannelYouTubeApiKey(req), contentMode,
      themesFile: dependencies.themesFile || getThemesFilePath(contentMode),
      ...(discoveryProfile && { discovery_profile: discoveryProfile }),
      ...(dependencies.searchShorts && { searchShorts: dependencies.searchShorts }),
      ...(dependencies.ask && { ask: dependencies.ask }),
    });
    return res.json(result);
  } catch (err) {
    return sendGeneric5xx(req, res, 502, err);
  }
}
