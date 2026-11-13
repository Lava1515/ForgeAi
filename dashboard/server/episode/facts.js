// KAN-844: Fact check stage.
// Evaluates script claims against sources using verifyStoryPlan and the checker role.
// False claims block the video; fiction scenes pass with a label and never excuse a false fact.
// facts.json lists which shots carry a label.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyStoryPlan } from '../routes/storyVerification.js';
import { askRole } from '../routes/askRole.js';
import {
  episodeRoot,
  sha256,
  MAX_ARTIFACT_BYTES,
} from './artifacts.js';

export const FACTS_VERSION = 'episode-facts-v1';
export const FACTS_FILE = 'facts.json';
export const FACTS_ROLE = 'checker';
export const MAX_PROMPT_CHARS = 6000;

export class FactCheckError extends Error {
  constructor(message, { falseClaims = [], reasons = [], facts = null } = {}) {
    super(String(message || 'Fact check failed').slice(0, 500));
    this.name = 'FactCheckError';
    this.falseClaims = falseClaims;
    this.reasons = reasons;
    this.facts = facts;
  }
}

function fail(message) {
  throw new FactCheckError(`facts: ${message}`);
}

function isWithin(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function confineEpisodeDir(episodeDir, root) {
  if (typeof episodeDir !== 'string' || !episodeDir || episodeDir.split(/[\\/]/).includes('..')) {
    fail('invalid Episode folder path');
  }
  let rootResolved;
  let resolved;
  try {
    rootResolved = fs.realpathSync(root);
    const candidate = path.isAbsolute(episodeDir) ? path.resolve(episodeDir) : path.resolve(rootResolved, episodeDir);
    resolved = fs.realpathSync(candidate);
  } catch {
    fail('Episode folder does not exist or cannot be resolved');
  }
  if (!isWithin(rootResolved, resolved)) {
    fail('Episode folder escapes episodes root');
  }
  return resolved;
}

function confineOutDir(outDir, root) {
  if (typeof outDir !== 'string' || !outDir || outDir.split(/[\/]/).includes('..')) fail('invalid output folder path');
  let rootResolved;
  try { rootResolved = fs.realpathSync(root); } catch { fail('episodes root cannot be resolved'); }
  const candidate = path.isAbsolute(outDir) ? path.resolve(outDir) : path.resolve(rootResolved, outDir);
  // Resolve the deepest existing ancestor so a symlink cannot lead outside the root.
  let probe = candidate;
  const tail = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) fail('output folder cannot be resolved');
    tail.unshift(path.basename(probe));
    probe = parent;
  }
  const resolved = path.join(fs.realpathSync(probe), ...tail);
  if (!isWithin(rootResolved, resolved)) fail('output folder escapes episodes root');
  return resolved;
}

function atomicWrite(folder, filename, data) {
  const content = `${JSON.stringify(data, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_ARTIFACT_BYTES) {
    fail(`${filename} exceeds artifact size limit`);
  }
  const target = path.join(folder, filename);
  const temp = path.join(folder, `.${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, target);
  } catch (err) {
    try { fs.unlinkSync(temp); } catch {}
    throw err;
  }
}

function isFictionShotDirect(shot, options = {}) {
  if (!shot) return false;
  if (options.fictionShots?.includes(shot.id)) return true;
  if (options.fictionScenes?.includes(shot.id)) return true;
  if (shot.fiction === true || shot.label === 'fiction' || shot.labels?.includes('fiction')) return true;
  if (shot.args?.fiction === true || shot.look?.fiction === true) return true;
  if (Array.isArray(shot.overlays) && shot.overlays.some((o) => o?.type === 'fiction' || o?.label === 'fiction')) return true;
  return false;
}

function isFictionLineDirect(line, options = {}) {
  if (!line) return false;
  if (options.fictionLines?.includes(line.id)) return true;
  if (options.fictionScenes?.includes(line.id)) return true;
  if (line.fiction === true || line.label === 'fiction' || line.labels?.includes('fiction')) return true;
  if (line.claim === 'fiction') return true;
  return false;
}

function isFictionShot(shot, spec, options = {}) {
  if (isFictionShotDirect(shot, options)) return true;
  if (shot.anchor?.line) {
    const line = spec?.lines?.find((l) => l.id === shot.anchor.line);
    if (line && isFictionLine(line, spec, options)) return true;
  }
  return false;
}

