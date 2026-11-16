import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_VOICEOVER_RULES, BASE_VIDEO_RULES, researchChannelPsychologyRules, sanitizeVoiceoverPsychologyRules } from './psychologyResearch.js';
import { growthPromptRules } from '../growth/profiles.js';
export { sanitizeVoiceoverPsychologyRules };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = process.env.FORGEAI_ROOT || path.resolve(__dirname, '../../../');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const CHANNELS_FILE = process.env.CHANNELS_FILE || path.join(DATA_DIR, 'channels.json');
const ACTIVE_CHANNEL_FILE = process.env.ACTIVE_CHANNEL_FILE || path.join(DATA_DIR, 'active_channel.json');
const LEGACY_TOKEN_FILE = process.env.YOUTUBE_TOKEN_FILE || path.join(DATA_DIR, 'youtube_token.json');
const TOKENS_DIR = path.join(DATA_DIR, 'tokens');

// Shared by every route that turns a request id (draft id, channel id) into a file or folder name (KAN-427).
export const isSafeId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id);
// root/<id> resolved, or null when the id is not a plain name or the result would leave root.
export function safeChildDir(root, id) {
  if (!isSafeId(id)) return null;
  try {
    const base = path.resolve(root);
    const dir = path.resolve(base, id);
    const rel = path.relative(base, dir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const comparable = process.platform === 'win32' ? (value) => value.toLowerCase() : (value) => value;
    const realBase = fs.realpathSync(base);
    // Refuse links at every existing component from the configured root through the draft itself.
    let current = base;
    for (const component of rel.split(path.sep)) {
      current = path.join(current, component);
      let stat;
      try { stat = fs.lstatSync(current); }
      catch (err) { if (err.code === 'ENOENT') return dir; throw err; }
      if (stat.isSymbolicLink() || (process.platform === 'win32' && (stat.st_file_attributes & 0x400))) return null;
    }
    const realDir = fs.realpathSync(dir);
    const realRel = path.relative(realBase, realDir);
    if (!realRel || comparable(realRel).startsWith(comparable('..' + path.sep)) || comparable(realRel) === '..' || path.isAbsolute(realRel)) return null;
    return dir;
  } catch {
    return null;
  }
}

function safeReadJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function safeWriteJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { encoding: 'utf8' });
  } catch (err) {
    console.error(`Failed to write JSON to ${file}:`, err.message);
  }
}

/**
 * Initializes and loads all channels.
 * Automatically seeds the primary/default channel if no channels exist.
 */
