import { cleanEngine } from '../routes/channelsManager.js';

export const GROWTH_PROFILES = {
  cutaway: {
    id: 'cutaway',
    name: '3D Cutaways & Technical Explanations',
    templates: ['niche-authority-channel.md', 'shorts-first-channel.md'],
    rules: [
      'Reveal-based hooks ("what is inside X", "how X actually works under the surface").',
      'Series rhythm: establish recognizable structure and repeatable curiosity payoff.',
      'Engineering and technical niche keywords prioritized for high-intent search and suggestion.',
    ].join('\n'),
  },
  narrative: {
    id: 'narrative',
    name: 'AI Narrative & Director Stories',
    templates: ['entertainment-channel.md', 'commentary-channel.md', 'shorts-first-channel.md'],
    rules: [
      'Retain existing information-gap rules.',
      'Pillar-based topics: focus ideas within distinct thematic content pillars.',
      'Entertainment and commentary hooks with early tension and rapid progression.',
    ].join('\n'),
  },
  kids: {
    id: 'kids',
    name: 'Preschool & Made For Kids',
    templates: ['kids-channel.md'],
    rules: [
      'Use a static camera or gentle movement, with changes led by content beats such as a new object, character action, or sound.',
      'Use music and sound effects as the soundtrack.',
      'Titles and metadata written for the parent or caregiver.',
      'Keep every moment calm, safe, and suited to the topic.',
      'Include one clear learning moment or discovery.',
    ].join('\n'),
  },
};

/**
 * Resolves the channel to one of the 3 growth profiles: 'cutaway' | 'narrative' | 'kids'.
 * Accepts same inputs as resolveChannelPolicy (engine, made_for_kids, audio_mode).
 */
export function resolveGrowthProfile(channel = {}) {
  const engine = cleanEngine(channel?.engine);
  const madeForKids = Boolean(channel?.made_for_kids);

  if (engine === 'preschool_3d' || madeForKids) {
    return 'kids';
  }
  if (engine === 'cutaway3d') {
    return 'cutaway';
  }
  return 'narrative';
}

export function getProfileText(profileName) {
  const profile = GROWTH_PROFILES[profileName] || GROWTH_PROFILES.narrative;
  return `### Growth Profile: ${profile.name} (${profile.id})\n${profile.rules}`;
}

export function growthPromptRules(channel = {}) {
  if (channel.growth_profile_prompts !== true) return '';
  const profileName = resolveGrowthProfile(channel);
  if (profileName === 'kids') return GROWTH_PROFILES.kids.rules;
  return `${GROWTH_PROFILES[profileName].rules}\n- SEO metadata: use a 20-40 character title with the primary keyword first; put the topic and value in the first 125 description characters; include 3-5 relevant hashtags and 10-12 relevant tags.`;
}

export function resolveSizeTier(subscriberCount) {
  const count = Number(subscriberCount);
  if (!Number.isFinite(count) || count < 1000) {
    return 'New (under 1K)';
  }
  if (count < 10000) {
    return 'Small (1K-10K)';
  }
  if (count < 100000) {
    return 'Growing (10K-100K)';
  }
  return 'Established (100K+)';
}

export function buildChannelContext(channel = {}, profileName = null) {
  const resolvedProfile = profileName || resolveGrowthProfile(channel);
  const profileText = getProfileText(resolvedProfile);
  const name = channel.name || channel.title || 'ForgeAI Channel';
  const niche = channel.genre || channel.niche || 'General';
  const sizeTier = resolveSizeTier(channel.subscriber_count ?? channel.subscribers);
  const goal = channel.goal || 'Audience growth, retention optimization, and repeatable series creation';

  return [
    '## Channel Context',
    `- Channel Name: ${name}`,
    `- Niche: ${niche}`,
    `- Size Tier: ${sizeTier}`,
    `- Primary Goal: ${goal}`,
    '',
    profileText,
  ].join('\n');
}
