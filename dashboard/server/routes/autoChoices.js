import { listVerifiedModels, getModelUsage, modelSlug } from './model3d.js';
// KAN-531: decide the Shorts fields the owner left on "Auto" from the channel's own flow.
// resolveAutoChoices is pure (no network, no disk): it returns a copy of the request body with the decided fields
// filled in, plus {field: {value, reason}} for the batch. Fields the request does not mark true are never touched.
import { ENGINES } from './channelsManager.js';
import { normaliseGenerationProfile } from './generationProfile.js';
import { loadChannelIdeas } from '../growth/ideas.js';
import { getThemesFilePath, readThemes } from './trends.js';

export const AUTO_FIELDS = ['theme', 'engine', 'contentMode', 'model', 'seconds', 'environment', 'brief'];
export const DEFAULT_AUTO_SECONDS = 35; // inside the 30-40 s owner default
const MAX_THEME_CHARS = 500; // MAX_CUSTOM_THEME_LENGTH in generationProfile.js

export const wantsAuto = (choices) => AUTO_FIELDS.some((field) => choices?.[field] === true);

const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const ideaText = (idea) => clean(typeof idea === 'string' ? idea : idea?.topic || idea?.theme || idea?.name || idea?.title);
// A theme that the same validation as a typed custom theme would reject (e.g. a verification-bypass phrase) is skipped, never sent.
const usableTheme = (text) => text && text.length <= MAX_THEME_CHARS && normaliseGenerationProfile({ theme_preset: 'custom', custom_theme_text: text }).ok;

// Rule theme: the highest ranked growth idea, else the top theme of the cached scan for this niche, else the preset.
function chooseTheme({ growth, trends, niche }) {
  const ranked = (Array.isArray(growth?.ideas) ? [...growth.ideas] : []).sort((a, b) => (a?.rank ?? 1e9) - (b?.rank ?? 1e9));
  for (const idea of ranked) {
    const text = ideaText(idea);
    if (usableTheme(text)) return { text, reason: `top growth idea${idea?.rank ? ` (rank ${idea.rank})` : ''}` };
  }
  if (Array.isArray(trends?.themes) && (!niche || !trends.niche || trends.niche === niche)) {
    const scanned = [...trends.themes].sort((a, b) => (Number(b?.score) || 0) - (Number(a?.score) || 0));
    for (const theme of scanned) {
      const text = clean(theme?.premise) || clean(theme?.topic) || clean(theme?.name);
      if (usableTheme(text)) return { text, reason: `top theme from the cached scan${trends.niche ? ` for "${trends.niche}"` : ''}` };
    }
  }
  return { preset: 'people_scenarios', reason: 'no growth idea or cached scan; default preset' };
}


function chooseLibraryTheme({ library, usage, growth, trends, niche }) {
  const models = Array.isArray(library) ? library : listVerifiedModels();
  const verified = models.filter((m) => {
    const score = Number.isFinite(m?.score) ? m.score : m?.check?.score;
    const rejected = m?.rejected === true || m?.check?.rejected === true;
    return score >= 6 && !rejected;
  });
  if (!verified.length) {
    return chooseTheme({ growth, trends, niche });
  }
  const usageMap = usage || getModelUsage();
  const sorted = [...verified].sort((a, b) => {
    const slugA = a.slug || modelSlug(a.name);
    const slugB = b.slug || modelSlug(b.name);
    const timeA = usageMap[slugA] || usageMap[a.name] ? new Date(usageMap[slugA] || usageMap[a.name]).getTime() : 0;
    const timeB = usageMap[slugB] || usageMap[b.name] ? new Date(usageMap[slugB] || usageMap[b.name]).getTime() : 0;
    if (timeA !== timeB) return timeA - timeB;
    return (a.name || slugA).localeCompare(b.name || slugB);
  });
  const pick = sorted[0];
  const name = pick.name || pick.slug;
  return {
    text: name,
    reason: `library model ${name}, no generation needed`,
  };
}

