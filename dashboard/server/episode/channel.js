import { getChannelById, resolveChannelPolicy } from '../routes/channelsManager.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const EPISODE_PATHS = new Set(['breakdown', 'whatif', 'story']);
const RESTRICTED_STORY_SUBPATHS = new Set(['scary', 'true_story']);

const MESSAGES = Object.freeze({
  unknown_channel: 'Unknown channel',
  invalid_path: 'Invalid Episode path',
  kids_channel_forbidden: 'This Episode path cannot use a made-for-kids channel',
});

export class EpisodeChannelError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.unknown_channel);
    this.name = 'EpisodeChannelError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'unknown_channel';
  }
}

// Resolve the channel policy that downstream draft and publish gates must display/use.
// Scary/true-story Episodes and what-if body Episodes cannot target a made-for-kids channel.
export function selectEpisodeChannel({ channelId, path, subPath, getChannel = getChannelById } = {}) {
  if (typeof path !== 'string' || !EPISODE_PATHS.has(path)) throw new EpisodeChannelError('invalid_path');
  if (subPath !== undefined && (typeof subPath !== 'string' || !subPath.trim())) throw new EpisodeChannelError('invalid_path');
  if (typeof channelId !== 'string' || !SAFE_ID.test(channelId) || typeof getChannel !== 'function') {
    throw new EpisodeChannelError('unknown_channel');
  }

  let channel;
  try { channel = getChannel(channelId); } catch { channel = null; }
  if (!channel || typeof channel !== 'object' || Array.isArray(channel) || channel.id !== channelId) {
    throw new EpisodeChannelError('unknown_channel');
  }

  const madeForKids = resolveChannelPolicy(channel).made_for_kids === true;
  if (madeForKids && ((path === 'whatif' && subPath === 'body') || (path === 'story' && RESTRICTED_STORY_SUBPATHS.has(subPath)))) {
    throw new EpisodeChannelError('kids_channel_forbidden');
  }

  return {
    channel_id: channel.id,
    genre: typeof channel.genre === 'string' ? channel.genre : '',
    made_for_kids: madeForKids,
  };
}
