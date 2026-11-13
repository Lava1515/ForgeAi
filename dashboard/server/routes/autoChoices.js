// Decides the fields the owner left on "Auto" for a batch of code-built videos, from the channel's own data.
// resolveAutoChoices is pure (no network, no disk): it returns a copy of the request body with the decided fields
// filled in, plus {field: {value, reason}}. Fields the request does not mark true are never touched.
import { loadChannelIdeas } from '../growth/ideas.js';
import { getThemesFilePath, readThemes } from './trends.js';

export const AUTO_FIELDS = ['theme', 'contentMode', 'model', 'seconds'];
export const DEFAULT_AUTO_SECONDS = 35; // inside the 30-40 s owner default
const MAX_THEME_CHARS = 500;
// A theme that tries to talk the pipeline out of its checks is skipped, never sent.
const BYPASS_PATTERNS = [
  /\b(?:bypass|skip|disable|override|ignore|circumvent)\s*(?:any\s+|all\s+|the\s+)?(?:verification|verify|sources?|claims?|safety|licen[cs]e|provenance|gates?|checks?)\b/i,
  /\bwithout\s*(?:any\s+|all\s+|the\s+)?(?:verification|sources?|safety|checks?|provenance)\b/i,
  /\b(?:no|zero)\s*(?:verification|sources?|safety\s*checks?|provenance)\b/i,
  /\b(?:do\s*not|don\s*t|dont)\s*(?:verify|check\s*sources?)\b/i,
];

export const wantsAuto = (choices) => AUTO_FIELDS.some((field) => choices?.[field] === true);

const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const ideaText = (idea) => clean(typeof idea === 'string' ? idea : idea?.topic || idea?.theme || idea?.name || idea?.title);
const usableTheme = (text) => Boolean(text) && text.length <= MAX_THEME_CHARS && !BYPASS_PATTERNS.some((re) => re.test(text));

// Rule theme: the highest ranked growth idea, else the top theme of the cached scan for this niche, else none.
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
  return { text: '', reason: 'no growth idea or cached scan' };
}

export function resolveAutoChoices({ body = {}, channel = null, growth = null, trends = null } = {}) {
  const want = (field) => body.auto_choices?.[field] === true;
  const next = { ...body };
  const resolved = {};
  const set = (field, value, reason) => { resolved[field] = { value, reason }; };

  let theme = null;
  if (want('theme')) {
    theme = chooseTheme({ growth, trends, niche: clean(body.niche) });
    set('theme', theme.text, theme.reason);
    if (theme.text) next.generation_profile = { ...(next.generation_profile ?? {}), theme_preset: 'custom', custom_theme_text: theme.text };
  }

  // Rule contentMode: whatif only for a "What if" theme, otherwise factual; never fiction (explicit only).
  if (want('contentMode')) {
    const themeText = theme?.text || clean(body.generation_profile?.custom_theme_text ?? body.custom_theme_text);
    const mode = /^what if\b/i.test(themeText) ? 'whatif' : 'factual';
    next.contentMode = mode;
    set('contentMode', mode, mode === 'whatif' ? 'the theme is a "What if" question' : 'default for a factual channel');
  }

  // Rule model: Qwen3 is the only voice family.
  if (want('model')) {
    const family = clean(channel?.voice).split(':')[0].toLowerCase();
    next.model = 'qwen';
    set('model', next.model, family === 'qwen' ? "the channel's voice" : 'default voice family');
  }

  // Rule seconds: the channel's default length if set, else 35 s.
  if (want('seconds')) {
    const own = Math.round(Number(channel?.default_seconds));
    const fromChannel = own >= 1 && own <= 300;
    next.seconds = fromChannel ? own : DEFAULT_AUTO_SECONDS;
    set('seconds', next.seconds, fromChannel ? "the channel's default length" : 'owner default 30-40 s');
  }
  return { body: next, resolved };
}

// The only disk reads: the channel's stored growth ideas and the cached factual themes scan.
export const loadAutoInputs = (channel) => ({
  growth: { ideas: loadChannelIdeas(channel?.id || 'default') },
  trends: readThemes(getThemesFilePath('factual')),
});
