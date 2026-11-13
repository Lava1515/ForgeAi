import React, { useEffect, useId, useState } from 'react';
import { Youtube, ExternalLink, RefreshCw, Sparkles } from 'lucide-react';
import * as api from '../services/api.js';
import { formatTags } from '../utils/format.js';

const PRIVACY = [
  { id: 'public', label: 'Public' },
  { id: 'unlisted', label: 'Unlisted' },
  { id: 'private', label: 'Private' },
];

// "#a, b c" -> ['a', 'b', 'c']; the server cleans and caps them (15 tags, 500 chars).
const parseTags = (text) => text.split(/[\s,]+/).map((t) => t.replace(/^#+/, '')).filter(Boolean);

// Publish a finished video draft to the connected YouTube channel (as a Short).
export default function PublishYouTube({ product, onPublished }) {
  const tagsId = useId();
  const [status, setStatus] = useState(null);
  const [privacy, setPrivacy] = useState('public');
  const [madeForKids, setMadeForKids] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [published, setPublished] = useState(product.youtube);
  const [tags, setTags] = useState(formatTags(product.tags));
  const [suggesting, setSuggesting] = useState(false);

  useEffect(() => {
    api.getYoutubeStatus().then(setStatus).catch((err) => setError(err.message));
  }, []);

  const publish = async () => {
    setBusy(true);
    setError('');
    try {
      setPublished(await api.publishToYoutube(product.folder_name || product.id, { privacy, madeForKids, tags: parseTags(tags) }));
      onPublished?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const suggest = async () => {
    setSuggesting(true);
    setError('');
    try {
      setTags(formatTags((await api.suggestYoutubeTags(product.folder_name || product.id)).tags));
    } catch (err) {
      setError(err.message);
    } finally {
      setSuggesting(false);
    }
  };

  return (
    <div data-cy="publish-youtube" className="p-4 rounded-xl border border-ink-800 bg-ink-950/60 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink-200 flex items-center gap-1.5">
          <Youtube className="w-4 h-4 text-red-500" /> Publish to YouTube
        </span>
        {status?.connected && <span className="text-xs font-mono text-ink-400">{status.channel || 'channel connected'}</span>}
      </div>

      {published ? (
        <a href={published.url} target="_blank" rel="noreferrer" className="text-sm text-ember-400 hover:underline inline-flex items-center gap-1.5 min-h-[36px] py-1">
          Published ({published.privacy}) <ExternalLink className="w-3.5 h-3.5" />
        </a>
      ) : !status && error ? (
        <p className="text-xs text-ink-400">Couldn't check the YouTube connection. Reopen this page to try again.</p>
      ) : !status ? (
        <p className="text-xs text-ink-400 flex items-center gap-2 py-1">
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-ink-500" />
          Checking connection...
        </p>
      ) : !status.configured ? (
        <p className="text-xs text-ink-400">Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET to .env and restart the dashboard.</p>
      ) : !status.connected ? (
        <a href={api.youtubeConnectUrl} className="btn-ember inline-flex items-center gap-2 px-4 py-2 min-h-[36px] rounded-lg text-sm font-medium">
          <Youtube className="w-4 h-4" /> Connect YouTube
        </a>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2" role="radiogroup" aria-label="Visibility">
            {PRIVACY.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={privacy === p.id}
                disabled={busy}
                onClick={() => setPrivacy(p.id)}
                className={`chip min-h-[32px] h-8 text-xs ${privacy === p.id ? 'chip-active' : ''}`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={tagsId} className="text-xs font-medium text-ink-300">Tags</label>
              <button
                type="button"
                onClick={suggest}
                disabled={busy || suggesting}
                aria-label="Suggest tags"
                className="h-8 min-h-[32px] px-3 rounded-lg text-xs font-medium text-ember-400 hover:text-ember-300 hover:bg-ember-500/10 border border-ember-500/30 transition-colors inline-flex items-center gap-1.5 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-ember-500/40"
              >
                {suggesting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                <span>{suggesting ? 'Suggesting...' : 'Suggest tags'}</span>
              </button>
            </div>
            <textarea
              id={tagsId}
              rows={2}
              value={tags}
              disabled={busy}
              onChange={(e) => setTags(e.target.value)}
              className="w-full bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 text-xs font-mono text-ink-200 focus:outline-none focus:border-ember-500/60 focus:ring-1 focus:ring-ember-500/30"
            />
            <p className="text-xs text-ink-400">Sent as tags and as hashtags in the description; #shorts is always added. Max 15.</p>
          </div>

          <label className="flex items-center gap-3 p-2.5 rounded-lg border border-transparent hover:border-ink-800 hover:bg-ink-900/60 transition-colors cursor-pointer text-xs text-ink-200 select-none">
            <input
              type="checkbox"
              checked={madeForKids}
              disabled={busy}
              onChange={(e) => setMadeForKids(e.target.checked)}
              className="w-6 h-6 min-w-[24px] min-h-[24px] rounded border-ink-700 bg-ink-950 text-ember-500 accent-ember-500 cursor-pointer shrink-0 focus:ring-2 focus:ring-ember-500/40 focus:ring-offset-0"
            />
            <span className="leading-tight">Made for kids (required by YouTube; answer honestly)</span>
          </label>

          <button
            type="button"
            onClick={publish}
            disabled={busy}
            className="btn-ember inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[36px] rounded-lg text-sm font-medium transition"
          >
            {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Youtube className="w-4 h-4" />}
            <span>{busy ? 'Uploading...' : 'Publish'}</span>
          </button>
        </div>
      )}

      {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
    </div>
  );
}
