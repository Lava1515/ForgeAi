import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askGrowth } from './askGrowth.js';
import { resolveGrowthProfile, GROWTH_PROFILES } from './profiles.js';
import { readCachedChannel } from '../routes/channel.js';
import { getChannelById } from '../routes/channelsManager.js';
import { growthFile } from './storage.js';
export { growthFile as getGrowthReportFile } from './storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = process.env.FORGEAI_ROOT || path.resolve(__dirname, '../../../');
const DEFAULT_DRAFTS_DIR = process.env.FORGEAI_DRAFTS_DIR || path.join(DEFAULT_REPO_ROOT, 'output/drafts');
const ONE_HOUR_MS = 60 * 60 * 1000;

export function loadGrowthReport(channelId = 'default', repoRoot = DEFAULT_REPO_ROOT) {
  const filePath = growthFile(channelId, repoRoot);
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`Failed to read growth report for ${channelId}:`, err.message);
    return null;
  }
}

export function saveGrowthReport(channelId = 'default', report = {}, repoRoot = DEFAULT_REPO_ROOT) {
  const filePath = growthFile(channelId, repoRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let existing = {};
  if (fs.existsSync(filePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf8')) || {};
    } catch {}
  }

  const payload = {
    ...existing,
    ...report,
    strategy: report.strategy || existing.strategy || undefined,
    ideas: report.ideas || existing.ideas || undefined,
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

/**
 * Extracts and enriches local draft metadata (retention, duration, subs gained if KAN-172 recorded them)
 */
function enrichWithLocalDraftAnalytics(videos = [], draftsDir = DEFAULT_DRAFTS_DIR) {
  if (!fs.existsSync(draftsDir) || !Array.isArray(videos)) return videos;

  const draftMetaMap = new Map();
  try {
    for (const entry of fs.readdirSync(draftsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(draftsDir, entry.name, 'metadata.json');
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          const ytId = meta.youtube?.video_id || meta.social?.platforms?.youtube_shorts?.video_id || meta.youtube_id || meta.video_id;
          if (ytId) {
            draftMetaMap.set(ytId, meta);
          }
        } catch {}
      }
    }
  } catch {}

  return videos.map((v) => {
    const dMeta = draftMetaMap.get(v.video_id) || draftMetaMap.get(v.draft_id);
    if (!dMeta) return v;

    const analytics = dMeta.youtube?.analytics || dMeta.analytics || {};
    return {
      ...v,
      retention_percent: analytics.average_view_percentage ?? v.retention_percent ?? null,
      avg_view_duration_s: analytics.average_view_duration_seconds ?? v.avg_view_duration_s ?? null,
      subscribers_gained: analytics.subscribers_gained ?? v.subscribers_gained ?? null,
    };
  });
}

function normalizeScores(auditOutput = {}, analyzeOutput = {}) {
  const auditObj = auditOutput.scores || auditOutput.audit?.scores || auditOutput.audit || {};
  const analyzeObj = analyzeOutput.scores || analyzeOutput.analysis?.scores || {};

  return {
    seo: auditObj.seo || auditObj.seo_score || 'B',
    performance: auditObj.performance || auditObj.performance_score || analyzeObj.performance || 'B',
    strategy: auditObj.strategy || auditObj.strategy_score || 'B',
    monetization: auditObj.monetization || auditObj.monetization_score || 'C',
    overall: auditObj.overall || auditObj.overall_score || 'B',
  };
}

function normalizeTopActions(analyzeOutput = {}, auditOutput = {}) {
  const rawActions = [];

  if (Array.isArray(analyzeOutput.top_actions)) {
    rawActions.push(...analyzeOutput.top_actions);
  } else if (Array.isArray(analyzeOutput.analysis?.priority_actions)) {
    rawActions.push(...analyzeOutput.analysis.priority_actions);
  }

  if (Array.isArray(auditOutput.top_actions)) {
    rawActions.push(...auditOutput.top_actions);
  } else if (Array.isArray(auditOutput.audit?.action_plan)) {
    rawActions.push(...auditOutput.audit.action_plan);
  }

  const actions = [];
  const seen = new Set();
  for (const a of rawActions) {
    if (!a) continue;
    const text = typeof a === 'string' ? a : a.action || a.title || a.description || '';
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());

    actions.push({
      action: text,
      impact: a.impact || 'high',
      effort: a.effort || 'medium',
      category: a.category || a.area || 'growth',
      details: a.details || a.reason || '',
    });
    if (actions.length >= 5) break;
  }

  if (actions.length === 0) {
    actions.push({
      action: 'Optimize hook pacing in first 3 seconds of new shorts',
      impact: 'high',
      effort: 'medium',
      category: 'hook',
      details: 'Ensure visual or vocal state change occurs before 3s mark',
    });
  }

  return actions;
}

function normalizeNextSubskill(analyzeOutput = {}, auditOutput = {}) {
  const cand = analyzeOutput.next_subskill || auditOutput.next_subskill;
  if (cand && typeof cand === 'object' && cand.id) {
    return {
      id: cand.id,
      label: cand.label || cand.id.charAt(0).toUpperCase() + cand.id.slice(1),
      reason: cand.reason || 'Recommended based on latest channel diagnostic',
    };
  }
  if (typeof cand === 'string' && cand.trim()) {
    const id = cand.trim().toLowerCase();
    return {
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      reason: 'Recommended next sub-skill from channel analysis',
    };
  }

  return {
    id: 'hook',
    label: 'Hook & Retention',
    reason: 'Initial hook optimization yields highest viewer retention lift',
  };
}

/**
 * generateGrowthReport(channelOrId, options)
 *
 * Runs askGrowth('analyze') and askGrowth('audit') over cached channel scan data.
 * Does NOT call YouTube API.
 * Rate limited to once per hour unless force is true.
 * A failing or malformed model answer never overwrites a good report.
 */
export async function generateGrowthReport(channelOrId, {
  repoRoot = DEFAULT_REPO_ROOT,
  draftsDir = DEFAULT_DRAFTS_DIR,
  cachedChannelData = undefined,
  askGrowthFn = askGrowth,
  force = false,
  now = Date.now(),
} = {}) {
  let channel = null;
  if (channelOrId && typeof channelOrId === 'object') {
    channel = channelOrId;
  } else if (typeof channelOrId === 'string') {
    channel = getChannelById(channelOrId) || { id: channelOrId, name: channelOrId };
  } else {
    channel = { id: 'default', name: 'ForgeAI (Primary)' };
  }

  const channelId = channel.id || 'default';
  const profileKey = resolveGrowthProfile(channel);
  const profileConfig = GROWTH_PROFILES[profileKey] || GROWTH_PROFILES.narrative;

  // 1. Check existing stored report
  const existingReport = loadGrowthReport(channelId, repoRoot);
  if (existingReport && !force && existingReport.generated_at) {
    const ageMs = now - new Date(existingReport.generated_at).getTime();
    if (ageMs < ONE_HOUR_MS) {
      return {
        ...existingReport,
        cached: true,
      };
    }
  }

  // 2. Read cached channel data (NO YouTube call!)
  let cached = cachedChannelData !== undefined
    ? cachedChannelData
    : readCachedChannel(channel);

  if (!cached || !cached.videos || !Array.isArray(cached.videos) || cached.videos.length === 0) {
    return {
      channel_id: channelId,
      channel_name: channel.name || 'Channel',
      profile: profileKey,
      profile_name: profileConfig.name,
      generated_at: null,
      empty: true,
      reason: 'no_scan_data',
      message: 'No channel scan found. Run a channel scan first to populate performance data.',
      baseline: {
        shorts_count: 0,
        total_views: 0,
        subscribers: channel.subscribers || channel.subscriber_count || 0,
      },
      scores: null,
      top_actions: [],
      next_subskill: null,
      strategy: existingReport?.strategy || undefined,
      ideas: existingReport?.ideas || undefined,
    };
  }

  // 3. Prepare analysis input from cache and local drafts
  const enrichedVideos = enrichWithLocalDraftAnalytics(cached.videos, draftsDir);
  const shortsVideos = enrichedVideos.filter((v) => v.format === 'short' || (v.duration_s && v.duration_s <= 180));
  const shortsCount = shortsVideos.length > 0 ? shortsVideos.length : enrichedVideos.length;
  const totalViews = enrichedVideos.reduce((sum, v) => sum + (Number(v.views) || 0), 0);
  const totalLikes = enrichedVideos.reduce((sum, v) => sum + (Number(v.likes) || 0), 0);
  const totalComments = enrichedVideos.reduce((sum, v) => sum + (Number(v.comments) || 0), 0);
  const subscribers = Number(channel.subscribers || channel.subscriber_count) || 11;

  const vphs = enrichedVideos.map((v) => Number(v.views_per_hour) || 0).sort((a, b) => a - b);
  const medianVph = vphs.length > 0
    ? (vphs.length % 2 ? vphs[(vphs.length - 1) / 2] : Math.round((vphs[vphs.length / 2 - 1] + vphs[vphs.length / 2]) / 2))
    : 0;

  const channelInput = {
    channel_id: channelId,
    channel_name: channel.name || cached.channel_name || 'Channel',
    niche: channel.genre || 'general',
    profile: profileKey,
    summary: {
      total_shorts: shortsCount,
      total_videos: enrichedVideos.length,
      total_views: totalViews,
      total_likes: totalLikes,
      total_comments: totalComments,
      subscribers,
      median_views_per_hour: medianVph,
      scanned_at: cached.scanned_at,
    },
    best: cached.best || {},
    recent_videos: enrichedVideos.slice(0, 10).map((v) => ({
      title: v.title,
      views: v.views,
      views_per_hour: v.views_per_hour,
      views_24h: v.views_24h ?? null,
      analytics_history: Array.isArray(v.analytics_history) ? v.analytics_history.map(({ age_days, views }) => ({ age_days, views })) : [],
      published_at: v.published_at || null,
      duration_s: v.duration_s,
      format: v.format,
      theme: v.theme,
      voice: v.voice,
      retention_percent: v.retention_percent ?? null,
      subscribers_gained: v.subscribers_gained ?? null,
    })),
  };

  // 4. Run askGrowth('analyze') and askGrowth('audit')
  // We execute both, ensuring that any failure does NOT write to disk
  const [analyzeResult, auditResult] = await Promise.all([
    askGrowthFn('analyze', channel, channelInput, { search: false }),
    askGrowthFn('audit', channel, channelInput, { search: false }),
  ]);

  if (!analyzeResult || !auditResult) {
    throw new Error('Growth model failed to produce complete diagnostic results');
  }

  // 5. Build final report
  const finalReport = {
    channel_id: channelId,
    channel_name: channel.name || cached.channel_name || 'Channel',
    profile: profileKey,
    profile_name: profileConfig.name,
    generated_at: new Date(now).toISOString(),
    baseline: {
      shorts_count: shortsCount,
      total_views: totalViews,
      subscribers,
      median_views_per_hour: medianVph,
    },
    scores: normalizeScores(auditResult, analyzeResult),
    top_actions: normalizeTopActions(analyzeResult, auditResult),
    next_subskill: normalizeNextSubskill(analyzeResult, auditResult),
    analysis: analyzeResult.analysis || analyzeResult,
    audit: auditResult.audit || auditResult,
    strategy: existingReport?.strategy || undefined,
    ideas: existingReport?.ideas || undefined,
    channel_data_summary: {
      scanned_at: cached.scanned_at,
      total_videos: enrichedVideos.length,
      published: cached.published || enrichedVideos.length,
      best: cached.best || {},
    },
  };

  // 6. Save to disk only after successful generation
  saveGrowthReport(channelId, finalReport, repoRoot);

  return finalReport;
}

// =============================================================================
// Cohort Report (KAN-287)
// =============================================================================

function extractProductionMinutes(meta) {
  if (!meta) return 'unavailable';
  if (typeof meta.run?.production_minutes === 'number') return meta.run.production_minutes;
  if (typeof meta.run_metadata?.production_minutes === 'number') return meta.run_metadata.production_minutes;
  if (typeof meta.production_minutes === 'number') return meta.production_minutes;
  if (typeof meta.timings_s?.total === 'number') {
    return Math.round((meta.timings_s.total / 60) * 100) / 100;
  }
  return 'unavailable';
}

function extractHistoricalAnalyticsAtAge(video, draftMeta, ageDays) {
  const sources = [
    draftMeta?.youtube?.analytics_by_age_days?.[ageDays],
    draftMeta?.analytics_by_age_days?.[ageDays],
    video?.analytics_by_age_days?.[ageDays],
    draftMeta?.youtube?.analytics?.snapshots?.[ageDays],
    draftMeta?.youtube?.analytics?.snapshots?.[`${ageDays}d`],
    video?.analytics?.snapshots?.[ageDays],
    video?.analytics?.snapshots?.[`${ageDays}d`],
    video?.snapshots?.[ageDays],
    video?.snapshots?.[`${ageDays}d`],
    video?.analytics?.history?.[ageDays],
  ];

  for (const src of sources) {
    if (src && typeof src === 'object') return src;
  }

  if (Array.isArray(video?.analytics_history)) {
    const match = video.analytics_history.find((s) => s.age_days === ageDays || s.days === ageDays);
    if (match) return match;
  }

  // Lifetime analytics (no age key) is not a day-N measurement: never read it as one.
  return null;
}

function addMetricAliases(obj) {
  return Object.defineProperties(obj, {
    'engaged views': { get() { return this.engaged_views; }, enumerable: true },
    'viewed-vs-swiped': { get() { return this.viewed_vs_swiped; }, enumerable: true },
    'average view percentage': { get() { return this.average_view_percentage; }, enumerable: true },
    'subscribers gained per 1,000 views': { get() { return this.subscribers_gained_per_1000_views; }, enumerable: true },
    'production minutes': { get() { return this.production_minutes; }, enumerable: true },
  });
}

function aggregateCohortGroup({ tag, items, ageDays }) {
  const tooYoung = items.filter((it) => it.isTooYoung);
  const unknownAge = items.filter((it) => it.isUnknownAge);
  const eligible = items.filter((it) => !it.isTooYoung && !it.isUnknownAge);
  const count = eligible.length;
  const tooYoungCount = tooYoung.length;
  const tooYoungVideos = tooYoung.map((it) => it.video_id || it.draft_id);

  if (count === 0) {
    const emptyObj = {
      tag,
      count: 0,
      video_count: 0,
      too_young_count: tooYoungCount,
      too_young_videos: tooYoungVideos,
      unknown_age_count: unknownAge.length,
      views: 'unavailable',
      engaged_views: 'unavailable',
      viewed_vs_swiped: 'unavailable',
      average_view_percentage: 'unavailable',
      subscribers_gained_per_1000_views: 'unavailable',
      subscribers_per_1k_views: 'unavailable',
      production_minutes: 'unavailable',
      production_minutes_count: 0,
      production_minutes_coverage: '0/0',
      totals: {
        views: 'unavailable',
        engaged_views: 'unavailable',
        subscribers_gained: 'unavailable',
        production_minutes: 'unavailable',
      },
      averages: {
        views: 'unavailable',
        engaged_views: 'unavailable',
        viewed_vs_swiped: 'unavailable',
        average_view_percentage: 'unavailable',
        subscribers_gained_per_1000_views: 'unavailable',
        production_minutes: 'unavailable',
      },
      videos: [],
    };
    return addMetricAliases(emptyObj);
  }

  // Views
  const validViews = eligible.map((it) => it.views).filter((v) => typeof v === 'number');
  const totalViews = validViews.length ? validViews.reduce((a, b) => a + b, 0) : null;
  const avgViews = validViews.length ? Math.round((totalViews / validViews.length) * 100) / 100 : 'unavailable';

  // Engaged views
  const validEngaged = eligible.map((it) => it.engaged_views).filter((v) => typeof v === 'number');
  const totalEngaged = validEngaged.length ? validEngaged.reduce((a, b) => a + b, 0) : null;
  const avgEngaged = validEngaged.length ? Math.round((totalEngaged / validEngaged.length) * 100) / 100 : 'unavailable';

  // Viewed vs swiped (only when YouTube Analytics API provides it, otherwise "unavailable", never estimated)
  const validVvsS = eligible.map((it) => it.viewed_vs_swiped).filter((v) => typeof v === 'number');
  const avgVvsS = validVvsS.length ? Math.round((validVvsS.reduce((a, b) => a + b, 0) / validVvsS.length) * 100) / 100 : 'unavailable';

  // Average view percentage
  const validAvp = eligible.map((it) => it.average_view_percentage).filter((v) => typeof v === 'number');
  const avgAvp = validAvp.length ? Math.round((validAvp.reduce((a, b) => a + b, 0) / validAvp.length) * 100) / 100 : 'unavailable';

  // Subscribers gained per 1,000 views: numerator and denominator both over videos with a measured subscriber count
  const subsPairs = eligible.filter((it) => typeof it.subscribers_gained === 'number' && typeof it.views === 'number');
  let subsPer1k = 'unavailable';
  let totalSubs = null;
  if (subsPairs.length) {
    totalSubs = subsPairs.reduce((a, it) => a + it.subscribers_gained, 0);
    const subsViews = subsPairs.reduce((a, it) => a + it.views, 0);
    if (subsViews > 0) subsPer1k = Math.round((totalSubs / subsViews) * 1000 * 100) / 100;
  }

  // Production minutes from run metadata; coverage says how many eligible videos actually had a measurement
  const validProdMin = eligible.map((it) => it.production_minutes).filter((v) => typeof v === 'number');
  const totalProdMin = validProdMin.length ? validProdMin.reduce((a, b) => a + b, 0) : null;
  const avgProdMin = validProdMin.length ? Math.round((totalProdMin / validProdMin.length) * 100) / 100 : 'unavailable';

  const statsObj = {
    tag,
    count,
    video_count: count,
    too_young_count: tooYoungCount,
    too_young_videos: tooYoungVideos,
    unknown_age_count: unknownAge.length,
    production_minutes_count: validProdMin.length,
    production_minutes_coverage: `${validProdMin.length}/${count}`,
    views: avgViews,
    engaged_views: avgEngaged,
    viewed_vs_swiped: avgVvsS,
    average_view_percentage: avgAvp,
    subscribers_gained_per_1000_views: subsPer1k,
    subscribers_per_1k_views: subsPer1k,
    production_minutes: avgProdMin,
    totals: {
      views: totalViews !== null ? totalViews : 'unavailable',
      engaged_views: totalEngaged !== null ? totalEngaged : 'unavailable',
      subscribers_gained: totalSubs !== null ? totalSubs : 'unavailable',
      production_minutes: totalProdMin !== null ? Math.round(totalProdMin * 100) / 100 : 'unavailable',
    },
    averages: {
      views: avgViews,
      engaged_views: avgEngaged,
      viewed_vs_swiped: avgVvsS,
      average_view_percentage: avgAvp,
      subscribers_gained_per_1000_views: subsPer1k,
      production_minutes: avgProdMin,
    },
    videos: eligible,
  };

  return addMetricAliases(statsObj);
}

/**
 * cohortReport(tag, ageDays, options)
 *
 * Compares videos in a tagged cohort against untagged baseline videos at the same upload age.
 * Does not make live YouTube API calls. Honest "unavailable" when historical age snapshots absent.
 */
export async function cohortReport(tag, ageDays = 7, {
  repoRoot = DEFAULT_REPO_ROOT,
  draftsDir = DEFAULT_DRAFTS_DIR,
  cachedChannelData = undefined,
  channelOrId = 'default',
  now = Date.now(),
} = {}) {
  let channel = null;
  if (channelOrId && typeof channelOrId === 'object') {
    channel = channelOrId;
  } else if (typeof channelOrId === 'string') {
    channel = getChannelById(channelOrId) || { id: channelOrId, name: channelOrId };
  } else {
    channel = { id: 'default', name: 'ForgeAI (Primary)' };
  }

  // Drafts without a channel_id belong to the default channel (same rule as routes/channel.js)
  const channelId = channel.id || 'default';

  // 1. Scan local drafts directory for metadata and run timings, keeping only this channel's drafts
  const draftMap = new Map();
  const allDrafts = [];
  if (fs.existsSync(draftsDir)) {
    try {
      for (const entry of fs.readdirSync(draftsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const metaPath = path.join(draftsDir, entry.name, 'metadata.json');
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            if ((meta.channel_id || 'default') !== channelId) continue;
            const dId = meta.draft_id || entry.name;
            const yId = meta.youtube?.video_id || meta.social?.platforms?.youtube_shorts?.video_id || meta.youtube_id || meta.video_id;
            const draftItem = { draft_id: dId, video_id: yId || null, meta };
            allDrafts.push(draftItem);
            if (dId) draftMap.set(dId, draftItem);
            if (yId) draftMap.set(yId, draftItem);
          } catch {}
        }
      }
    } catch {}
  }

  // 2. Load cached channel scan if available (the shared data/trends file belongs to the default channel only)
  let cached = cachedChannelData !== undefined
    ? cachedChannelData
    : (repoRoot === DEFAULT_REPO_ROOT ? readCachedChannel(channel) : null);

  if (!cached && repoRoot && channelId === 'default') {
    try {
      const customCache = path.join(repoRoot, 'data/trends/channel.json');
      if (fs.existsSync(customCache)) {
        cached = JSON.parse(fs.readFileSync(customCache, 'utf8'));
      }
    } catch {}
  }

  // 3. Assemble unified video items
  const unifiedItems = new Map();
  let unassociatedCount = 0;

  if (cached && Array.isArray(cached.videos) && cached.videos.length > 0) {
    for (const v of cached.videos) {
      const matchedDraft = draftMap.get(v.video_id) || draftMap.get(v.draft_id);
      // No local draft means no style tag can be read: such a video is neither cohort nor untagged baseline
      if (!matchedDraft) {
        unassociatedCount++;
        continue;
      }
      const key = v.video_id || v.draft_id || v.title;
      unifiedItems.set(key, {
        video: v,
        draft: matchedDraft.meta,
        draft_id: v.draft_id || matchedDraft.draft_id || null,
        video_id: v.video_id || matchedDraft.video_id || null,
      });
    }
  } else {
    for (const d of allDrafts) {
      const key = d.video_id || d.draft_id;
      if (!unifiedItems.has(key)) {
        unifiedItems.set(key, {
          video: null,
          draft: d.meta,
          draft_id: d.draft_id,
          video_id: d.video_id,
        });
      }
    }
  }

  // 4. Evaluate each item for cohort vs baseline and extract age metrics
  const cohortItems = [];
  const baselineItems = [];

  for (const item of unifiedItems.values()) {
    const meta = item.draft;
    const v = item.video;

    // Check style tag ONLY from draft metadata
    const style = meta?.style || meta?.style_tag;
    const styleTags = meta?.style_tags;
    const targetTagLower = tag ? String(tag).trim().toLowerCase() : null;

    let isCohort = false;
    if (targetTagLower) {
      if (style && String(style).trim().toLowerCase() === targetTagLower) {
        isCohort = true;
      } else if (Array.isArray(styleTags) && styleTags.some((s) => String(s).trim().toLowerCase() === targetTagLower)) {
        isCohort = true;
      }
    }

    const hasAnyStyleTag = Boolean(style || (Array.isArray(styleTags) && styleTags.length > 0));
    const isUntagged = !hasAnyStyleTag;

    // Must be either tagged cohort or untagged baseline
    if (!isCohort && !isUntagged) {
      continue;
    }

    // Age evaluation
    const pubDateStr = meta?.youtube?.published_at || v?.published_at || meta?.published_at || meta?.created_at || v?.created_at;
    // Without a usable upload date the video's age at ageDays is unknown: it is counted but never compared
    let isTooYoung = false;
    let isUnknownAge = true;
    let ageInDays = null;
    if (pubDateStr) {
      const pubTime = new Date(pubDateStr).getTime();
      if (!Number.isNaN(pubTime)) {
        isUnknownAge = false;
        ageInDays = (now - pubTime) / (24 * 60 * 60 * 1000);
        if (ageInDays < ageDays) {
          isTooYoung = true;
        }
      }
    }

    // Extract metrics at ageDays
    const analytics = !isTooYoung && !isUnknownAge ? extractHistoricalAnalyticsAtAge(v, meta, ageDays) : null;
    const prodMin = extractProductionMinutes(meta);

    // Parse metric values
    const views = analytics && typeof analytics.views === 'number'
      ? analytics.views
      : 'unavailable';

    const engagedViews = analytics && (typeof analytics.engaged_views === 'number' || typeof analytics.engagedViews === 'number')
      ? (typeof analytics.engaged_views === 'number' ? analytics.engaged_views : analytics.engagedViews)
      : 'unavailable';

    let viewedVsSwiped = 'unavailable';
    if (analytics) {
      if (typeof analytics.viewed_vs_swiped === 'number') viewedVsSwiped = analytics.viewed_vs_swiped;
      else if (typeof analytics.viewed_vs_swiped_percent === 'number') viewedVsSwiped = analytics.viewed_vs_swiped_percent;
      else if (typeof analytics['viewed-vs-swiped'] === 'number') viewedVsSwiped = analytics['viewed-vs-swiped'];
    }

    let avgViewPct = 'unavailable';
    if (analytics) {
      if (typeof analytics.average_view_percentage === 'number') avgViewPct = analytics.average_view_percentage;
      else if (typeof analytics.avg_view_percentage === 'number') avgViewPct = analytics.avg_view_percentage;
      else if (typeof analytics.retention_percent === 'number') avgViewPct = analytics.retention_percent;
    }

    const subsGained = analytics && typeof analytics.subscribers_gained === 'number'
      ? analytics.subscribers_gained
      : null;

    const analyzedItem = {
      draft_id: item.draft_id,
      video_id: item.video_id,
      title: v?.title || meta?.product?.title || item.draft_id,
      published_at: pubDateStr || null,
      age_in_days: ageInDays,
      isTooYoung,
      isUnknownAge,
      views,
      engaged_views: engagedViews,
      viewed_vs_swiped: viewedVsSwiped,
      average_view_percentage: avgViewPct,
      subscribers_gained: subsGained,
      production_minutes: prodMin,
    };

    if (isCohort) {
      cohortItems.push(analyzedItem);
    } else if (isUntagged) {
      baselineItems.push(analyzedItem);
    }
  }

  const cohortGroup = aggregateCohortGroup({ tag: tag || null, items: cohortItems, ageDays });
  const baselineGroup = aggregateCohortGroup({ tag: null, items: baselineItems, ageDays });

  return {
    tag: tag || null,
    age_days: ageDays,
    unassociated_count: unassociatedCount,
    cohort: cohortGroup,
    baseline: baselineGroup,
  };
}
