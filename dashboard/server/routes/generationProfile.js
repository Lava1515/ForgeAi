import { deepFreeze } from '../lib/objects.js';
/**
 * Generation Profile Contract (Story3D T11 / KAN-299)
 *
 * Provides immutable version-1 generation_profile snapshot validation,
 * normalization, defaults, and conflict resolution against legacy top-level mirrors.
 */

export const THEME_PRESETS = Object.freeze([
  { id: 'people_scenarios', label: 'People & Scenarios', desc: 'Real-world human interactions and scenarios' },
  { id: 'everyday_mechanisms', label: 'Everyday Mechanisms', desc: 'How familiar objects, tools, and machines work' },
  { id: 'engineering_space', label: 'Engineering & Space', desc: 'Large-scale engineering, aerospace, and astrophysics' },
  { id: 'custom', label: 'Custom Topic', desc: 'Authored custom topic or premise' },
]);

export const VALID_THEME_PRESET_IDS = Object.freeze(THEME_PRESETS.map((p) => p.id));

export const CONTENT_MODES = Object.freeze([
  { id: 'factual', label: 'Factual' },
  { id: 'whatif', label: 'What if?' },
]);

export const VALID_CONTENT_MODES = Object.freeze(CONTENT_MODES.map((m) => m.id));

export const ASSET_STRATEGIES = Object.freeze([
  { id: 'reuse_or_generate', label: 'Reuse or Generate' },
  { id: 'regenerate_selected', label: 'Regenerate Selected' },
]);

export const VALID_ASSET_STRATEGIES = Object.freeze(ASSET_STRATEGIES.map((s) => s.id));

export const MAX_SCRIPT_BRIEF_LENGTH = 2000;
export const MAX_CUSTOM_THEME_LENGTH = 500;
export const MAX_ENV_STRING_LENGTH = 100;
export const ENVIRONMENT_PRESETS = Object.freeze(['workroom', 'outdoor']);
export const GROUND_MATERIALS = Object.freeze(['matte_neutral', 'concrete', 'grass', 'dirt', 'sand', 'snow', 'rock']);
export const VISIBLE_SKIES = Object.freeze(['none', 'hdri']);
export const LIGHTING_PRESETS = Object.freeze(['natural', 'morning', 'overcast', 'sunset', 'night']);

export const DEFAULT_ENVIRONMENT = Object.freeze({
  preset: 'workroom',
  ground_material: 'matte_neutral',
  visible_sky: 'none',
  lighting: 'natural',
});

export const DEFAULT_PROMPT_PROFILE = Object.freeze({
  id: 'default',
  revision: 1,
});

export const DEFAULT_GENERATION_PROFILE = Object.freeze({
  version: 1,
  theme_preset: 'people_scenarios',
  custom_theme_text: '',
  contentMode: 'factual',
  script_brief: '',
  prompt_profile: DEFAULT_PROMPT_PROFILE,
  environment: DEFAULT_ENVIRONMENT,
  asset_strategy: 'reuse_or_generate',
  captions: true,
});

const BYPASS_VERIFICATION_PATTERNS = [
  /\b(?:bypass|skip|disable|override|ignore|circumvent)\s*(?:any\s+|all\s+|the\s+)?(?:verification|verify|sources?|claims?|safety|licen[cs]e|provenance|gates?|checks?)\b/i,
  /\bwithout\s*(?:any\s+|all\s+|the\s+)?(?:verification|sources?|safety|checks?|provenance)\b/i,
  /\b(?:no|zero)\s*(?:verification|sources?|safety\s*checks?|provenance)\b/i,
  /\b(?:do\s*not|don\s*t|dont)\s*(?:verify|check\s*sources?)\b/i,
  /\btreat\s+.*?\bas\s*verified\s*without\s*sources?\b/i,
  /\bunverified\s*claims?\b/i,
  /\bfake\s*sources?\b/i,
];

