// KAN-928 (CB16): the fact-check step between the script and the voice for owner-started batch videos.
//
// This is the real Episode fact check (episode/facts.js runFactsStage -> verifyStoryPlan) run over the sentences of the written script. Evidence comes from
// retrievalAdapter.js: the existing CLI retrieval (agy search_web), then an independent validation of every cited source (the page is fetched here and must
// contain the claim), with nothing the model reports trusted by itself. The old route through askRole checked claims with search disabled, which made a
// "supported" verdict the model's own attestation; it is gone.
// Fail closed: when no retrieval can run, the stage throws retrieval_unavailable (start.js: job failed, named, before voice and build). A claim the sources
// contradict, or that no validated source supports, blocks the video (fact_check_blocked). Nothing is simulated and no URL is ever invented.
// The stage is injectable so tests run with no CLI or network; the production default refuses to retrieve under `node --test`.
import { runFactsStage } from '../facts.js';
import { createBatchRetrieval } from './retrievalAdapter.js';

export const FACT_CHECK_STEP = 'fact_check';
export const MAX_LINES = 60;
const CLAIMS_PROMPT_BUDGET = 2900; // facts.js cuts the claims JSON at 3000 characters; stay under it so the model never sees broken JSON

const sentencesOf = (script) => String(script ?? '').split(/(?<=[.!?])\s+/u).map((x) => x.trim()).filter(Boolean);

/** Script -> [{ id, text }] lines for the checker. Sentences are merged only as far as needed to keep the claims prompt whole. */
export function scriptToLines(script) {
  const sentences = sentencesOf(script);
  for (let group = 1; group <= 12; group += 1) {
    const lines = [];
    for (let i = 0; i < sentences.length; i += group) lines.push({ id: `l${lines.length + 1}`, text: sentences.slice(i, i + group).join(' ') });
    if (lines.length <= MAX_LINES && JSON.stringify(lines.map((l) => ({ id: `line:${l.id}`, text: l.text }))).length <= CLAIMS_PROMPT_BUDGET) return lines;
  }
  throw new Error('script is too long to fact check');
}

export function createFactCheckStage({ runFacts = runFactsStage, searchFn = createBatchRetrieval() } = {}) {
  /** -> { verified, summary: { false_claims, uncertain_claims, other_reasons, claims }, facts }  (throws when the check itself cannot run; code retrieval_unavailable when there is no retrieval) */
  return async function factCheckStage({ topic, script, contentMode = 'factual', onCallRecord } = {}) {
    const lines = scriptToLines(script);
    if (!lines.length) throw new Error('script has nothing to check');
    // runFactsStage files a search that throws as a "search query error" reason, which reads like a blocked script. No retrieval at all is a different result
    // (retrieval_unavailable): no verdict was reached, so it must not be filed as a fact problem, and it can never pass.
    let unavailable = null;
    const started = Date.now();
    const retrieval = async (request) => {
      try { return await searchFn(request); } catch (error) {
        if (error?.code === 'retrieval_unavailable') unavailable = error;
        throw error;
      } finally {
        onCallRecord?.({ role: 'checker', provider: 'agy', model: 'search_web', step: FACT_CHECK_STEP, wall_s: (Date.now() - started) / 1000, status: unavailable ? 'error' : 'ok' });
      }
    };
    const result = await runFacts({ spec: { path: contentMode === 'whatif' ? 'whatif' : 'breakdown', lines }, topic: String(topic ?? ''), searchFn: retrieval, throwOnBlock: false, onCallRecord });
    if (unavailable) throw unavailable;
    const facts = result?.facts ?? {};
    const falseClaims = Array.isArray(facts.false_claims) ? facts.false_claims.length : 0;
    const uncertain = Array.isArray(facts.uncertain_claims) ? facts.uncertain_claims.length : 0;
    const reasons = Array.isArray(facts.reasons) ? facts.reasons.length : 0;
    // The topic line is sent along as a "title" claim, but the search is asked only about the script's sentences, so that claim always came back
    // uncertain and blocked every video whose topic holds a number (2026-11-14, job mwgkw47j-14a6e1: all 8 sentences supported, video blocked).
    // The topic is not spoken or shown; when every sentence is supported and nothing is contradicted, an unanswered title claim does not block.
    const lineClaims = Array.isArray(facts.claims) ? facts.claims : [];
    const titleOnly = result?.verified !== true && falseClaims === 0 && lineClaims.length > 0 && lineClaims.every((x) => x?.verdict === 'supported')
      && Array.isArray(facts.uncertain_claims) && facts.uncertain_claims.length > 0 && facts.uncertain_claims.every((x) => x?.source === 'title')
      && (facts.reasons ?? []).every((r) => /^title:/.test(String(r)));
    if (titleOnly) { facts.title_unchecked = true; facts.status = 'verified'; facts.verified = true; facts.blocked = false; }
    return {
      verified: titleOnly || (result?.verified === true && result?.blocked !== true),
      summary: { search_only_claims: (Array.isArray(facts.claims) ? facts.claims : []).filter((x) => x?.verdict === 'supported' && Array.isArray(x.sources) && x.sources.length && x.sources.every((src) => src?.validated === 'search_only')).length, false_claims: falseClaims, uncertain_claims: uncertain, other_reasons: Math.max(0, reasons - falseClaims - uncertain), claims: Array.isArray(facts.claims) ? facts.claims.length : lines.length },
      facts,
    };
  };
}

/** The stage the starter uses when none is injected. */
export const defaultFactCheckStage = createFactCheckStage();
