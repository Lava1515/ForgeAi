import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askGemini, isAgyBlocked, extractJson } from '../routes/gemini.js';
import { resolveGrowthProfile, buildChannelContext } from './profiles.js';
import { checkQualityGates } from './check.js';
import { runClaudeFallback } from './claudeFallback.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');

const SUBSKILL_FILE_MAP = {
  tags: 'metadata.md',
  titles: 'metadata.md',
  metadata: 'metadata.md',
  hook: 'hook.md',
  ideate: 'ideate.md',
  script: 'script.md',
  strategy: 'strategy.md',
  analyze: 'analyze.md',
  audit: 'audit.md',
  competitor: 'competitor.md',
  seo: 'seo.md',
  shorts: 'shorts.md',
};

/**
 * Builds the complete prompt for a growth sub-skill:
 * channel context + sub-skill markdown + only the references named in the sub-skill + JSON output schema.
 */
export function buildGrowthPrompt({
  subskill,
  channel = {},
  input = {},
  profile: profileOverride = null,
  knowledgeDir = KNOWLEDGE_DIR,
} = {}) {
  const normSubskill = String(subskill || '').toLowerCase().trim();
  const profile = profileOverride || resolveGrowthProfile(channel);
  const channelContext = buildChannelContext(channel, profile);

  // Load sub-skill file
  const fileName = SUBSKILL_FILE_MAP[normSubskill] || `${normSubskill}.md`;
  const subskillPath = path.join(knowledgeDir, 'sub-skills', fileName);
  let subskillContent = '';
  if (fs.existsSync(subskillPath)) {
    subskillContent = fs.readFileSync(subskillPath, 'utf8');
  } else {
    subskillContent = `# Growth Sub-skill: ${normSubskill}\nExecute growth workflow for ${normSubskill}.`;
  }

  // Find references named in the sub-skill content
  const refMatches = [...subskillContent.matchAll(/references\/([a-z0-9\-]+\.md)/gi)];
  const uniqueRefNames = [...new Set(refMatches.map((m) => m[1]))];

  const loadedReferences = [];
  for (const refName of uniqueRefNames) {
    const refPath = path.join(knowledgeDir, 'references', refName);
    if (fs.existsSync(refPath)) {
      const content = fs.readFileSync(refPath, 'utf8');
      loadedReferences.push(`### Reference: ${refName}\n${content}`);
    }
  }

  const sections = [
    channelContext,
    '',
    '## Active Sub-Skill',
    subskillContent,
    '',
  ];

  if (loadedReferences.length > 0) {
    sections.push(
      '## Reference Knowledge (Loaded for this Sub-Skill)',
      ...loadedReferences,
      ''
    );
  }

  sections.push(
    '## Current Input Data',
    typeof input === 'string' ? input : JSON.stringify(input, null, 2),
    '',
    '## Output Schema & Instructions',
    'Return ONLY a single valid JSON object containing your recommendations.',
    'Do NOT wrap in markdown fences (```json), do not add conversational pleasantries or commentary.',
    'Quality Requirements:',
    '1. Recommendations MUST be specific to this channel niche and profile rules (no banned generic advice).',
    '2. Any cited benchmark MUST cite a source from the references or be explicitly marked "benchmark unavailable".',
    '3. Output MUST be complete with all required structured sections.'
  );

  return sections.join('\n');
}

/**
 * askGrowth(subskill, channel, input, { search })
 * 1. Resolves channel profile and builds structured prompt
 * 2. If isAgyBlocked() is true, falls back to Claude immediately
 * 3. Calls askGemini (agy first); validates through 3 quality gates
 * 4. Retries once with failure feedback if malformed or gates fail
 * 5. On second failure or error, falls back to Claude (Haiku or Sonnet)
 * 6. Surfaces agy error if Claude fallback is unavailable; never crashes caller
 */
export async function askGrowth(subskill, channel = {}, input = {}, {
  search = false,
  askGeminiFn = askGemini,
  claudeFallbackFn = runClaudeFallback,
  isAgyBlockedFn = isAgyBlocked,
} = {}) {
  const profile = resolveGrowthProfile(channel);
  const prompt = buildGrowthPrompt({ subskill, channel, input, profile });

  // Direct fallback if agy is currently blocked
  if (typeof isAgyBlockedFn === 'function' && isAgyBlockedFn()) {
    try {
      return await claudeFallbackFn(prompt, { subskill });
    } catch (claudeErr) {
      if (claudeErr.unavailable || /unavailable/i.test(claudeErr.message)) {
        throw new Error('Antigravity CLI is blocked and Claude fallback unavailable');
      }
      throw claudeErr;
    }
  }

  let lastAgyError = null;
  let failures = [];

  // Attempt 1: Call askGemini
  try {
    const raw = await askGeminiFn(prompt, { search });
    let parsed = null;
    if (raw && typeof raw === 'object') {
      parsed = raw;
    } else if (typeof raw === 'string') {
      try {
        parsed = extractJson(raw);
      } catch {}
    }

    if (parsed) {
      const check = checkQualityGates(parsed, { subskill, channel, profile });
      if (check.passed) {
        return parsed;
      }
      failures = check.failures;
      lastAgyError = new Error(`Quality check failed: ${failures.join('; ')}`);
    } else {
      failures = ['Malformed or empty JSON response from model'];
      lastAgyError = new Error('Malformed or empty JSON response from model');
    }
  } catch (err) {
    lastAgyError = err;
    failures = [err.message || 'Error executing model request'];
  }

  // Attempt 2: Retry once with feedback
  const retryPrompt = [
    prompt,
    '',
    'CRITICAL: Your previous response failed the following quality checks:',
    ...failures.map((f) => `- ${f}`),
    '',
    'Please regenerate the complete JSON response, ensuring all quality checks pass.',
  ].join('\n');

  try {
    const raw = await askGeminiFn(retryPrompt, { search });
    let parsed = null;
    if (raw && typeof raw === 'object') {
      parsed = raw;
    } else if (typeof raw === 'string') {
      try {
        parsed = extractJson(raw);
      } catch {}
    }

    if (parsed) {
      const check = checkQualityGates(parsed, { subskill, channel, profile });
      if (check.passed) {
        return parsed;
      }
      failures = check.failures;
      lastAgyError = new Error(`Quality check failed on retry: ${failures.join('; ')}`);
    } else {
      lastAgyError = new Error('Malformed or empty JSON response on retry');
    }
  } catch (err) {
    lastAgyError = err;
  }

  // Fallback to Claude on second failure
  try {
    return await claudeFallbackFn(prompt, { subskill });
  } catch (claudeErr) {
    if (claudeErr.unavailable || /unavailable/i.test(claudeErr.message)) {
      throw (lastAgyError || new Error('Antigravity CLI failed and Claude fallback unavailable'));
    }
    throw claudeErr;
  }
}
