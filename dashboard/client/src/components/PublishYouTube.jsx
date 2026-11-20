import React, { useEffect, useId, useState } from 'react';
import { Youtube, ExternalLink, RefreshCw, Sparkles, AlertTriangle, Send } from 'lucide-react';
import * as api from '../services/api.js';
import { formatTags } from '../utils/format.js';

const PRIVACY = [
  { id: 'public', label: 'Public' },
  { id: 'unlisted', label: 'Unlisted' },
  { id: 'private', label: 'Private' },
];

// "#a, b c" -> ['a', 'b', 'c']; the server cleans and caps them (15 tags, 500 chars).
const parseTags = (text) => text.split(/[\s,]+/).map((t) => t.replace(/^#+/, '')).filter(Boolean);

// A schedule that is still waiting: YouTube's own (private + publishAt) or an older local one (unlisted + publish_at).
const isScheduled = (y) => Boolean(y?.publish_at) && (y.privacy === 'private' || y.privacy === 'unlisted');
const whenText = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
// The separate uploader's words for a sent video.
const UPLOADER_STATE = { sent: 'waiting for the uploader to take it', queued: 'in the uploader queue, waiting for its slot', uploading: 'being handed to YouTube', failed: 'failed in the uploader; open the uploader page', cancelled: 'schedule cancelled in the uploader', gone: 'no longer on YouTube' };
const canSendAgain = (sent) => !sent || sent.state === 'refused' || sent.state === 'removed';

// Publish a finished video draft to the connected YouTube channel (as a Short).
export default function PublishYouTube({ product, onPublished }) {
  const tagsId = useId();
  const titleId = useId();
  const whenId = useId();
  const [status, setStatus] = useState(null);
  const [privacy, setPrivacy] = useState('public');
  const [madeForKids, setMadeForKids] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [published, setPublished] = useState(product.youtube);
  const [when, setWhen] = useState(''); // datetime-local value, empty = publish now
  const [title, setTitle] = useState(product.title || '');
  const [tags, setTags] = useState(formatTags(product.tags));
  const [suggesting, setSuggesting] = useState(false);
  const [overLimit, setOverLimit] = useState(null); // { max, day, message } when the channel's daily limit is reached
  const [uploader, setUploader] = useState(null); // { share_ok, channel, sent, youtube } from the separate uploader's folder
  const [sending, setSending] = useState(false);
  const draftKey = product.folder_name || product.id;

  useEffect(() => {
    api.getYoutubeStatus().then(setStatus).catch((err) => setError(err.message));
  }, []);

  // The uploader answers through its results folder; ask again every 30 s while a sent video is still on its way.
  useEffect(() => {
    let live = true;
    const read = () => api.getUploaderStatus(draftKey).then((u) => { if (!live) return; setUploader(u); if (u.youtube?.video_id) setPublished(u.youtube); }).catch(() => {});
    read();
    const timer = setInterval(read, 30000);
    return () => { live = false; clearInterval(timer); };
  }, [draftKey]);

  const sendToUploader = async () => {
    setSending(true);
    setError('');
    try {
      const sentNow = await api.sendToUploader(draftKey, { title: title.trim(), tags: parseTags(tags) });
      setUploader((u) => ({ ...u, ...sentNow }));
      onPublished?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  // The channel's daily limit is a warning: the server answers code 'daily_limit' and the owner may confirm to go over it.
  const publish = async (confirmOverLimit = false) => {
    setBusy(true);
    setError('');
    setOverLimit(null);
    try {
      setPublished(await api.publishToYoutube(product.folder_name || product.id, { privacy, madeForKids, tags: parseTags(tags), title: title.trim(), publishAt: when ? new Date(when).toISOString() : undefined, overLimit: confirmOverLimit || undefined }));
      onPublished?.();
    } catch (err) {
      if (err.data?.code === 'daily_limit') setOverLimit({ max: err.data.max, day: err.data.day, message: err.message });
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const cancelSchedule = async () => {
    setBusy(true);
    setError('');
    try {
      setPublished(await api.cancelYoutubeSchedule(product.folder_name || product.id));
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

      {published && isScheduled(published) ? (
        <div className="space-y-2">
          <a href={published.url} target="_blank" rel="noreferrer" className="text-sm text-ember-400 hover:underline inline-flex items-center gap-1.5 min-h-[36px] py-1">
            {new Date(published.publish_at).getTime() > Date.now() ? `Scheduled for ${whenText(published.publish_at)}` : `Scheduled time passed (${whenText(published.publish_at)}); waiting for YouTube`} <ExternalLink className="w-3.5 h-3.5" />
          </a>
          {published.publish_mode === 'uploader' ? (
            <p className="text-xs text-ink-400">Handed to YouTube by the uploader. To stop it, press Cancel on the uploader page.</p>
          ) : (
            <div>
              <button type="button" onClick={cancelSchedule} disabled={busy} className="chip min-h-[32px] h-8 text-xs disabled:opacity-50">
                {busy ? 'Cancelling...' : 'Cancel schedule'}
              </button>
              <span className="ml-2 text-xs text-ink-400">The video stays {published.privacy} on YouTube.</span>
            </div>
          )}
        </div>
      ) : published ? (
        <a href={published.url} target="_blank" rel="noreferrer" className="text-sm text-ember-400 hover:underline inline-flex items-center gap-1.5 min-h-[36px] py-1">
          {published.privacy === 'public' ? 'Published' : `Uploaded (${published.privacy})`} <ExternalLink className="w-3.5 h-3.5" />
        </a>
      ) : uploader?.sent && !canSendAgain(uploader.sent) ? (
        <div data-cy="uploader-sent" className="space-y-1">
          <p className="text-sm text-ink-100 flex items-center gap-1.5"><Send className="w-4 h-4 text-ember-400" /> Sent to the uploader{uploader.channel?.name ? ` for ${uploader.channel.name}` : ''}</p>
          <p className="text-xs text-ink-400">{UPLOADER_STATE[uploader.sent.state] || uploader.sent.state}{uploader.sent.reason ? `: ${uploader.sent.reason}` : ''}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor={titleId} className="text-xs font-medium text-ink-300">Title</label>
            <input
              id={titleId}
              type="text"
              maxLength={100}
              value={title}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 text-xs text-ink-200 focus:outline-none focus:border-ember-500/60 focus:ring-1 focus:ring-ember-500/30"
            />
            <p className="text-xs text-ink-400">Up to 100 characters. It must describe the video; a date or digits alone is refused.</p>
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
            <p className="text-xs text-ink-400">Sent as tags; the first 5 also become the hashtags in the description. Max 15.</p>
          </div>


          <div data-cy="send-to-uploader" className="space-y-1.5 rounded-lg border border-ink-800 p-3">
            <button
              type="button"
              onClick={sendToUploader}
              disabled={sending || busy || !uploader?.share_ok || !uploader?.channel?.youtube_channel_id}
              className="btn-ember inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[36px] rounded-lg text-sm font-medium transition disabled:opacity-50"
            >
              {sending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              <span>{sending ? 'Sending...' : 'Send to uploader'}</span>
            </button>
            <p className="text-xs text-ink-400">
              {!uploader ? 'Checking the uploader folder...'
                : !uploader.share_ok ? 'The uploader folder is not reachable, so nothing can be sent.'
                : !uploader.channel?.youtube_channel_id ? `Add the YouTube Channel ID to the channel "${uploader.channel?.name || 'of this draft'}" (channel settings, YouTube tab) before sending.`
                : `Goes to ${uploader.channel.name}. The uploader publishes it at that channel's next free slot.`}
            </p>
            {uploader?.sent?.state === 'refused' && <p className="text-xs text-rose-300">The uploader refused it: {uploader.sent.reason}. Fix it and send again.</p>}
            {uploader?.sent?.state === 'removed' && <p className="text-xs text-ink-400">It was removed from the uploader queue. You can send it again.</p>}
          </div>

          <details className="rounded-lg border border-ink-800 p-3">
            <summary className="cursor-pointer text-xs font-medium text-ink-300">Publish directly from ForgeAi instead</summary>
            <div className="mt-3 space-y-3">
              {!status && error ? (
                <p className="text-xs text-ink-400">Couldn't check the YouTube connection. Reopen this page to try again.</p>
              ) : !status ? (
                <p className="text-xs text-ink-400 flex items-center gap-2 py-1">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-ink-500" />
                  Checking connection...
                </p>
              ) : !status.configured ? (
                <p className="text-xs text-ink-400">Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET to .env and restart the dashboard.</p>
              ) : !status.connected ? (
                <a href={api.youtubeConnectUrl} className="chip inline-flex items-center gap-2 min-h-[32px] h-8 text-xs">
                  <Youtube className="w-4 h-4" /> Connect YouTube
                </a>
              ) : (
                <>
                <div className="flex items-center gap-2" role="radiogroup" aria-label="Visibility">
                  {PRIVACY.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      role="radio"
                      aria-checked={privacy === p.id}
                      disabled={busy || Boolean(when)}
                      onClick={() => setPrivacy(p.id)}
                      className={`chip min-h-[32px] h-8 text-xs ${privacy === p.id ? 'chip-active' : ''}`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                <div className="space-y-1.5">
                  <label htmlFor={whenId} className="text-xs font-medium text-ink-300">Publish at (optional)</label>
                  <div className="flex items-center gap-2">
                    <input
                      id={whenId}
                      type="datetime-local"
                      value={when}
                      disabled={busy}
                      onChange={(e) => setWhen(e.target.value)}
                      className="bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 text-xs text-ink-200 focus:outline-none focus:border-ember-500/60"
                    />
                    {when && <button type="button" onClick={() => setWhen('')} disabled={busy} className="chip min-h-[32px] h-8 text-xs">Clear</button>}
                  </div>
                  <p className="text-xs text-ink-400">Leave empty to use the visibility above. A time (within 60 days) uploads it private and YouTube makes it public then.</p>
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

                {product.ai_disclosure && (
                  <p className="text-xs text-ink-400">
                    This draft is marked "altered or synthetic content" on YouTube (the default for computer-made drafts). YouTube asks for that mark when realistic content is AI-generated or meaningfully AI-altered; check the setting in YouTube Studio if unsure.
                  </p>
                )}

                <button
                  type="button"
                  onClick={() => publish()}
                  disabled={busy}
                  className="btn-ember inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[36px] rounded-lg text-sm font-medium transition"
                >
                  {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Youtube className="w-4 h-4" />}
                  <span>{busy ? 'Uploading...' : when ? 'Schedule' : 'Publish'}</span>
                </button>
                </>
              )}
            </div>
          </details>
        </div>
      )}

      {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}

      {overLimit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div role="alertdialog" aria-modal="true" aria-labelledby={`${titleId}-limit`} className="w-full max-w-sm space-y-3 rounded-xl border border-amber-500/40 bg-ink-950 p-4 shadow-xl">
            <p id={`${titleId}-limit`} className="flex items-center gap-1.5 text-sm font-medium text-amber-300">
              <AlertTriangle className="h-4 w-4" /> Daily limit reached
            </p>
            <p className="text-xs text-ink-200">{overLimit.message}</p>
            <p className="text-xs text-ink-300">This channel's limit is {overLimit.max} a day. Do you still want to {when ? 'schedule' : 'publish'} this video?</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setOverLimit(null)} className="chip min-h-[32px] h-8 text-xs">Cancel</button>
              <button type="button" onClick={() => publish(true)} className="btn-ember min-h-[32px] rounded-lg px-3 text-xs font-medium">Yes, {when ? 'schedule' : 'publish'} anyway</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