export function getAllChannels() {
  const list = safeReadJson(CHANNELS_FILE, null);
  if (Array.isArray(list) && list.length > 0) {
    return list.map((channel) => {
      let videoTypes;
      try { videoTypes = cleanChannelVideoTypes(channel.video_types); } catch { videoTypes = []; }
      return { ...channel, video_types: videoTypes, auto_release: cleanAutoRelease(channel.auto_release) };
    });
  }

  // Seed initial default channel from existing legacy token if present
  const legacyToken = safeReadJson(LEGACY_TOKEN_FILE, null);
  const defaultChannel = {
    id: 'default',
    name: 'ForgeAI (Primary)',
    genre: 'general',
    style: '',
    description: 'Primary production channel for automated short-form content',
    youtube_channel_id: legacyToken?.channel_id || 'UCrYSf42sxY0hEa2pWSZ140w',
    api_key: '',
    client_id: '',
    client_secret: '',
    token: legacyToken || null,
    hero: null,
    growth_profile_prompts: false,
    growth_topic_picking: false,
    video_types: ['factual', 'whatif', 'history'],
    auto_release: { enabled: false, daily_cap: null },
    growth_ab_channel: 'default',
    voiceover_psychology_rules: BASE_VOICEOVER_RULES,
    video_psychology_rules: BASE_VIDEO_RULES,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const initialList = [defaultChannel];
  safeWriteJson(CHANNELS_FILE, initialList);
  if (!safeReadJson(ACTIVE_CHANNEL_FILE, null)) {
    safeWriteJson(ACTIVE_CHANNEL_FILE, { active_channel_id: 'default' });
  }
  return initialList;
}

export function getActiveChannelId() {
  const activeData = safeReadJson(ACTIVE_CHANNEL_FILE, null);
  if (activeData?.active_channel_id) {
    return activeData.active_channel_id;
  }
  const channels = getAllChannels();
  return channels[0]?.id || 'default';
}

export function setActiveChannelId(id) {
  const channels = getAllChannels();
  const exists = channels.some((c) => c.id === id);
  if (!exists) {
    throw new Error(`Channel with ID "${id}" does not exist.`);
  }
  safeWriteJson(ACTIVE_CHANNEL_FILE, { active_channel_id: id });
  return id;
}

export function getChannelById(id) {
  const channels = getAllChannels();
  const channel = channels.find((c) => c.id === id) || null;
  return addGrowthRules(channel);
}

function addGrowthRules(channel) {
  const rules = growthPromptRules(channel || {});
  if (!channel || !rules) return channel;
  return {
    ...channel,
    voiceover_psychology_rules: `${channel.voiceover_psychology_rules || BASE_VOICEOVER_RULES}\n\nGROWTH PROFILE RULES:\n${rules}`,
    video_psychology_rules: `${channel.video_psychology_rules || BASE_VIDEO_RULES}\n\nGROWTH PROFILE RULES:\n${rules}`,
  };
}

/**
 * Returns the currently active channel object based on:
 * 1. Explicit request header 'x-channel-id'
 * 2. Query parameter 'channel_id'
 * 3. Persisted active channel ID
 * 4. First available channel in the list
 */
export function getActiveChannel(req = null) {
  const channels = getAllChannels();
  const reqId = req?.headers?.['x-channel-id'] || req?.query?.channel_id;
  if (reqId) {
    const found = channels.find((c) => c.id === reqId);
    if (found) return addGrowthRules(found);
  }
  const activeId = getActiveChannelId();
  return addGrowthRules(channels.find((c) => c.id === activeId) || channels[0]);
}

/**
 * Resolves the YouTube API key from channel configuration:
 * 1. Checks target channel or active channel
 * 2. Falls back to any configured channel with an API key
 * Note: Does not read from process.env to keep keys channel-managed only.
 */
export function getChannelYouTubeApiKey(channelOrReq = null) {
  let targetChannel = null;
  if (channelOrReq && typeof channelOrReq === 'object' && (channelOrReq.api_key !== undefined || channelOrReq.youtube_api_key !== undefined)) {
    targetChannel = channelOrReq;
  } else {
    targetChannel = getActiveChannel(channelOrReq);
  }
  const directKey = targetChannel?.api_key || targetChannel?.youtube_api_key;
  if (directKey && typeof directKey === 'string' && directKey.trim()) {
    return directKey.trim();
  }

  const channels = getAllChannels();
  for (const ch of channels) {
    const key = ch?.api_key || ch?.youtube_api_key;
    if (key && typeof key === 'string' && key.trim()) {
      return key.trim();
    }
  }

  return '';
}

export const ENGINES = ['classic', 'cutaway3d', 'director', 'preschool_3d'];
export const cleanEngine = (e) => (ENGINES.includes(e) ? e : 'classic');
const cleanAudioMode = (value) => (value === 'narration' || value === 'music_sfx' ? value : null);
const cleanNullableBoolean = (value) => (typeof value === 'boolean' ? value : null);
const cleanKidsLength = (value) => (value === 30 || value === 60 ? value : null);
// MiniMax H3 licence bars use of its outputs in the US, EU, UK and South Korea (docs/model-licences.md): off unless opted in for internal evaluation.
export const MINIMAX_H3_DISABLED_MESSAGE = 'MiniMax H3 is disabled: its licence does not allow public uploads in the US, EU, UK or South Korea';
export const minimaxH3Enabled = () => process.env.FORGEAI_ALLOW_MINIMAX_H3 === '1';
// Wan 2.2 14B clip length in seconds (81/121/161 frames); every other backend has a fixed length.
export const WAN14B_CLIP_SECONDS = [5, 7.5, 10];
const cleanKidsClipSeconds = (value) => (WAN14B_CLIP_SECONDS.includes(value) ? value : null);
const cleanKidsVideoModel = (value) => (value === 'wan' || value === 'wan14b' || (value === 'minimax_h3' && minimaxH3Enabled()) ? value : null);
export const cleanHero = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

export function resolveChannelPolicy(channel = {}, engineOverride) {
  const engine = cleanEngine(engineOverride ?? channel?.engine);
  const preschool = engine === 'preschool_3d';
  if (channel?.kids_video_model === 'minimax_h3' && !minimaxH3Enabled()) {
    console.warn(`[policy] channel ${channel?.id ?? '(unsaved)'} stores kids_video_model=minimax_h3: using wan. ${MINIMAX_H3_DISABLED_MESSAGE} (licence). Set FORGEAI_ALLOW_MINIMAX_H3=1 for internal evaluation only.`);
  }
  return {
    engine,
    audio_mode: cleanAudioMode(channel?.audio_mode) ?? (preschool ? 'music_sfx' : 'narration'),
    captions: cleanNullableBoolean(channel?.captions) ?? !preschool,
    made_for_kids: cleanNullableBoolean(channel?.made_for_kids) ?? preschool,
    preschool_action_audio: cleanNullableBoolean(channel?.preschool_action_audio) ?? false,
    kids_length_s: cleanKidsLength(channel?.kids_length_s) ?? 30,
    kids_video_model: cleanKidsVideoModel(channel?.kids_video_model) ?? 'wan',
    kids_clip_seconds: (cleanKidsVideoModel(channel?.kids_video_model) ?? 'wan') === 'wan14b' ? (cleanKidsClipSeconds(channel?.kids_clip_seconds) ?? 5.0)
      : (cleanKidsVideoModel(channel?.kids_video_model) ?? 'wan') === 'minimax_h3' ? 5.0 : 3.5,
  };
}
export const cleanMaxPosts = (n) => Math.min(10, Math.max(1, Math.round(Number(n)) || 2));
export const CHANNEL_VIDEO_TYPES = Object.freeze(['factual', 'whatif', 'history', 'teardown']);
export function cleanChannelVideoTypes(types) {
  if (types === undefined) return [...CHANNEL_VIDEO_TYPES];
  if (!Array.isArray(types)) throw new TypeError('video_types must be an array');
  if (types.some((type) => !CHANNEL_VIDEO_TYPES.includes(type))) throw new TypeError('video_types contains an unsupported type');
  return [...new Set(types)];
}
export function cleanAutoRelease(value) {
  const config = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const cap = config.daily_cap;
  return {
    enabled: config.enabled === true,
    daily_cap: Number.isSafeInteger(cap) && cap > 0 ? cap : null,
  };
}
export const STYLES = ['', 'viral_v1'];
export const cleanStyle = (s) => (s === 'viral_v1' ? 'viral_v1' : '');
export const cleanGrowthProfilePrompts = (value) => value === true;
export const cleanGrowthTopicPicking = (value) => value === true;

/**
 * Growth A/B target channel cleaner (KAN-251).
 * Defaults to the fallback channel ID (usually the current channel).
 */
export const cleanGrowthABChannel = (value, fallbackChannelId = null) => {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return fallbackChannelId || null;
};

/**
 * Validates whether a target channel can be picked as the growth A/B experiment target.
 * Rule: The default target is the current channel itself. A different target must have its
 * key saved and be connected; otherwise returns what is missing and why it cannot be picked.
 */
export function validateGrowthABChannel(channelId, targetChannelId, channels = null) {
  const all = channels || getAllChannels();
  const targetId = cleanGrowthABChannel(targetChannelId, channelId);

  // Current channel itself is always valid (the default target)
  if (targetId === channelId) {
    return {
      valid: true,
      target_channel_id: targetId,
      reason: null,
      missing: [],
    };
  }

  const target = all.find((c) => c.id === targetId);
  if (!target) {
    return {
      valid: false,
      target_channel_id: targetId,
      reason: `Target channel "${targetId}" not found.`,
      missing: ['channel_not_found'],
    };
  }

  const token = target.token || getChannelToken(target.id);
  const hasKey = Boolean((target.api_key || target.youtube_api_key || '').trim());
  const connected = Boolean(token?.refresh_token);

  const missing = [];
  if (!hasKey) missing.push('api_key');
  if (!connected) missing.push('connection');

  if (missing.length === 0) {
    return {
      valid: true,
      target_channel_id: targetId,
      reason: null,
      missing: [],
    };
  }

  let reason = '';
  if (!hasKey && !connected) {
    reason = 'Target channel requires a saved YouTube Data API key and YouTube connection';
  } else if (!hasKey) {
    reason = 'Target channel requires a saved YouTube Data API key';
  } else {
    reason = 'Target channel requires a YouTube connection';
  }

  return {
    valid: false,
    target_channel_id: targetId,
    reason,
    missing,
  };
}

/**
 * Sanitizes channel object for public API responses.
 * Rule: The key field stays masked, is never logged and never appears in a report or API response (KAN-251).
 * Also shows which account a channel is bound to (channel name and id from token).
 */
// codex · gpt-6.1-sol · 2026-11-14: optional, bounded channel profile data.
/** A profile that says nothing (no niche) is no profile: the channel keeps today's behaviour. */
export const isActiveProfile = (profile) => !!profile && typeof profile === 'object' && !!profile.niche;
/** -> { profile } to spread into a channel, or {} when the body clears it (null, or a profile that says nothing). */
function profileField(value) {
  if (value === null) return {};
  const profile = validateChannelProfile(value);
  return isActiveProfile(profile) ? { profile } : {};
}
export function validateChannelProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new TypeError('Invalid profile');
  const phrase = (value, max) => {
    if (typeof value !== 'string' || value.trim().length > max || (value.trim() && !/^[\p{L}\p{M}\p{N} ,.'’:;?!%&/+()-]+$/u.test(value.trim()))) throw new TypeError(`Invalid profile text (letters, digits and , . ' : ; ? ! % & / + ( ) - only, at most ${max} characters)`);
    return value.trim();
  };
  const niche = phrase(profile.niche ?? '', 200);
  const language = profile.language || 'en';
  if (typeof language !== 'string' || language.length > 35 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language)) throw new TypeError('Invalid profile language');
  try { Intl.getCanonicalLocales(language); } catch { throw new TypeError('Invalid profile language'); }
  const avoid = profile.avoid ?? [];
  if (!Array.isArray(avoid) || avoid.length > 10) throw new TypeError('Invalid profile avoid list');
  return { niche, language, avoid: avoid.map(v => { const text = phrase(v, 80); if (!text) throw new TypeError('Empty avoid phrase'); return text; }) };
}

export function sanitizeChannel(channel) {
  if (!channel) return null;
  const token = channel.token || getChannelToken(channel.id);
  const hasKey = Boolean((channel.api_key || channel.youtube_api_key || '').trim());
  const connected = Boolean(token?.refresh_token);
  const boundAccount = {
    channel: token?.channel || null,
    channel_id: token?.channel_id || null,
  };

  const copy = { ...channel };
  delete copy.api_key;
  delete copy.youtube_api_key;
  delete copy.client_secret;
  copy.token = token ? {
    channel: token.channel || null,
    channel_id: token.channel_id || null,
    scope: token.scope || null,
  } : null;

  return {
    ...copy,
    video_types: Array.isArray(copy.video_types) ? (() => { try { return cleanChannelVideoTypes(copy.video_types); } catch { return []; } })() : [...CHANNEL_VIDEO_TYPES],
    auto_release: cleanAutoRelease(copy.auto_release),
    has_api_key: hasKey,
    connected,
    bound_account: boundAccount,
    growth_ab_channel: copy.growth_ab_channel || copy.id || 'default',
  };
}

/**
 * Creates a new channel. Automatically researches psychology rules if not supplied.
 */
export async function createChannel(data = {}, ask = undefined) {
  const name = String(data.name || '').trim();
  const genre = String(data.genre || 'general').trim();

  if (!name) throw new Error('Channel name is required.');
  if (!genre) throw new Error('Channel genre is required.');
  if (data.style !== undefined && data.style !== null && data.style !== '' && data.style !== 'viral_v1') {
    throw new Error('Invalid style: must be "" or "viral_v1".');
  }

  const channels = getAllChannels();
  const cleanId = `ch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  let voRules = data.voiceover_psychology_rules;
  let vidRules = data.video_psychology_rules;

  // If rules are not provided, dynamically research them for this genre!
  if (!voRules || !vidRules) {
    const researched = await researchChannelPsychologyRules({ genre, name, description: data.description }, ask);
    voRules = voRules || researched.voiceover_rules;
    vidRules = vidRules || researched.video_rules;
  }

  const growthABChannel = cleanGrowthABChannel(data.growth_ab_channel, cleanId);
  if (growthABChannel && growthABChannel !== cleanId) {
    const check = validateGrowthABChannel(cleanId, growthABChannel, channels);
    if (!check.valid) {
      throw new Error(check.reason);
    }
  }

  const newChannel = {
    ...(data.profile !== undefined ? profileField(data.profile) : {}),
    id: cleanId,
    name,
    genre,
    engine: cleanEngine(data.engine),
    audio_mode: cleanAudioMode(data.audio_mode),
    captions: cleanNullableBoolean(data.captions),
    made_for_kids: cleanNullableBoolean(data.made_for_kids),
    growth_profile_prompts: cleanGrowthProfilePrompts(data.growth_profile_prompts),
    growth_topic_picking: cleanGrowthTopicPicking(data.growth_topic_picking),
    growth_ab_channel: growthABChannel,
    preschool_action_audio: cleanNullableBoolean(data.preschool_action_audio),
    model_reference: data.model_reference === true,
    kids_length_s: cleanKidsLength(data.kids_length_s),
    kids_video_model: cleanKidsVideoModel(data.kids_video_model),
    kids_clip_seconds: cleanKidsClipSeconds(data.kids_clip_seconds),
    hero: cleanHero(data.hero),
    style: cleanStyle(data.style),
    video_types: cleanChannelVideoTypes(data.video_types),
    auto_release: cleanAutoRelease(data.auto_release),
    max_daily_posts: cleanMaxPosts(data.max_daily_posts),
    description: String(data.description || '').trim(),
    youtube_channel_id: String(data.youtube_channel_id || '').trim(),
    api_key: String(data.api_key || '').trim(),
    client_id: String(data.client_id || '').trim(),
    client_secret: String(data.client_secret || '').trim(),
    token: data.token || null,
    voiceover_psychology_rules: voRules,
    video_psychology_rules: vidRules,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  channels.push(newChannel);
  safeWriteJson(CHANNELS_FILE, channels);
  return newChannel;
}

/**
 * Updates channel configuration. Can optionally trigger re-researching psychology rules.
 */
export async function updateChannel(id, updates = {}, ask = undefined) {
  const channels = getAllChannels();
  const idx = channels.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`Channel "${id}" not found.`);

  if (updates.style !== undefined && updates.style !== null && updates.style !== '' && updates.style !== 'viral_v1') {
    throw new Error('Invalid style: must be "" or "viral_v1".');
  }

  const existing = channels[idx];
  const genre = updates.genre !== undefined ? String(updates.genre).trim() : existing.genre;
  const name = updates.name !== undefined ? String(updates.name).trim() : existing.name;

  let voRules = updates.voiceover_psychology_rules !== undefined ? updates.voiceover_psychology_rules : existing.voiceover_psychology_rules;
  let vidRules = updates.video_psychology_rules !== undefined ? updates.video_psychology_rules : existing.video_psychology_rules;

  if (updates.researchRules) {
    const researched = await researchChannelPsychologyRules({ genre, name, description: updates.description || existing.description }, ask);
    voRules = researched.voiceover_rules;
    vidRules = researched.video_rules;
  }

  let apiKey = existing.api_key;
  if (Object.hasOwn(updates, 'api_key')) {
    const rawKey = String(updates.api_key || '').trim();
    if (rawKey && !rawKey.startsWith('•••')) {
      apiKey = rawKey;
    } else if (rawKey === '' && updates.clear_api_key) {
      apiKey = '';
    }
  }

  const clientSecret = Object.hasOwn(updates, 'client_secret')
    ? (String(updates.client_secret || '').trim() || existing.client_secret || '')
    : existing.client_secret;

  let growthABChannel = existing.growth_ab_channel || existing.id || id;
  if (Object.hasOwn(updates, 'growth_ab_channel')) {
    const targetCandidate = cleanGrowthABChannel(updates.growth_ab_channel, id);
    if (targetCandidate && targetCandidate !== id) {
      const check = validateGrowthABChannel(id, targetCandidate, channels);
      if (!check.valid) {
        throw new Error(check.reason);
      }
    }
    growthABChannel = targetCandidate;
  }

  const updatedChannel = {
    ...existing,
    ...updates,
    ...(Object.hasOwn(updates, 'profile') ? { profile: undefined, ...profileField(updates.profile) } : {}),
    id: existing.id, // the id is a file name elsewhere: the body never changes it
    name: name || existing.name,
    genre: genre || existing.genre,
    engine: cleanEngine(updates.engine ?? existing.engine),
    audio_mode: Object.hasOwn(updates, 'audio_mode') ? cleanAudioMode(updates.audio_mode) : existing.audio_mode,
    captions: Object.hasOwn(updates, 'captions') ? cleanNullableBoolean(updates.captions) : existing.captions,
    made_for_kids: Object.hasOwn(updates, 'made_for_kids') ? cleanNullableBoolean(updates.made_for_kids) : existing.made_for_kids,
    growth_profile_prompts: Object.hasOwn(updates, 'growth_profile_prompts') ? cleanGrowthProfilePrompts(updates.growth_profile_prompts) : cleanGrowthProfilePrompts(existing.growth_profile_prompts),
    growth_topic_picking: Object.hasOwn(updates, 'growth_topic_picking') ? cleanGrowthTopicPicking(updates.growth_topic_picking) : cleanGrowthTopicPicking(existing.growth_topic_picking),
    growth_ab_channel: growthABChannel,
    preschool_action_audio: Object.hasOwn(updates, 'preschool_action_audio') ? cleanNullableBoolean(updates.preschool_action_audio) : existing.preschool_action_audio,
    model_reference: Object.hasOwn(updates, 'model_reference') ? updates.model_reference === true : existing.model_reference === true,
    kids_length_s: Object.hasOwn(updates, 'kids_length_s') ? cleanKidsLength(updates.kids_length_s) : existing.kids_length_s,
    kids_video_model: Object.hasOwn(updates, 'kids_video_model') ? cleanKidsVideoModel(updates.kids_video_model) : existing.kids_video_model,
    kids_clip_seconds: Object.hasOwn(updates, 'kids_clip_seconds') ? cleanKidsClipSeconds(updates.kids_clip_seconds) : existing.kids_clip_seconds ?? null,
    hero: Object.hasOwn(updates, 'hero') ? cleanHero(updates.hero) : (existing.hero ?? null),
    style: cleanStyle(updates.style !== undefined ? updates.style : existing.style),
    video_types: cleanChannelVideoTypes(Object.hasOwn(updates, 'video_types') ? updates.video_types : existing.video_types),
    auto_release: cleanAutoRelease(Object.hasOwn(updates, 'auto_release') ? updates.auto_release : existing.auto_release),
    max_daily_posts: cleanMaxPosts(updates.max_daily_posts ?? existing.max_daily_posts),
    api_key: apiKey,
    client_secret: clientSecret,
    voiceover_psychology_rules: voRules,
    video_psychology_rules: vidRules,
    updated_at: new Date().toISOString(),
  };

  // Remove researchRules flag from saved object
  delete updatedChannel.researchRules;
  delete updatedChannel.clear_api_key;

  channels[idx] = updatedChannel;
  safeWriteJson(CHANNELS_FILE, channels);
  return updatedChannel;
}

export function deleteChannel(id) {
  const channels = getAllChannels();
  if (channels.length <= 1) {
    throw new Error('Cannot delete the only remaining channel.');
  }

  const filtered = channels.filter((c) => c.id !== id);
  if (filtered.length === channels.length) {
    throw new Error(`Channel "${id}" not found.`);
  }

  safeWriteJson(CHANNELS_FILE, filtered);

  // If the deleted channel was active, switch to the first remaining one
  const activeId = getActiveChannelId();
  if (activeId === id) {
    safeWriteJson(ACTIVE_CHANNEL_FILE, { active_channel_id: filtered[0].id });
  }

  return { success: true, active_channel_id: getActiveChannelId() };
}

/**
 * Saves channel OAuth token securely per channel and also keeps legacy file synced if active
 */
export function saveChannelToken(channelId, tokenData) {
  if (!isSafeId(channelId)) throw new Error('Invalid channel id');
  const channels = getAllChannels();
  const ch = channels.find((c) => c.id === channelId);
  if (ch) {
    ch.token = tokenData;
    ch.updated_at = new Date().toISOString();
    safeWriteJson(CHANNELS_FILE, channels);
  }

  // Also write to channel-specific token file in tokens dir
  safeWriteJson(path.join(TOKENS_DIR, `${channelId}.json`), tokenData);

  // If this is currently active channel, sync to legacy token file for backward compatibility
  if (getActiveChannelId() === channelId) {
    safeWriteJson(LEGACY_TOKEN_FILE, tokenData);
  }
}

export function getChannelToken(channelId) {
  const ch = getChannelById(channelId);
  if (ch?.token) return ch.token;
  if (!isSafeId(channelId)) return null;
  return safeReadJson(path.join(TOKENS_DIR, `${channelId}.json`), null);
}
