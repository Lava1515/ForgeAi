import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askGrowth } from './askGrowth.js';
import { resolveGrowthProfile } from './profiles.js';
import { getChannelById, cleanEngine } from '../routes/channelsManager.js';
import { loadChannelStrategy } from './strategy.js';
import { loadGrowthReport } from './report.js';
import { readThemes } from '../routes/trends.js';
import { coveredStories, storyKey } from '../routes/storyDiscovery.js';
import { growthFile } from './storage.js';
export { growthFile as getGrowthFilePath } from './storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = process.env.FORGEAI_ROOT || path.resolve(__dirname, '../../../');
const MAX_FOLLOWUPS_PER_WINNER = 3;

function reportExamples(report, keys) {
  const sources = [report, report?.analysis, report?.audit, report?.analysis?.content_performance];
  for (const source of sources) {
    for (const key of keys) {
      if (Array.isArray(source?.[key])) return source[key];
    }
  }
  return [];
}

function normalizeReportExample(item) {
  if (typeof item === 'string') return { title: item };
  if (!item || typeof item !== 'object') return null;
  const title = item.title || item.video || item.name || item.topic || '';
  return {
    ...(title ? { title } : {}),
    ...(item.theme ? { theme: item.theme } : {}),
    ...(item.hook_form || item.hook_pattern || item.hook ? { hook_form: item.hook_form || item.hook_pattern || item.hook } : {}),
    ...(item.why_it_worked || item.reason || item.interpretation ? { why_it_worked: item.why_it_worked || item.reason || item.interpretation } : {}),
  };
}

function growthFeedback(report, contentPillar) {
  const winners = reportExamples(report, ['winners', 'top_performers', 'best_videos'])
    .map(normalizeReportExample).filter((item) => item?.title).slice(0, 5);
  const losers = reportExamples(report, ['losers', 'underperformers', 'worst_videos'])
    .map(normalizeReportExample).filter((item) => item?.title).slice(0, 5);
  if (!winners.length && !losers.length) return null;
  return {
    content_pillar: contentPillar,
    winners,
    losers,
    max_followups_per_winner: MAX_FOLLOWUPS_PER_WINNER,
    instructions: 'Keep every follow-up inside the content pillar. Reuse winning hook forms, avoid losing hook forms, and include follow_up_of (the exact winner title) plus hook_form on each follow-up idea.',
  };
}

function isLoserHookForm(idea, loserForms) {
  const form = String(idea?.hook_form || idea?.hook_pattern || '').trim().toLowerCase();
  return Boolean(form && loserForms.some((loser) => form === loser || form.includes(loser) || loser.includes(form)));
}

function withinWinnerCap(idea, counts) {
  const winner = idea?.follow_up_of || idea?.winner_id || idea?.winner_title;
  if (!winner) return true;
  const key = String(winner).toLowerCase();
  const count = counts.get(key) || 0;
  if (count >= MAX_FOLLOWUPS_PER_WINNER) return false;
  counts.set(key, count + 1);
  return true;
}

/**
 * Loads stored ideas from data/growth/<channel_id>.json
 */
export function loadChannelIdeas(channelId = 'default', repoRoot = DEFAULT_REPO_ROOT) {
  const filePath = growthFile(channelId, repoRoot);
  try {
    if (!fs.existsSync(filePath)) return [];
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data?.ideas) ? data.ideas : [];
  } catch (err) {
    console.warn(`Failed to read growth ideas for ${channelId}:`, err.message);
    return [];
  }
}

/**
 * Saves ideas into data/growth/<channel_id>.json while preserving report & strategy.
 */
export function saveChannelIdeas(channelId = 'default', ideas = [], repoRoot = DEFAULT_REPO_ROOT) {
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
    channel_id: existing.channel_id || channelId,
    ideas: Array.isArray(ideas) ? ideas : [],
    ideas_updated_at: new Date().toISOString(),
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return payload.ideas;
}

/**
 * Ranks candidate ideas strictly prioritizing ideas inside the content pillar.
 * Off-pillar ideas rank strictly below on-pillar ones.
 */
export function rankIdeasInsidePillar(ideas = [], contentPillar = '') {
  if (!Array.isArray(ideas)) return [];

  const pillarText = String(contentPillar || '').toLowerCase().trim();
  const pillarKeywords = pillarText
    .split(/[\s,_\-:/]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !['and', 'the', 'for', 'with', 'hub', 'all'].includes(w));

  const scored = ideas.map((idea) => {
    const topic = typeof idea === 'string' ? idea : (idea.topic || idea.name || idea.title || '');
    const reason = typeof idea === 'object' ? (idea.reason || '') : '';
    const topicLower = topic.toLowerCase();

    let isOnPillar = false;
    if (typeof idea === 'object' && typeof idea.on_pillar === 'boolean') {
      isOnPillar = idea.on_pillar;
    } else if (pillarKeywords.length > 0) {
      isOnPillar = pillarKeywords.some((kw) => topicLower.includes(kw));
    }

    const baseScore = Number(idea.baseScore ?? idea.score) || 50;
    // On-pillar ideas receive a dominant score bracket (100-199); off-pillar capped below (0-49)
    const finalScore = isOnPillar ? 100 + Math.min(baseScore, 99) : Math.min(baseScore, 49);

    const descriptiveReason = reason && /pillar/i.test(reason)
      ? reason
      : (isOnPillar
        ? (reason ? `On-pillar: ${reason}` : `On-pillar: Aligns directly with channel content pillar "${contentPillar}"`)
        : (reason ? `Off-pillar: ${reason}` : `Off-pillar: Outside channel content pillar "${contentPillar}"`));

    return {
      ...(typeof idea === 'object' ? idea : {}),
      topic,
      theme: idea.theme || topic,
      on_pillar: isOnPillar,
      score: finalScore,
      reason: descriptiveReason,
    };
  });

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  return scored.map((item, idx) => ({
    ...item,
    rank: idx + 1,
  }));
}

