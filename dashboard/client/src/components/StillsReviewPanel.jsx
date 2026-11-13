import React, { useEffect, useState } from 'react';
import { Check, RefreshCw, Play, Image as ImageIcon } from 'lucide-react';
import * as api from '../services/api.js';
import Button from '../ui/Button.jsx';
import Badge from '../ui/Badge.jsx';
import Banner from '../ui/Banner.jsx';
import { formatStillMeta, getStillImageUrl } from './stillsReviewMeta.js';

export default function StillsReviewPanel({ runId, onAnimated }) {
  const [review, setReview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [editingPrompts, setEditingPrompts] = useState({});

  const load = async () => {
    if (!runId) return;
    try {
      setLoading(true);
      const data = await api.getStillsReview(runId);
      setReview(data);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [runId]);

  if (!runId) return null;
  if (!loading && !review) {
    return error ? <Banner tone="error" action={<Button size="sm" variant="ghost" onClick={load}>Retry</Button>}>{`Couldn't load the still review: ${error}`}</Banner> : null;
  }

  const handleApprove = async (sceneNumber) => {
    setActionLoading(true);
    try {
      await api.approveStill(runId, sceneNumber);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRegenerate = async (sceneNumber) => {
    setActionLoading(true);
    try {
      const prompt = editingPrompts[sceneNumber];
      await api.regenerateStill(runId, sceneNumber, { prompt });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleAnimate = async () => {
    setActionLoading(true);
    try {
      const res = await api.animateApprovedScenes(runId);
      onAnimated?.(res);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const scenes = review?.scenes || [];
  const approvedCount = scenes.filter((s) => s.approved).length;

  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900/90 p-5 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-ink-800/80 pb-3">
        <div>
          <h3 className="text-sm font-semibold text-ink-100 flex items-center gap-2">
            <ImageIcon className="w-4 h-4 text-ember-400" />
            Still Review: Pause Before Motion
          </h3>
          <p className="text-xs text-ink-400 mt-0.5">
            Approve or regenerate scene stills before generating Wan animation clips.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={scenes.length > 0 && approvedCount === scenes.length ? "success" : "accent"}>
            {approvedCount}/{scenes.length} approved
          </Badge>
          <Button
            size="sm"
            variant="primary"
            icon={Play}
            disabled={actionLoading || approvedCount === 0}
            loading={actionLoading}
            onClick={handleAnimate}
          >
            Animate approved ({approvedCount})
          </Button>
        </div>
      </div>

      {error && <Banner tone="error" onDismiss={() => setError('')}>{error}</Banner>}

      {scenes.length === 0 && <p className="text-xs text-ink-400">No scene stills yet.</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {scenes.map((s) => (
          <div key={s.id || s.scene_number} className="rounded-lg border border-ink-800 bg-ink-950 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-medium text-ink-300">Scene #{s.id || s.scene_number}</span>
              <Badge tone={s.approved ? "success" : "neutral"}>
                {s.approved ? "Approved" : "Needs Review"}
              </Badge>
            </div>
            {s.still_url && (
              <img
                src={getStillImageUrl(s.still_url, s.input_revision)}
                alt={`Scene ${s.id || s.scene_number}`}
                className="w-full aspect-[9/16] max-h-48 object-cover rounded bg-ink-900 border border-ink-800"
                onError={(e) => { e.target.style.display = 'none'; }}
              />
            )}
            {formatStillMeta(s) && (
              <div className="text-[11px] font-mono text-ink-400 truncate" title={formatStillMeta(s)}>
                {formatStillMeta(s)}
              </div>
            )}
            <textarea
              rows={2}
              className="w-full bg-ink-900 border border-ink-800 rounded p-1.5 text-xs text-ink-200 focus:outline-none focus:border-ember-500/60 resize-none font-mono"
              value={editingPrompts[s.id || s.scene_number] ?? s.still_prompt ?? ''}
              onChange={(e) => setEditingPrompts((prev) => ({ ...prev, [s.id || s.scene_number]: e.target.value }))}
              aria-label={`Still prompt for scene ${s.id || s.scene_number}`}
              placeholder="Still prompt..."
            />
            <div className="flex items-center justify-between gap-2 pt-1">
              <Button
                size="xs"
                variant="ghost"
                icon={RefreshCw}
                disabled={actionLoading}
                onClick={() => handleRegenerate(s.id || s.scene_number)}
              >
                Regenerate
              </Button>
              <Button
                size="xs"
                variant={s.approved ? "ghost" : "secondary"}
                icon={Check}
                disabled={actionLoading || s.approved}
                onClick={() => handleApprove(s.id || s.scene_number)}
              >
                {s.approved ? "Approved" : "Approve"}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
