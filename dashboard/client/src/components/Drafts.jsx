import React, { useEffect, useState } from 'react';
import { Inbox, RefreshCw } from 'lucide-react';
import * as api from '../services/api.js';
import PublishYouTube from './PublishYouTube.jsx';
import StillsReviewPanel from './StillsReviewPanel.jsx';
import PageHeader from '../ui/PageHeader.jsx';
import Button from '../ui/Button.jsx';
import Badge from '../ui/Badge.jsx';
import EmptyState from '../ui/EmptyState.jsx';
import Banner from '../ui/Banner.jsx';
import CreationCost from './CreationCost.jsx';

const RENDERER_LABELS = { wan: 'Wan 2.2 5B', wan14b: 'Wan 2.2 14B', minimax_h3: 'MiniMax H3', blender: 'Blender', ai_image: 'AI image', comfyui_video: 'ComfyUI video' };
const label = (name) => RENDERER_LABELS[name] || name;
// "Requested Blender ×6 · Rendered: Blender ×4, AI image ×2 · 2 fell back · 0 unverified" from the per-scene provenance saved with the draft.
const counts = (map) => Object.entries(map || {}).map(([name, n]) => `${label(name)} ×${n}`).join(', ') || 'none';
const renderedSummary = ({ requested, actual, fallbacks, unverified }) => `Requested ${counts(requested)} · Rendered: ${counts(actual)}${fallbacks ? ` · ${fallbacks} fell back` : ''}${unverified ? ` · ${unverified} unverified` : ''}`;

// Videos that hit YouTube's daily upload limit. Publishing one removes it from this list.
export default function Drafts() {
  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState([]);
  const [removingId, setRemovingId] = useState('');

  const load = () => {
    setLoading(true);
    Promise.all([api.getYoutubeDrafts(), api.getPendingStillReviews()])
      .then(([d, p]) => { setDrafts(Array.isArray(d) ? d : []); setPending(Array.isArray(p) ? p : []); setError(''); })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  // Clears the Drafts flag only; the video stays in the Library. Row stays if the call fails.
  const removeFromDrafts = (item) => {
    setRemovingId(item.id);
    api.updateProduct(item.id, { future_upload: false })
      .then(() => load())
      .catch((err) => setError(err.message))
      .finally(() => setRemovingId(''));
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Waiting on YouTube"
        title="Drafts"
        badge={drafts.length > 0 ? <Badge tone="accent">{drafts.length} waiting</Badge> : (loading ? <Badge tone="neutral">Loading...</Badge> : null)}
        subtitle="Videos that hit YouTube's daily upload limit. Publishing one removes it from this list."
        actions={<Button variant="ghost" size="sm" icon={RefreshCw} loading={loading} onClick={load} className="min-h-[36px] h-9">Refresh</Button>}
      />

      {error && <Banner tone="error" onDismiss={() => setError('')}>{error}</Banner>}

      {pending.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-ink-100">Awaiting still review ({pending.length})</h2>
          {pending.map((item) => (
            <div key={item.id} className="space-y-2">
              <p className="text-xs text-ink-400 font-mono">{item.title} · {item.approved}/{item.scenes} approved</p>
              <StillsReviewPanel runId={item.id} onAnimated={load} />
            </div>
          ))}
        </section>
      )}

      {drafts.length === 0 ? (
        !loading && !error && pending.length === 0 && <EmptyState icon={Inbox} title="No drafts">Nothing waiting. Videos land here when YouTube's upload limit is reached, or when you mark one for later in the Library.</EmptyState>
      ) : (
        <ul className="space-y-4">
          {drafts.map((item) => (
            <li key={item.id} className="flex flex-col sm:flex-row gap-4 sm:gap-5 rounded-xl border border-ink-800 bg-ink-900 p-4 hover:border-ink-700 transition-colors">
              <video src={item.video_url} controls playsInline preload="metadata" className="w-full sm:w-28 max-w-[140px] aspect-[9/16] object-cover rounded-lg bg-ink-950 shrink-0 mx-auto sm:mx-0" />
              <div className="min-w-0 flex-1 space-y-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-ink-100 line-clamp-2">{item.title}</p>
                  <div className="flex items-center gap-2 text-xs text-ink-400 font-mono">
                    {item.engine && <span>{item.engine}</span>}
                    {item.style === 'viral_v1' && (
                      <Badge tone="accent" className="!text-xs !py-0.5 !px-1.5">viral_v1</Badge>
                    )}
                  </div>
                  {item.provenance && <p className="text-xs text-ink-400 font-mono" title={item.provenance.fallback_reasons?.join('; ')}>{renderedSummary(item.provenance)}</p>}
                  <CreationCost cost={item.cost} />
                </div>
                <PublishYouTube product={{ id: item.id, tags: item.tags }} onPublished={load} />
                <div className="space-y-1">
                  <Button variant="ghost" size="sm" loading={removingId === item.id} disabled={removingId !== ''} onClick={() => removeFromDrafts(item)}>Remove from Drafts</Button>
                  <p className="text-xs text-ink-400">Stays in your Library.</p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
