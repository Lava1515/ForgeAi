import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askGrowth } from './askGrowth.js';
import { resolveGrowthProfile } from './profiles.js';
import { getChannelById } from '../routes/channelsManager.js';
import { growthFile } from './storage.js';
export { growthFile as getGrowthFilePath } from './storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = process.env.FORGEAI_ROOT || path.resolve(__dirname, '../../../');

/**
 * Loads the stored strategy from data/growth/<channel_id>.json
 */
export function loadChannelStrategy(channelId = 'default', repoRoot = DEFAULT_REPO_ROOT) {
  const filePath = growthFile(channelId, repoRoot);
  try {
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return data?.strategy || null;
  } catch (err) {
    console.warn(`Failed to read growth strategy for ${channelId}:`, err.message);
    return null;
  }
}

/**
 * Saves strategy into data/growth/<channel_id>.json while strictly preserving
 * any existing report, baseline, scores, or ideas.
 */
export function saveChannelStrategy(channelId = 'default', strategyData = {}, repoRoot = DEFAULT_REPO_ROOT) {
  const filePath = growthFile(channelId, repoRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let existing = {};
  if (fs.existsSync(filePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf8')) || {};
    } catch {}
  }

  const prevStrategy = existing.strategy || {};
  const contentPillar = strategyData.content_pillar || prevStrategy.content_pillar || '';
  const uploadCadence = strategyData.upload_cadence || prevStrategy.upload_cadence || '1 short per day';

  const mergedStrategy = {
    ...prevStrategy,
    ...strategyData,
    content_pillar: contentPillar,
    upload_cadence: uploadCadence,
    updated_at: new Date().toISOString(),
  };

  const payload = {
    ...existing,
    channel_id: existing.channel_id || channelId,
    strategy: mergedStrategy,
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return mergedStrategy;
}

/**
 * Updates channel strategy with owner edits (content pillar, cadence, positioning).
 */
export function updateChannelStrategy(channelId = 'default', updates = {}, repoRoot = DEFAULT_REPO_ROOT) {
  return saveChannelStrategy(channelId, updates, repoRoot);
}

/**
 * Runs askGrowth('strategy') to generate a content pillar and upload cadence.
 * Stores result in data/growth/<channel_id>.json.
 */
export async function generateChannelStrategy(channelOrId, {
  repoRoot = DEFAULT_REPO_ROOT,
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

  // Check if existing strategy is present and fresh
  const existing = loadChannelStrategy(channelId, repoRoot);
  if (existing && existing.content_pillar && !force) {
    return existing;
  }

  const isKids = profileKey === 'kids' || Boolean(channel.made_for_kids);
  const channelInput = {
    channel_id: channelId,
    channel_name: channel.name || 'Channel',
    niche: channel.genre || 'general',
    profile: profileKey,
    subscribers: Number(channel.subscribers || channel.subscriber_count) || 11,
    made_for_kids: isKids,
    goal: isKids
      ? 'Calm, educational shorts for parents and toddlers with predictable series structure'
      : (channel.goal || 'Audience growth through a focused, repeatable content pillar'),
    notes: isKids
      ? 'Target audience is parents and caregivers of toddlers (ages 2-5). Comments are disabled on all videos.'
      : undefined,
  };

  const rawResult = await askGrowthFn('strategy', channel, channelInput, { search: false });
  if (!rawResult || typeof rawResult !== 'object') {
    throw new Error('Growth strategy model returned empty or invalid response');
  }

  const stratObj = rawResult.strategy || rawResult;

  let pillar = '';
  if (typeof stratObj.content_pillar === 'string' && stratObj.content_pillar.trim()) {
    pillar = stratObj.content_pillar.trim();
  } else if (Array.isArray(stratObj.content_pillars) && stratObj.content_pillars.length > 0) {
    const first = stratObj.content_pillars[0];
    pillar = typeof first === 'string' ? first : (first.name || first.title || '');
  }
  if (!pillar) {
    pillar = `${channel.genre ? channel.genre.charAt(0).toUpperCase() + channel.genre.slice(1) : 'Core'} Content Pillar`;
  }

  let cadence = '';
  if (typeof stratObj.upload_cadence === 'string' && stratObj.upload_cadence.trim()) {
    cadence = stratObj.upload_cadence.trim();
  } else {
    cadence = '1 short per day';
  }

  let pillarsList = [];
  if (Array.isArray(stratObj.content_pillars)) {
    pillarsList = stratObj.content_pillars.map((p) => {
      if (typeof p === 'string') return { name: p, description: '' };
      return {
        name: p.name || p.title || '',
        description: p.description || p.purpose || '',
      };
    });
  } else {
    pillarsList = [{ name: pillar, description: stratObj.positioning || '' }];
  }

  const normalized = {
    content_pillar: pillar,
    content_pillars: pillarsList,
    upload_cadence: cadence,
    cadence_details: stratObj.cadence_details || stratObj.reasoning || '',
    positioning: stratObj.positioning || stratObj.positioning_statement || '',
    generated_at: new Date(now).toISOString(),
    raw: stratObj,
  };

  saveChannelStrategy(channelId, normalized, repoRoot);
  return normalized;
}