function hasVerificationBypassAttempt(text) {
  if (typeof text !== 'string') return false;
  // Normalise before matching: lowercase, NFKC, strip zero-width, collapse non-letters to single space
  const nfkc = text.normalize('NFKC').toLowerCase();
  const stripped = nfkc.replace(/[\u200B-\u200F\uFEFF\u2060\u180E]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const spaced = nfkc.replace(/[\u200B-\u200F\uFEFF\u2060\u180E]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  return BYPASS_VERIFICATION_PATTERNS.some((pat) => pat.test(stripped) || pat.test(spaced));
}

/**
 * Normalises and validates a generation profile into an immutable version-1 snapshot.
 *
 * @param {Object} value - Raw profile object or object containing generation_profile
 * @param {Object} context - Validation options (e.g. expectedRevision, legacy mirrors)
 * @returns {{ ok: boolean, value: Object | null, errors: string[] }}
 */
export function normaliseGenerationProfile(value, context = {}) {
  const errors = [];

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, value: null, errors: ['Profile must be an object'] };
  }

  // Unwrap if wrapped in generation_profile or generationProfile
  const hasWrappedProfile = Boolean(value.generation_profile || value.generationProfile);
  const rawProfile = value.generation_profile || value.generationProfile || value;

  if (rawProfile === null || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) {
    return { ok: false, value: null, errors: ['generation_profile must be an object'] };
  }

  // Check version
  const rawVersion = rawProfile.version !== undefined ? rawProfile.version : 1;
  if (rawVersion !== 1 && rawVersion !== '1') {
    errors.push(`Unsupported profile version "${rawVersion}"; only version 1 is supported`);
  }
  const version = 1;

  // Check theme_preset
  const rawThemePreset = rawProfile.theme_preset !== undefined
    ? rawProfile.theme_preset
    : rawProfile.themePreset !== undefined
      ? rawProfile.themePreset
      : 'people_scenarios';

  let theme_preset = 'people_scenarios';
  if (typeof rawThemePreset !== 'string' || !VALID_THEME_PRESET_IDS.includes(rawThemePreset)) {
    errors.push(`Invalid theme_preset: must be one of ${VALID_THEME_PRESET_IDS.join(', ')}`);
  } else {
    theme_preset = rawThemePreset;
  }

  // Check custom_theme_text
  let custom_theme_text = '';
  if (theme_preset === 'custom') {
    const rawCustom = rawProfile.custom_theme_text !== undefined
      ? rawProfile.custom_theme_text
      : rawProfile.customThemeText !== undefined
        ? rawProfile.customThemeText
        : '';
    if (typeof rawCustom !== 'string' || !rawCustom.trim()) {
      errors.push('custom_theme_text is required when theme_preset is "custom"');
    } else if (rawCustom.length > MAX_CUSTOM_THEME_LENGTH) {
      errors.push(`custom_theme_text is oversized (max ${MAX_CUSTOM_THEME_LENGTH} characters)`);
    } else if (hasVerificationBypassAttempt(rawCustom)) {
      errors.push('Guidance cannot override source, capability, licence, safety, resource or provenance gates (verification bypass rejected)');
    } else {
      custom_theme_text = rawCustom.trim();
    }
  }

  // Check contentMode (independent of theme)
  const rawContentMode = rawProfile.contentMode !== undefined ? rawProfile.contentMode : 'factual';
  let contentMode = 'factual';
  if (typeof rawContentMode !== 'string' || !VALID_CONTENT_MODES.includes(rawContentMode)) {
    errors.push(`Invalid contentMode: must be one of ${VALID_CONTENT_MODES.join(', ')}`);
  } else {
    contentMode = rawContentMode;
  }

  // Check script_brief (guidance)
  const rawBrief = rawProfile.script_brief !== undefined
    ? rawProfile.script_brief
    : rawProfile.scriptBrief !== undefined
      ? rawProfile.scriptBrief
      : '';
  let script_brief = '';
  if (typeof rawBrief !== 'string') {
    errors.push('script_brief must be a string');
  } else if (rawBrief.length > MAX_SCRIPT_BRIEF_LENGTH) {
    errors.push(`script_brief is oversized (max ${MAX_SCRIPT_BRIEF_LENGTH} characters)`);
  } else if (hasVerificationBypassAttempt(rawBrief)) {
    errors.push('Guidance cannot override source, capability, licence, safety, resource or provenance gates (verification bypass rejected)');
  } else {
    script_brief = rawBrief;
  }

  // Check prompt_profile
  const rawPromptProfile = rawProfile.prompt_profile !== undefined
    ? rawProfile.prompt_profile
    : rawProfile.promptProfile !== undefined
      ? rawProfile.promptProfile
      : DEFAULT_PROMPT_PROFILE;

  let prompt_profile = { id: 'default', revision: 1 };
  if (rawPromptProfile === null || typeof rawPromptProfile !== 'object' || Array.isArray(rawPromptProfile)) {
    errors.push('prompt_profile must be an object');
  } else {
    const rawId = rawPromptProfile.id !== undefined ? rawPromptProfile.id : 'default';
    const rawRev = rawPromptProfile.revision !== undefined ? rawPromptProfile.revision : 1;

    if (typeof rawId !== 'string' || !rawId.trim()) {
      errors.push('prompt_profile.id must be a non-empty string');
    }

    const numRev = Number(rawRev);
    if (!Number.isInteger(numRev) || numRev <= 0) {
      errors.push('prompt_profile revision must be a positive integer');
    } else {
      prompt_profile = {
        id: typeof rawId === 'string' ? rawId.trim() : 'default',
        revision: numRev,
      };
    }
  }

  // Check stale profile values
  if (rawProfile.stale === true || value.stale === true) {
    errors.push('Profile is marked stale and cannot be applied');
  }
  const minRev = context.expectedRevision !== undefined
    ? context.expectedRevision
    : context.minRevision;
  if (minRev !== undefined && prompt_profile.revision < Number(minRev)) {
    errors.push(`Profile revision ${prompt_profile.revision} is stale; expected at least revision ${minRev}`);
  }

  // Check environment (preset, ground material, visible sky, lighting)
  const rawEnv = rawProfile.environment !== undefined ? rawProfile.environment : DEFAULT_ENVIRONMENT;
  let environment = { ...DEFAULT_ENVIRONMENT };
  if (rawEnv === null || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
    errors.push('environment must be an object');
  } else {
    const preset = rawEnv.preset !== undefined ? rawEnv.preset : DEFAULT_ENVIRONMENT.preset;
    const ground = rawEnv.ground_material !== undefined
      ? rawEnv.ground_material
      : rawEnv.groundMaterial !== undefined
        ? rawEnv.groundMaterial
        : DEFAULT_ENVIRONMENT.ground_material;
    const sky = rawEnv.visible_sky !== undefined
      ? rawEnv.visible_sky
      : rawEnv.visibleSky !== undefined
        ? rawEnv.visibleSky
        : DEFAULT_ENVIRONMENT.visible_sky;
    const lighting = rawEnv.lighting !== undefined ? rawEnv.lighting : DEFAULT_ENVIRONMENT.lighting;

    for (const [key, val] of [['preset', preset], ['ground_material', ground], ['visible_sky', sky], ['lighting', lighting]]) {
      if (typeof val !== 'string' || !val.trim()) {
        errors.push(`environment.${key} must be a non-empty string`);
      } else if (val.length > MAX_ENV_STRING_LENGTH) {
        errors.push(`environment.${key} exceeds max length (${MAX_ENV_STRING_LENGTH})`);
      } else if (val.includes('..') || val.includes('/') || val.includes('\\')) {
        errors.push(`environment.${key} contains invalid traversal characters`);
      }
    }

    environment = {
      preset: typeof preset === 'string' ? preset.trim() : DEFAULT_ENVIRONMENT.preset,
      ground_material: typeof ground === 'string' ? ground.trim() : DEFAULT_ENVIRONMENT.ground_material,
      visible_sky: typeof sky === 'string' ? sky.trim() : DEFAULT_ENVIRONMENT.visible_sky,
      lighting: typeof lighting === 'string' ? lighting.trim() : DEFAULT_ENVIRONMENT.lighting,
    };
    for (const [key, val, allowed] of [
      ['preset', preset, ENVIRONMENT_PRESETS],
      ['ground_material', ground, GROUND_MATERIALS],
      ['visible_sky', sky, VISIBLE_SKIES],
      ['lighting', lighting, LIGHTING_PRESETS],
    ]) {
      if (typeof val === 'string' && !allowed.includes(val.trim())) errors.push(`Invalid environment.${key}: must be one of ${allowed.join(', ')}`);
    }
  }

  // Check asset_strategy
  const rawAssetStrategy = rawProfile.asset_strategy !== undefined
    ? rawProfile.asset_strategy
    : rawProfile.assetStrategy !== undefined
      ? rawProfile.assetStrategy
      : 'reuse_or_generate';

  let asset_strategy = 'reuse_or_generate';
  if (typeof rawAssetStrategy !== 'string' || !VALID_ASSET_STRATEGIES.includes(rawAssetStrategy)) {
    errors.push(`Invalid asset_strategy: must be one of ${VALID_ASSET_STRATEGIES.join(', ')}`);
  } else {
    asset_strategy = rawAssetStrategy;
  }

  // Check captions
  const rawCaptions = rawProfile.captions !== undefined ? rawProfile.captions : true;
  if (rawCaptions !== true) {
    errors.push('captions must be true in Story3D; disabling captions is not permitted');
  }
  const captions = true;

  // Check conflicting legacy top-level mirrors
  const legacySources = [];
  if (hasWrappedProfile) {
    legacySources.push(value);
  }
  if (context.legacy && typeof context.legacy === 'object') {
    legacySources.push(context.legacy);
  }
  if (context.topLevel && typeof context.topLevel === 'object') {
    legacySources.push(context.topLevel);
  }

  for (const src of legacySources) {
    if (src.contentMode !== undefined && src.contentMode !== contentMode) {
      errors.push(`Conflicting legacy top-level mirror for contentMode: "${src.contentMode}" vs profile "${contentMode}"`);
    }

    const legacyPreset = src.theme_preset !== undefined
      ? src.theme_preset
      : src.themePreset !== undefined
        ? src.themePreset
        : undefined;
    if (legacyPreset !== undefined && legacyPreset !== theme_preset) {
      errors.push(`Conflicting legacy top-level mirror for theme_preset: "${legacyPreset}" vs profile "${theme_preset}"`);
    }

    if (src.theme !== undefined) {
      if (theme_preset === 'custom') {
        if (src.theme !== custom_theme_text && src.theme !== 'custom') {
          errors.push(`Conflicting legacy top-level mirror for theme: "${src.theme}" vs custom profile "${custom_theme_text}"`);
        }
      } else {
        if (src.theme !== theme_preset) {
          errors.push(`Conflicting legacy top-level mirror for theme: "${src.theme}" vs profile "${theme_preset}"`);
        }
      }
    }

    const legacyCustom = src.custom_theme_text !== undefined
      ? src.custom_theme_text
      : src.customThemeText !== undefined
        ? src.customThemeText
        : undefined;
    if (legacyCustom !== undefined && theme_preset === 'custom' && legacyCustom !== custom_theme_text) {
      errors.push(`Conflicting legacy top-level mirror for custom_theme_text: "${legacyCustom}" vs profile "${custom_theme_text}"`);
    }

    const legacyAssetStrategy = src.asset_strategy !== undefined
      ? src.asset_strategy
      : src.assetStrategy !== undefined
        ? src.assetStrategy
        : undefined;
    if (legacyAssetStrategy !== undefined && legacyAssetStrategy !== asset_strategy) {
      errors.push(`Conflicting legacy top-level mirror for asset_strategy: "${legacyAssetStrategy}" vs profile "${asset_strategy}"`);
    }
    if (src.captions !== undefined && src.captions !== captions) {
      errors.push('Conflicting legacy top-level mirror for captions: captions must remain true');
    }
  }

  if (errors.length > 0) {
    return { ok: false, value: null, errors };
  }

  const snapshot = deepFreeze({
    version,
    theme_preset,
    custom_theme_text,
    contentMode,
    script_brief,
    prompt_profile: Object.freeze(prompt_profile),
    environment: Object.freeze(environment),
    asset_strategy,
    captions,
  });

  return { ok: true, value: snapshot, errors: [] };
}

export const normalizeGenerationProfile = normaliseGenerationProfile;

export function getGenerationProfileDefaultsHandler(req, res) {
  res.status(200).json({
    profile: DEFAULT_GENERATION_PROFILE,
    theme_presets: THEME_PRESETS,
    content_modes: CONTENT_MODES,
    asset_strategies: ASSET_STRATEGIES,
  });
}

export function validateGenerationProfileHandler(req, res) {
  const body = req.body || {};
  const profileToValidate = body.profile !== undefined ? body.profile : body;
  const context = {
    expectedRevision: body.expectedRevision || body.minRevision,
    legacy: body.legacy,
  };
  const result = normaliseGenerationProfile(profileToValidate, context);
  if (!result.ok) {
    return res.status(400).json(result);
  }
  return res.status(200).json(result);
}