function isFictionLine(line, spec, options = {}) {
  // Only the line's own typed label (or an explicit caller option) exempts a claim.
  // A shot overlay, anchor or arg labels the shot only and never excuses the spoken claim.
  return isFictionLineDirect(line, options);
}

function isIllustrativeShot(shot, options = {}) {
  if (!shot) return false;
  if (options.illustrativeShots?.includes(shot.id)) return true;
  if (shot.illustrative === true || shot.label === 'illustrative' || shot.labels?.includes('illustrative')) return true;
  if (shot.args?.illustrative === true) return true;
  if (Array.isArray(shot.overlays) && shot.overlays.some((o) => o?.type === 'illustrative' || o?.label === 'illustrative' || o?.type === 'badge')) return true;
  if (Array.isArray(options.illustrativeParts)) {
    if (options.illustrativeParts.includes(shot.asset) || options.illustrativeParts.includes(shot.camera?.target)) return true;
  }
  return false;
}

export function resolveShotLabels(spec, options = {}) {
  const shots = [];
  const labeledShots = [];
  const labels = [];
  const fictionShots = [];
  const illustrativeShots = [];

  const rawShots = Array.isArray(spec?.shots) ? spec.shots : [];

  for (const shot of rawShots) {
    const shotId = shot?.id || 'unnamed';
    const isFic = isFictionShot(shot, spec, options);
    const isIll = isIllustrativeShot(shot, options);

    const shotLabels = [];
    if (isFic) {
      shotLabels.push('fiction');
      fictionShots.push(shotId);
      labels.push({ shot: shotId, id: shotId, type: 'fiction', label: 'fiction' });
    }
    if (isIll) {
      shotLabels.push('illustrative');
      illustrativeShots.push(shotId);
      labels.push({ shot: shotId, id: shotId, type: 'illustrative', label: 'illustrative' });
    }
    if (shot?.label && !shotLabels.includes(shot?.label)) {
      shotLabels.push(shot.label);
      labels.push({ shot: shotId, id: shotId, type: shot.label, label: shot.label });
    }
    if (Array.isArray(shot?.labels)) {
      for (const lb of shot.labels) {
        if (!shotLabels.includes(lb)) {
          shotLabels.push(lb);
          labels.push({ shot: shotId, id: shotId, type: lb, label: lb });
        }
      }
    }

    const shotRecord = {
      id: shotId,
      shot: shotId,
      labels: shotLabels,
      label: shotLabels[0] || null,
      fiction: isFic,
      illustrative: isIll,
      anchor: shot.anchor || null,
    };

    shots.push(shotRecord);
    if (shotLabels.length > 0) {
      labeledShots.push(shotRecord);
    }
  }

  return {
    shots,
    labeledShots,
    labels,
    fictionShots,
    illustrativeShots,
  };
}

function buildDefaultSearch({ askRoleFn = askRole, topic = '', onCallRecord } = {}) {
  return async ({ claims = [], premise = null }) => {
    if (!claims.length) return { facts: [] };
    const prompt = [
      'Check every assertion below against real-world authoritative facts.',
      `Topic: ${topic.slice(0, 500)}`,
      'Return ONLY JSON: {"facts":[{"id":"<id>","text":"<text>","verdict":"supported|contradicted|uncertain","sources":[{"url":"<url>","title":"<title>","passage":"<passage>"}]}]}.',
      'Never invent sources or passages. Contradicted or missing evidence means contradicted or uncertain.',
      premise ? `Hypothetical premise (framing only; its real-world setup must still be true): ${String(premise).slice(0, 300)}
Also return "background":[{"text":"<real-world fact the premise relies on>","verdict":"supported|contradicted|uncertain","sources":[...]}].` : '',
      `Assertions: ${JSON.stringify(claims.map((c) => ({ id: c.id, text: c.text }))).slice(0, 3000)}`,
    ].join('\n');

    if (prompt.length > MAX_PROMPT_CHARS) {
      fail(`checker prompt exceeds ${MAX_PROMPT_CHARS} characters`);
    }

    const answer = await askRoleFn(FACTS_ROLE, prompt, { id: 'episode-facts', onCallRecord });
    const facts = Array.isArray(answer?.facts) ? answer.facts : [];
    const background = Array.isArray(answer?.background) ? answer.background : [];
    return { facts, background, evidence_source: 'antigravity_cli' };
  };
}

