export const BANNED_GENERIC_PHRASES = [
  'post consistently',
  'upload consistently',
  'post regularly',
  'upload regularly',
  'create engaging content',
  'quality over quantity',
  'engage with your audience',
  'make good videos',
  'content is king',
  'be authentic',
  'find your niche',
  'keep viewers watching',
];

export const REQUIRED_SECTIONS_BY_SUBSKILL = {
  hook: ['topic_analysis', 'hooks'],
  metadata: ['titles', 'description', 'tags'],
  ideate: ['ideas'],
  script: ['hook', 'body'],
  strategy: ['strategy'],
  audit: ['audit'],
  analyze: ['analysis'],
  competitor: ['competitor_insights'],
  seo: ['keywords'],
  shorts: ['shorts_plan'],
};

function collectStrings(value, list = []) {
  if (typeof value === 'string') {
    list.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, list);
  } else if (value && typeof value === 'object') {
    for (const val of Object.values(value)) collectStrings(val, list);
  }
  return list;
}

/**
 * Checks quality gates on a JSON object returned by the model:
 * 1. Specific (no banned generic phrases, actionable)
 * 2. Grounded (benchmarks must cite a source or be explicitly marked unavailable)
 * 3. Complete (all required schema sections present and non-empty)
 */
export function checkQualityGates(output, { subskill, channel, profile, requiredSections } = {}) {
  const gates = {
    specific: { passed: true },
    grounded: { passed: true },
    complete: { passed: true },
  };
  const failures = [];

  if (!output || typeof output !== 'object') {
    return {
      passed: false,
      gates: {
        specific: { passed: false, reason: 'Output is not a valid JSON object' },
        grounded: { passed: false, reason: 'Output is not a valid JSON object' },
        complete: { passed: false, reason: 'Output is not a valid JSON object' },
      },
      failures: ['Output is not a valid JSON object'],
    };
  }

  // 1. SPECIFICITY GATE
  const allStrings = collectStrings(output);
  const foundBanned = [];
  for (const str of allStrings) {
    const lower = str.toLowerCase();
    for (const phrase of BANNED_GENERIC_PHRASES) {
      if (lower.includes(phrase)) {
        foundBanned.push(phrase);
      }
    }
  }

  if (foundBanned.length > 0) {
    const unique = [...new Set(foundBanned)];
    const reason = `Generic phrase(s) detected: ${unique.map((p) => `"${p}"`).join(', ')}. Recommendations must be specific and actionable for this channel.`;
    gates.specific = { passed: false, reason };
    failures.push(reason);
  }

  // 2. GROUNDED GATE
  // If benchmarks are cited, each benchmark must carry a reference source or be marked 'unavailable'
  const benchmarks = Array.isArray(output.benchmarks)
    ? output.benchmarks
    : output.benchmarks && typeof output.benchmarks === 'object'
      ? Object.values(output.benchmarks)
      : null;

  if (benchmarks && Array.isArray(benchmarks)) {
    for (const b of benchmarks) {
      if (b && typeof b === 'object') {
        const textValues = Object.values(b).map((v) => String(v || '').toLowerCase()).join(' ');
        const isUnavailable = textValues.includes('unavailable');
        const hasSource = Boolean(b.source && String(b.source).trim());

        if (!hasSource && !isUnavailable) {
          const reason = `Benchmark cited without reference source or 'benchmark unavailable' note: ${JSON.stringify(b)}`;
          gates.grounded = { passed: false, reason };
          failures.push(reason);
          break;
        }
      }
    }
  }

  // 3. COMPLETENESS GATE
  const expectedKeys = requiredSections || REQUIRED_SECTIONS_BY_SUBSKILL[subskill] || [];
  for (const key of expectedKeys) {
    const val = output[key];
    const isEmpty = val === undefined || val === null || (Array.isArray(val) && val.length === 0) || (typeof val === 'string' && !val.trim());
    if (isEmpty) {
      const reason = `Missing required section: "${key}"`;
      gates.complete = { passed: false, reason };
      failures.push(reason);
    }
  }

  const passed = gates.specific.passed && gates.grounded.passed && gates.complete.passed;
  return {
    passed,
    gates,
    failures,
  };
}