/**
 * Generates ranked growth ideas using askGrowth('ideate') and askGrowth('competitor').
 * Both run with search: true (agy search_web).
 * Combined with trends and covered stories.
 * For kids profile: ideas for parents of toddlers, no comment mining (comments off).
 */
export async function generateGrowthIdeas(channelOrId, {
  repoRoot = DEFAULT_REPO_ROOT,
  askGrowthFn = askGrowth,
  search = true,
  force = false,
  trendsFn = readThemes,
  coveredFn = coveredStories,
  growthReportFn = loadGrowthReport,
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
  const isKids = profileKey === 'kids' || Boolean(channel.made_for_kids) || cleanEngine(channel.engine) === 'preschool_3d';

  // Load content pillar from strategy
  const strategy = loadChannelStrategy(channelId, repoRoot);
  const contentPillar = strategy?.content_pillar || (channel.genre ? `${channel.genre} Topics` : 'Core Pillar');

  // Competitor input
  const competitorInput = isKids
    ? {
        channel_id: channelId,
        niche: channel.genre || 'preschool learning',
        profile: 'kids',
        made_for_kids: true,
        comments_disabled: true,
        no_comment_mining: true,
        audience: 'parents and caregivers of toddlers (ages 2-5)',
        instructions: 'Comments are disabled on made-for-kids content. Do not mine or request comments. Analyze format gaps, keyword gaps, and parent search queries.',
      }
    : {
        channel_id: channelId,
        channel_name: channel.name || 'Channel',
        niche: channel.genre || 'general',
        profile: profileKey,
        content_pillar: contentPillar,
      };

  // Ideate input
  const ideateInput = isKids
    ? {
        channel_id: channelId,
        niche: channel.genre || 'preschool learning',
        profile: 'kids',
        made_for_kids: true,
        comments_disabled: true,
        content_pillar: contentPillar,
        audience: 'parents and caregivers of toddlers (ages 2-5)',
        instructions: 'Generate gentle, calming preschool concepts for parents of toddlers (colors, counting, shapes, daily routines). No horror, no brands.',
      }
    : {
        channel_id: channelId,
        channel_name: channel.name || 'Channel',
        niche: channel.genre || 'general',
        profile: profileKey,
        content_pillar: contentPillar,
      };

  const feedback = channel.growth_topic_picking === true
    ? growthFeedback(growthReportFn(channelId, repoRoot), contentPillar)
    : null;
  if (feedback) ideateInput.growth_feedback = feedback;

  // Run ideate and competitor in parallel with search: true
  const [ideateResult, competitorResult] = await Promise.all([
    askGrowthFn('ideate', channel, ideateInput, { search: true }),
    askGrowthFn('competitor', channel, competitorInput, { search: true }),
  ]);

  const rawCandidates = [];

  // 1. Ideate results
  const ideateIdeas = Array.isArray(ideateResult?.ideas)
    ? ideateResult.ideas
    : Array.isArray(ideateResult?.topics)
      ? ideateResult.topics
      : [];
  const loserForms = (feedback?.losers || [])
    .map((item) => item.hook_form)
    .filter(Boolean)
    .map((form) => String(form).toLowerCase().trim());
  for (const item of ideateIdeas) {
    if (feedback && isLoserHookForm(item, loserForms)) continue;
    rawCandidates.push({
      topic: typeof item === 'string' ? item : (item.topic || item.name || item.title || ''),
      theme: item.theme || item.topic,
      on_pillar: item.on_pillar,
      baseScore: item.score || 75,
      reason: item.reason || 'High search potential from ideate analysis',
      source: 'growth_ideate',
      ...(item.follow_up_of || item.winner_id || item.winner_title ? { follow_up_of: item.follow_up_of || item.winner_id || item.winner_title } : {}),
      ...(item.hook_form || item.hook_pattern ? { hook_form: item.hook_form || item.hook_pattern } : {}),
    });
  }

  // 2. Competitor gap results
  const competitorGaps = Array.isArray(competitorResult?.competitor_insights?.gaps)
    ? competitorResult.competitor_insights.gaps
    : Array.isArray(competitorResult?.gaps)
      ? competitorResult.gaps
      : Array.isArray(competitorResult?.opportunities)
        ? competitorResult.opportunities
        : [];
  for (const gap of competitorGaps) {
    rawCandidates.push({
      topic: typeof gap === 'string' ? gap : (gap.topic || gap.name || gap.title || gap.gap || ''),
      theme: gap.theme || gap.topic,
      on_pillar: gap.on_pillar,
      baseScore: gap.score || 70,
      reason: gap.reason || 'Competitor gap opportunity',
      source: 'competitor_gap',
    });
  }

  // 3. Trends integration
  try {
    const trendsData = typeof trendsFn === 'function' ? trendsFn() : null;
    const themesList = Array.isArray(trendsData?.themes) ? trendsData.themes : [];
    for (const t of themesList.slice(0, 5)) {
      if (!rawCandidates.some((c) => c.topic.toLowerCase() === t.name.toLowerCase())) {
        rawCandidates.push({
          topic: t.name,
          theme: t.name,
          baseScore: Math.round((t.score || 0.5) * 60),
          reason: `Trending theme velocity (score: ${t.score || 0.5})`,
          source: 'trends_feed',
        });
      }
    }
  } catch {}

  // 4. Filter out covered stories
  const coveredSet = new Set();
  try {
    const covered = typeof coveredFn === 'function' ? coveredFn() : [];
    for (const s of covered) {
      coveredSet.add(storyKey(s));
    }
  } catch {}

  const winnerCounts = new Map();
  const freshCandidates = rawCandidates.filter((c) => {
    if (!c.topic) return false;
    const key = storyKey({ name: c.topic });
    if (coveredSet.has(key)) return false;
    return !feedback || c.source !== 'growth_ideate' || withinWinnerCap(c, winnerCounts);
  });

  const rankedIdeas = rankIdeasInsidePillar(freshCandidates, contentPillar);
  saveChannelIdeas(channelId, rankedIdeas, repoRoot);

  return rankedIdeas;
}

/**
 * Computes topic weights for Studio auto-batch based on channel growth strategy & ideas.
 * With growth_topic_picking OFF: returns empty weights and reasons (no-op).
 * With growth_topic_picking ON: weights themes toward on-pillar ideas, downweights off-pillar themes,
 * and logs the exact reason.
 */
export function computeGrowthTopicWeights(channel = {}, themes = [], {
  ideas: ideasOverride = null,
  strategy: strategyOverride = null,
  repoRoot = DEFAULT_REPO_ROOT,
} = {}) {
  if (channel?.growth_topic_picking !== true) {
    return { weights: {}, reasons: [], active: false };
  }

  const channelId = channel.id || 'default';
  const strategy = strategyOverride || loadChannelStrategy(channelId, repoRoot);
  const contentPillar = strategy?.content_pillar || (channel.genre ? `${channel.genre} Topics` : 'Core Content Pillar');

  const ideas = ideasOverride || loadChannelIdeas(channelId, repoRoot);

  const pillarText = contentPillar.toLowerCase();
  const pillarKeywords = pillarText
    .split(/[\s,_\-:/]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !['and', 'the', 'for', 'with', 'hub', 'all'].includes(w));

  const weights = {};
  const reasons = [];

  for (const theme of themes) {
    const themeName = typeof theme === 'string' ? theme : (theme.name || '');
    if (!themeName) continue;

    const themeLower = themeName.toLowerCase();

    // Check against ideas list first
    const matchedIdea = Array.isArray(ideas)
      ? ideas.find((i) => {
          const iTopic = String(i.topic || i.theme || i.name || '').toLowerCase();
          return iTopic.includes(themeLower) || themeLower.includes(iTopic);
        })
      : null;

    let isOnPillar = false;
    let reasonText = '';

    if (matchedIdea) {
      isOnPillar = matchedIdea.on_pillar === true;
      reasonText = matchedIdea.reason;
    } else {
      isOnPillar = pillarKeywords.some((kw) => themeLower.includes(kw));
    }

    if (isOnPillar) {
      weights[themeName] = 0.5; // Positive boost toward pillar ideas
      const r = reasonText || `On-pillar: Directly aligns with channel content pillar "${contentPillar}"`;
      reasons.push({
        theme: themeName,
        topic: matchedIdea?.topic || themeName,
        weight: 0.5,
        on_pillar: true,
        reason: r,
      });
    } else {
      weights[themeName] = -0.3; // Negative penalty for off-pillar themes
      const r = reasonText || `Off-pillar: Outside channel content pillar "${contentPillar}"`;
      reasons.push({
        theme: themeName,
        topic: matchedIdea?.topic || themeName,
        weight: -0.3,
        on_pillar: false,
        reason: r,
      });
    }
  }

  return {
    weights,
    reasons,
    active: true,
    pillar: contentPillar,
  };
}

export function loadGrowthTopicWeights(channel = {}, themes = [], options = {}) {
  return computeGrowthTopicWeights(channel, themes, options);
}
