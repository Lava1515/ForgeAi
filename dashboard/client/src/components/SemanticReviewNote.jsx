import React from 'react';

// KAN-778: the review status the server computes for a semantic explainer draft (preview-only / needs_review / ready), with its blockers and source links.
// The server refuses every upload path on its own; this only shows why. Ordinary drafts have no semantic_review and render nothing.
export const semanticNotReady = (review) => Boolean(review) && review.ready !== true;

const TONE = { 'preview-only': 'text-amber-300', needs_review: 'text-rose-300', ready: 'text-emerald-300' };
const LINKS = [['source', 'source model'], ['scene_blend', 'scene .blend'], ['inventory', 'inventory'], ['evidence', 'evidence'], ['qa', 'QA']];

export default function SemanticReviewNote({ review }) {
  if (!review) return null;
  const blockers = Array.isArray(review.blockers) ? review.blockers : [];
  const links = review.links || {};
  const shown = LINKS.map(([key, label]) => [label, links[key]?.path ?? links[key]]).filter(([, v]) => typeof v === 'string' && v);
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-950/60 p-3 text-xs" data-testid="semantic-review">
      <p className={`font-mono font-semibold ${TONE[review.status] || 'text-ink-300'}`}>Semantic explainer: {review.status}</p>
      {blockers.length > 0 && (
        <ul className="mt-1 list-disc pl-4 text-ink-300">
          {blockers.map((b) => <li key={b.code}>{b.message}</li>)}
        </ul>
      )}
      <p className="mt-1 break-all font-mono text-ink-400">
        {links.preview?.video_url && <a className="mr-3 underline" href={links.preview.video_url}>preview</a>}
        {shown.map(([label, value]) => <span key={label} className="mr-3">{label}: {value}</span>)}
      </p>
    </div>
  );
}
