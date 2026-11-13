// The review gate every publication path calls before a draft may leave ForgeAI (direct publish, scheduled upload,
// future-upload enablement) and the review status the Library shows.
//
// Code-built drafts are Episode drafts: their receipt and gate live in episodeReview.js, and this file only dispatches
// to it. The older "semantic explainer" drafts (a 3D-model explanation path that stayed in the ForgeAi archive) cannot
// be reviewed here, so a draft that carries that marker is always refused, never published unreviewed.
import { isEpisodeDraft, episodeGate, episodeReviewOf } from './episodeReview.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isOldSemantic = ({ meta } = {}) => isObj(meta) && (meta.semantic_explainer_v1 === true || meta.semantic != null);
const UNSUPPORTED = Object.freeze({
  semantic: true, status: 'needs_review', ready: false, links: null,
  blockers: [{ code: 'unsupported_draft', message: 'this draft comes from the archived semantic-explainer path and cannot be reviewed or published from this project' }],
});

/** A draft that needs a review receipt before it may be published. */
export function isSemanticDraft(draft = {}) {
  return isEpisodeDraft(draft) || isOldSemantic(draft);
}

/** What the Library shows for such a draft; never throws. */
export async function semanticReviewOf(draft) {
  if (isEpisodeDraft(draft)) return episodeReviewOf(draft);
  return UNSUPPORTED;
}

/** The one call every publication consumer makes. null = publish may proceed; otherwise the refusal body. */
export async function semanticGate(draft) {
  if (isEpisodeDraft(draft)) return episodeGate(draft);
  if (!isOldSemantic(draft)) return null;
  return { error: UNSUPPORTED.blockers[0].message, semantic_review: UNSUPPORTED };
}

/** A list of drafts -> their DTOs with semantic_review added where a review applies. A plain array when none does. */
export function withSemanticReview(drafts, toItem) {
  if (!drafts.some(isSemanticDraft)) return drafts.map(toItem);
  return Promise.all(drafts.map(async (d) => (isSemanticDraft(d) ? { ...toItem(d), semantic_review: await semanticReviewOf(d) } : toItem(d))));
}