export function resolveAutoChoices({ body = {}, channel = null, growth = null, trends = null, library = null, usage = null } = {}) {
  const want = (field) => body.auto_choices?.[field] === true;
  const next = { ...body };
  const resolved = {};
  const set = (field, value, reason) => { resolved[field] = { value, reason }; };

  // Rule engine: the channel's engine if it has one, else director (the planner picks 3D or AI per scene).
  let nextEngine;
  if (want('engine')) {
    const channelEngine = ENGINES.includes(channel?.engine) ? channel.engine : null;
    nextEngine = channelEngine || 'director';
    next.engine = nextEngine;
    set('engine', next.engine, channelEngine ? "the channel's engine" : 'planner picks 3D or AI per scene');
  } else {
    nextEngine = ENGINES.includes(body.engine) ? body.engine : (channel?.engine || null);
  }

  // Rule theme (see chooseTheme / chooseLibraryTheme).
  let theme;
  if (want('theme')) {
    if (nextEngine === 'cutaway3d') {
      theme = chooseLibraryTheme({ library, usage, growth, trends, niche: clean(body.niche) });
    } else {
      theme = chooseTheme({ growth, trends, niche: clean(body.niche) });
    }
    set('theme', theme.text || theme.preset, theme.reason);
  }

  // Rule contentMode: factual, whatif only for a "What if" theme (never for the silent kids engine), never fiction (explicit only).
  const themeText = theme ? theme.text || '' : clean(body.generation_profile?.custom_theme_text ?? body.custom_theme_text);
  const effectiveEngine = ENGINES.includes(next.engine) ? next.engine : channel?.engine;
  let mode = body.contentMode ?? body.content_mode;
  if (want('contentMode')) {
    mode = /^what if\b/i.test(themeText) && effectiveEngine !== 'preschool_3d' ? 'whatif' : 'factual';
    next.contentMode = mode;
    set('contentMode', mode, mode === 'whatif' ? 'the theme is a "What if" question' : 'default for a factual channel');
  }

  // Rule model: the channel's voice family if creation allows it, else qwen. Fish is blocked by licence policy (VOICE_POLICY_ERROR in studio.js).
  if (want('model')) {
    const family = clean(channel?.voice).split(':')[0].toLowerCase();
    next.model = 'qwen'; // qwen is the only creatable family, so a channel voice in any other family falls back to it
    set('model', next.model, family === 'qwen' ? "the channel's voice" : family ? 'channel voice is not allowed for creation; qwen used' : 'default voice family');
  }

  // Rule seconds: the channel's default length if set, else 35 s.
  if (want('seconds')) {
    const own = Math.round(Number(channel?.default_seconds));
    const fromChannel = own >= 1 && own <= 300;
    next.seconds = fromChannel ? own : DEFAULT_AUTO_SECONDS;
    set('seconds', next.seconds, fromChannel ? "the channel's default length" : 'owner default 30-40 s');
  }

  // Rules brief (empty) and topic-matched environment; creating a profile here prevents normalization from silently restoring workroom.
  const given = body.generation_profile ?? body.generationProfile;
  const base = given && typeof given === 'object' && !Array.isArray(given) ? given : null;
  // KAN-531: the chosen theme (Auto theme, or a custom theme text) that names a known place gets a matching environment; a typed topic or niche alone, and
  // any other theme, keep the earlier behaviour (a profile default when a profile exists, otherwise the planner decides by topic).
  const envTopic = want('environment') ? clean(theme?.text || body.generation_profile?.custom_theme_text || body.custom_theme_text) : '';
  const envKind = /\b(rocket|space|orbit|astronaut|planet|moon)\b/i.test(envTopic) ? 'space'
    : /\b(desert|dune|sahara)\b/i.test(envTopic) ? 'desert'
      : /\b(ocean|sea|underwater|wave|marine)\b/i.test(envTopic) ? 'ocean'
        : /\b(street|road|city|urban|crosswalk)\b/i.test(envTopic) ? 'street' : null;
  const profile = base || theme || envKind ? { ...base } : null;
  if (want('brief')) {
    next.script_brief = '';
    delete next.scriptBrief;
    if (profile) { profile.script_brief = ''; delete profile.scriptBrief; }
    set('brief', '', 'no extra guidance');
  }
  if (want('environment')) {
    if (envKind) {
      const environments = {
        space: { preset: 'outdoor', ground_material: 'rock', visible_sky: 'hdri', lighting: 'night' },
        desert: { preset: 'outdoor', ground_material: 'sand', visible_sky: 'hdri', lighting: 'sunset' },
        ocean: { preset: 'outdoor', ground_material: 'sand', visible_sky: 'hdri', lighting: 'overcast' },
        street: { preset: 'outdoor', ground_material: 'concrete', visible_sky: 'hdri', lighting: 'natural' },
      };
      profile.environment = environments[envKind];
      set('environment', profile.environment, `topic matched ${envKind}`);
    } else {
      if (profile) delete profile.environment;
      // normaliseGenerationProfile gives any profile its default background; only a request without a profile leaves the choice to the planner.
      set('environment', null, profile ? 'profile default background applies' : 'planner decides by topic');
    }
  }
  if (theme) {
    // The theme is also mirrored at the top level of the request; drop typed mirrors so they cannot conflict with the decision.
    for (const key of ['theme', 'themePreset', 'customThemeText', 'custom_theme_text']) delete next[key];
    profile.theme_preset = theme.text ? 'custom' : theme.preset;
    next.theme_preset = profile.theme_preset;
    for (const key of ['themePreset', 'customThemeText', 'custom_theme_text']) delete profile[key];
    if (theme.text) profile.custom_theme_text = next.custom_theme_text = theme.text;
  }
  if (profile) {
    // Profile and top-level contentMode must agree (legacy mirror check); a fiction request keeps its own top-level value.
    if (want('contentMode') || !base) profile.contentMode = mode === 'whatif' ? 'whatif' : 'factual';
    next.generation_profile = profile;
    delete next.generationProfile;
  }
  return { body: next, resolved };
}

// The only disk reads: the channel's stored growth ideas and the cached factual themes scan.
export const loadAutoInputs = (channel) => ({
  growth: { ideas: loadChannelIdeas(channel?.id || 'default') },
  trends: readThemes(getThemesFilePath('factual')),
  library: listVerifiedModels(),
  usage: getModelUsage(),
});