/**
 * Runs the Episode Fact Check stage.
 * Imports verifyStoryPlan and adds fiction labelling.
 * False claims block; fiction scenes pass with a label and never excuse a false fact.
 * facts.json lists which shots carry a label.
 */
export async function runFactsStage({
  episodeDir,
  episodesRoot = episodeRoot(),
  spec: passedSpec,
  brief: passedBrief,
  sources: passedSources,
  plan: passedPlan,
  topic: passedTopic,
  path: passedPath,
  askRoleFn = askRole,
  searchFn,
  throwOnBlock = true,
  onCallRecord,
  outDir,
  fictionShots,
  fictionLines,
  fictionScenes,
  illustrativeParts,
  illustrativeShots,
} = {}) {
  let folder = null;
  if (episodeDir) {
    folder = confineEpisodeDir(episodeDir, episodesRoot);
  } else if (outDir) {
    folder = confineOutDir(outDir, episodesRoot);
    fs.mkdirSync(folder, { recursive: true });
  }

  let spec = passedSpec;
  let brief = passedBrief;
  let sources = passedSources;
  let plan = passedPlan;

  if (folder && fs.existsSync(folder)) {
    if (!spec && fs.existsSync(path.join(folder, 'spec.json'))) {
      try { spec = JSON.parse(fs.readFileSync(path.join(folder, 'spec.json'), 'utf8')); } catch {}
    }
    if (!brief && fs.existsSync(path.join(folder, 'brief.json'))) {
      try { brief = JSON.parse(fs.readFileSync(path.join(folder, 'brief.json'), 'utf8')); } catch {}
    }
    if (!sources && fs.existsSync(path.join(folder, 'sources.json'))) {
      try { sources = JSON.parse(fs.readFileSync(path.join(folder, 'sources.json'), 'utf8')); } catch {}
    }
    if (!plan && fs.existsSync(path.join(folder, 'plan.json'))) {
      try { plan = JSON.parse(fs.readFileSync(path.join(folder, 'plan.json'), 'utf8')); } catch {}
    }
  }

  if (!spec || typeof spec !== 'object') {
    fail('spec is required for fact checking');
  }

  const topic = String(passedTopic || brief?.summary || plan?.goal || spec?.topic || '').trim();
  const episodePath = String(passedPath || spec?.path || 'breakdown').trim();

  const labelOptions = {
    fictionShots,
    fictionLines,
    fictionScenes,
    illustrativeParts,
    illustrativeShots,
  };

  // Cache key verification: label options change which claims are exempt, so they are part of the key.
  const cacheKey = sha256(JSON.stringify([
    FACTS_VERSION,
    topic,
    episodePath,
    spec,
    brief ?? null,
    sources ?? null,
    labelOptions,
  ]));

  if (folder) {
    const cacheFile = path.join(folder, '.facts-cache.json');
    const factsFile = path.join(folder, FACTS_FILE);
    if (fs.existsSync(cacheFile) && fs.existsSync(factsFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (cached?.key === cacheKey && cached.facts) {
          if (cached.facts.blocked && throwOnBlock) {
            const cachedReasons = Array.isArray(cached.facts.reasons) ? cached.facts.reasons : [];
            throw new FactCheckError(`fact check blocked: ${cachedReasons.length ? cachedReasons.join('; ') : 'Fact check blocked on false claim'}`, {
              falseClaims: cached.facts.false_claims || [],
              reasons: cachedReasons,
              facts: cached.facts,
            });
          }
          return { ok: cached.facts.verified, verified: cached.facts.verified, blocked: cached.facts.blocked, facts: cached.facts, cached: true };
        }
      } catch (err) {
        if (err instanceof FactCheckError) throw err;
      }
    }
  }

  const shotLabelsData = resolveShotLabels(spec, labelOptions);
  const rawLines = Array.isArray(spec?.lines) ? spec.lines : [];

  const scenes = [];
  const fictionScenesList = [];
  const falseClaims = [];
  const reasons = [];

  for (const line of rawLines) {
    const isFic = isFictionLine(line, spec, labelOptions);
    if (isFic) {
      fictionScenesList.push(line.id);
    }
    scenes.push({
      id: line.id,
      text: line.text,
      fiction: isFic,
      label: isFic ? 'fiction' : null,
      verdict: isFic ? 'fiction' : 'pending',
    });
  }

  const rawSearch = searchFn || buildDefaultSearch({ askRoleFn, topic, onCallRecord });
  const isWhatif = episodePath === 'whatif';

  // A what-if premise must be an explicit hypothetical question. It is never invented from a plain topic.
  const premiseCandidate = String(brief?.premise || (/^what if\b/i.test(topic) ? topic : '')).trim();
  const premiseText = /\?$/.test(premiseCandidate) || !premiseCandidate ? premiseCandidate : `${premiseCandidate}?`;
  const premiseFramed = /^What if\b[^?]+\?$/i.test(premiseText);
  const hypotheticalMissing = isWhatif && !premiseFramed;
  if (hypotheticalMissing) {
    reasons.push('What-if episode needs its premise framed as an explicit "What if ...?" question; real science claims are still checked.');
  }

  const sentencesOf = (text) => String(text ?? '').split(/(?<=[.!?])\s+/u).map((x) => x.trim()).filter(Boolean);

  // Factual lines keep their index in the factual list; verifyStoryPlan numbers scenes by that index.
  const factualEntries = [];
  rawLines.forEach((l, i) => {
    if (!isFictionLine(l, spec, labelOptions)) factualEntries.push({ line: l, claimId: `line:${l.id ?? i}` });
  });
  const factualLines = factualEntries.map((e) => e.line);

  const allClaimsToCheck = rawLines.map((l, i) => ({
    id: `line:${l.id ?? i}`,
    text: l.text,
    source: 'line',
    fiction: isFictionLine(l, spec, labelOptions),
  }));

  const evaluatedClaims = [];
  const evaluatedSources = [];
  let returnedFacts = [];
  let returnedBackground = [];
  const findFact = (claim) => returnedFacts.find((f) => f?.id === claim.id || f?.text === claim.text);

  if (allClaimsToCheck.length > 0) {
    try {
      const searchRes = await rawSearch({
        claims: allClaimsToCheck,
        topic,
        contentMode: isWhatif ? 'whatif' : 'factual',
        premise: premiseFramed ? premiseText : null,
      });
      returnedFacts = Array.isArray(searchRes?.facts) ? searchRes.facts : [];
      returnedBackground = Array.isArray(searchRes?.background) ? searchRes.background : [];

      for (const claim of allClaimsToCheck) {
        const match = findFact(claim);
        const verdict = match?.verdict || (claim.fiction ? 'fiction' : 'uncertain');
        const matchSources = Array.isArray(match?.sources) ? match.sources : [];

        const isContradicted = verdict === 'contradicted' || matchSources.some((s) => s?.verdict === 'contradicted');
        if (isContradicted) {
          falseClaims.push({
            id: claim.id,
            text: claim.text,
            verdict: 'contradicted',
            fiction: claim.fiction,
            sources: matchSources,
          });
          reasons.push(`False claim contradicted by source evidence: "${claim.text}"`);
        }

        evaluatedClaims.push({
          id: claim.id,
          text: claim.text,
          verdict: isContradicted ? 'contradicted' : (claim.fiction ? 'fiction' : verdict),
          sources: matchSources,
          fiction: claim.fiction,
        });

        if (matchSources.length > 0) evaluatedSources.push(...matchSources);
      }
    } catch (err) {
      reasons.push(`Search query error: ${err.message}`);
    }
  }

  const uncertainClaims = [];

  // Run verifyStoryPlan on the factual plan to ensure rigorous verification
  if (factualLines.length > 0) {
    const factualStoryPlan = {
      title: topic || 'Episode topic',
      contentMode: isWhatif ? 'whatif' : 'factual',
      premise: premiseFramed ? premiseText : undefined,
      scenes: factualLines.map((l, i) => ({
        id: l.id || `scene-${i}`,
        text: l.text,
      })),
    };

    // Reuse the already fetched facts. Every sentence of a line inherits that line's verdict and sources.
    const cachedSearchAdapter = async () => {
      const facts = [];
      factualEntries.forEach((entry, k) => {
        const match = findFact({ id: entry.claimId, text: entry.line.text });
        if (!match) return;
        sentencesOf(entry.line.text).forEach((sentence, j) => {
          facts.push({ ...match, id: `scene:${k}.text:${j}`, text: sentence });
        });
      });
      return { facts, background: returnedBackground, sources: evaluatedSources, evidence_source: 'antigravity_cli' };
    };

    try {
      const vResult = await verifyStoryPlan(factualStoryPlan, {
        topic,
        contentMode: factualStoryPlan.contentMode,
        search: cachedSearchAdapter,
      });

      if (vResult?.status !== 'verified') {
        const vReasons = Array.isArray(vResult?.reasons) ? vResult.reasons : ['Factual verification failed'];
        for (const vr of vReasons) {
          if (!reasons.includes(vr)) reasons.push(vr);
        }
        for (const c of vResult?.claims || []) {
          if (c.verdict === 'supported') continue;
          if (c.verdict === 'contradicted') {
            if (!falseClaims.some((fc) => fc.text === c.text)) falseClaims.push(c);
          } else if (!uncertainClaims.some((uc) => uc.id === c.id)) {
            // Uncertain is not proven false: it blocks, but is reported apart from false claims.
            uncertainClaims.push(c);
          }
        }
      }
      if (Array.isArray(vResult?.sources)) {
        evaluatedSources.push(...vResult.sources);
      }
    } catch (err) {
      reasons.push(`verifyStoryPlan error: ${err.message}`);
    }
  }

  const hasFiction = shotLabelsData.fictionShots.length > 0 || fictionScenesList.length > 0;
  const hasIllustrative = shotLabelsData.illustrativeShots.length > 0;
  const blocked = falseClaims.length > 0 || hypotheticalMissing || (factualLines.length > 0 && reasons.length > 0);
  const verified = !blocked;

  // Build facts.json artifact payload
  const factsPayload = {
    facts_version: 1,
    verified,
    blocked,
    status: verified ? 'verified' : 'blocked',
    has_fiction: hasFiction,
    fiction: hasFiction,
    has_illustrative: hasIllustrative,
    illustrative: hasIllustrative,
    shots: shotLabelsData.shots,
    labeled_shots: shotLabelsData.labeledShots,
    labels: shotLabelsData.labels,
    fiction_shots: shotLabelsData.fictionShots,
    illustrative_shots: shotLabelsData.illustrativeShots,
    fiction_scenes: fictionScenesList,
    scenes,
    claims: evaluatedClaims,
    sources: [...new Map(evaluatedSources.filter((s) => s?.url).map((s) => [s.url, s])).values()],
    false_claims: falseClaims,
    uncertain_claims: uncertainClaims,
    reasons,
    checkedAt: new Date().toISOString(),
  };

  // Write facts.json atomically if folder is present, so the report survives even on failure
  if (folder) {
    atomicWrite(folder, FACTS_FILE, factsPayload);
    atomicWrite(folder, '.facts-cache.json', { key: cacheKey, facts: factsPayload });
  }

  if (blocked && throwOnBlock) {
    const errorMsg = reasons.length ? reasons.join('; ') : 'Fact check blocked on false claim';
    throw new FactCheckError(`fact check blocked: ${errorMsg}`, {
      falseClaims,
      reasons,
      facts: factsPayload,
    });
  }

  return {
    ok: verified,
    verified,
    blocked,
    facts: factsPayload,
    cached: false,
  };
}

export function createFactsEngine(options = {}) {
  return Object.assign(async ({ episode, inputs }) => {
    const spec = inputs?.['spec.json'];
    const brief = inputs?.['brief.json'];
    const sources = inputs?.['sources.json'];
    const plan = inputs?.['plan.json'];
    const result = await runFactsStage({
      topic: episode?.topic,
      path: episode?.path,
      spec,
      brief,
      sources,
      plan,
      throwOnBlock: true,
      ...options,
    });
    return { [FACTS_FILE]: result.facts };
  }, { version: FACTS_VERSION });
}
