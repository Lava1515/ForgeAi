import React, { useEffect, useState } from 'react';
import { BarChart3, RefreshCw, ArrowUpRight, Video, Youtube } from 'lucide-react';
import * as api from '../services/api.js';
import PageHeader from '../ui/PageHeader.jsx';
import Panel from '../ui/Panel.jsx';
import Button from '../ui/Button.jsx';
import Badge from '../ui/Badge.jsx';
import StatTile from '../ui/StatTile.jsx';
import Banner from '../ui/Banner.jsx';
import EmptyState from '../ui/EmptyState.jsx';
import { timeAgo } from '../utils/format.js';

function Board({ title, rows, label }) {
  return (
    <Panel className="p-4 space-y-3">
      <span className="label">{title}</span>
      {rows.length === 0 && <p className="text-xs text-ink-400">No data yet.</p>}
      <ol className="space-y-2">
        {rows.slice(0, 5).map((r, i) => (
          <li key={r.name || i} className="flex items-start justify-between gap-3 text-xs">
            <span className="text-ink-200 line-clamp-2">{label ? label(r) : r.name}</span>
            <span className="font-mono text-ember-400 whitespace-nowrap">{r.views_per_hour.toLocaleString()}/h · {r.videos} vid</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function VideoTable({ title, videos }) {
  if (videos.length === 0) return null;
  const hasStyle = videos.some((v) => Boolean(v.instruct && v.instruct.trim() && v.instruct !== '-'));
  const headers = ['Video', 'Views/h', 'Views', 'Likes', 'Voice', ...(hasStyle ? ['Style'] : []), 'Theme'];

  return (
    <Panel className="p-5 space-y-3">
      <div className="flex items-center justify-between border-b border-ink-800/80 pb-2">
        <span className="text-xs font-semibold text-ink-200 uppercase tracking-wider">{title}</span>
        <span className="text-xs font-mono text-ink-400">{videos.length} items</span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-ink-800 bg-ink-950/60">
        <table className="w-full text-xs">
          <thead className="text-ink-400 text-left bg-ink-950/80">
            <tr>
              {headers.map((h) => (
                <th key={h} className="px-3.5 py-2.5 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800/50">
            {videos.map((v) => (
              <tr key={v.video_id} className="align-top hover:bg-ink-900/50 transition-colors">
                <td className="px-3.5 py-2.5">
                  <a href={v.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-ink-100 hover:text-ember-300 transition">
                    {v.thumbnail && <img src={v.thumbnail} alt="" className="w-16 rounded object-cover aspect-video bg-ink-900" />}
                    <span className="line-clamp-2 font-medium">{v.title}</span>
                    <ArrowUpRight className="w-3 h-3 shrink-0 text-ink-400" />
                  </a>
                  <span className="text-xs text-ink-400 font-mono mt-1 block">{v.duration_s}s · {timeAgo(v.published_at)}</span>
                </td>
                <td className="px-3.5 py-2.5 font-mono text-ember-400 font-semibold">{v.views_per_hour.toLocaleString()}</td>
                <td className="px-3.5 py-2.5 font-mono text-ink-300">{v.views.toLocaleString()}</td>
                <td className="px-3.5 py-2.5 font-mono text-ink-300">{v.likes.toLocaleString()}</td>
                <td className="px-3.5 py-2.5 text-ink-300">{v.voice || '-'}</td>
                {hasStyle && (
                  <td className="px-3.5 py-2.5 text-ink-400 max-w-[16rem]">
                    {v.instruct && v.instruct !== '-' ? v.instruct : 'default'}
                  </td>
                )}
                <td className="px-3.5 py-2.5 text-ink-400">{v.theme || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// Our published videos ranked by views/hour, plus which voices, voice styles and themes win on average.
export default function ChannelStats() {
  const [data, setData] = useState(null);
  const [ytStatus, setYtStatus] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [newKey, setNewKey] = useState('');

  useEffect(() => {
    api.getChannel().then(setData).catch((err) => setError(err.message));
    api.getYoutubeStatus().then(setYtStatus).catch(() => {});
  }, []);

  const scan = async () => {
    setScanning(true);
    setError('');
    try {
      setData(await api.scanChannel());
    } catch (err) {
      setError(err.message);
    } finally {
      setScanning(false);
    }
  };

  // Saves into the active channel's api_key in data/channels.json, then rescans.
  const saveKey = async () => {
    try {
      // Same channel the scan uses (x-channel-id from the browser), not the server's active_channel.json.
      await api.updateChannel(api.getActiveChannelId(), { api_key: newKey });
      setNewKey('');
      await scan();
    } catch (err) {
      setError(err.message);
    }
  };

  const videos = data?.videos || [];
  const totalViews = videos.reduce((acc, v) => acc + (v.views || 0), 0);
  const avgViewsPerHour = videos.length > 0 
    ? Math.round(videos.reduce((acc, v) => acc + (v.views_per_hour || 0), 0) / videos.length) 
    : 0;

  return (
    <div data-cy="channel-stats" className="space-y-6">
      <PageHeader
        eyebrow="Channel performance"
        title="What's working"
        subtitle="Every video published from here, with the voice, style and theme that made it. Winning styles show up in Voice Style controls."
        badge={
          <div className="flex items-center gap-2">
            {data?.channel_name && (
              <Badge tone="accent">
                {data.channel_name}
              </Badge>
            )}
            {ytStatus?.connected ? (
              <Badge tone="success">
                YouTube: {ytStatus.channel || 'Connected'}
              </Badge>
            ) : ytStatus ? (
              <Badge tone="warn">
                YouTube: Disconnected
              </Badge>
            ) : null}
          </div>
        }
        actions={
          <>
            <a
              href={api.youtubeConnectUrl}
              className="btn btn-secondary !h-8 !px-3 inline-flex items-center gap-1.5 text-xs text-ink-200 hover:text-ink-100 transition"
              title={ytStatus?.channel ? `Connected as ${ytStatus.channel}` : 'Connect YouTube account'}
            >
              <Youtube className="w-3.5 h-3.5 text-ember-400" />
              {ytStatus?.connected ? 'Reconnect YouTube' : 'Connect YouTube'}
            </a>
            <Button
              variant="primary"
              size="sm"
              icon={RefreshCw}
              loading={scanning}
              onClick={scan}
            >
              {scanning ? 'Scanning channel...' : 'Scan channel'}
            </Button>
          </>
        }
      />

      {error && (
        <Banner
          tone="danger"
          action={
            <>
              {/api[_ ]key/i.test(error) && (
                <>
                  <input
                    type="password"
                    aria-label="YouTube Data API key"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    placeholder="Paste new API key (AIzaSy...)"
                    className="w-56 px-2.5 py-1 bg-ink-950 border border-ink-800 rounded-lg text-xs text-ink-100 font-mono focus:outline-none focus:border-ember-500/70"
                  />
                  <Button variant="secondary" size="sm" disabled={!newKey.trim()} onClick={saveKey}>
                    Save &amp; rescan
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => window.open('https://console.cloud.google.com/apis/credentials', '_blank', 'noopener,noreferrer')}
                  >
                    Get new API key
                  </Button>
                </>
              )}
              <Button variant="secondary" size="sm" onClick={() => setError('')}>Dismiss</Button>
            </>
          }
        >
          {error}
        </Banner>
      )}

      {/* Analytics StatTiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatTile
          label="Published Videos"
          value={data?.published ?? videos.length}
          hint={data?.scanned_at ? `Scanned ${timeAgo(data.scanned_at)}` : 'Total on channel'}
          accent
        />
        <StatTile
          label="Total Tracked Views"
          value={totalViews.toLocaleString()}
          hint="Across visible uploads"
        />
        <StatTile
          label="Avg Velocity"
          value={`${avgViewsPerHour.toLocaleString()}/h`}
          hint="Hourly view pace"
        />
        <StatTile
          label="Tracked Shorts"
          value={videos.filter((v) => v.format === 'short').length}
          hint="9:16 vertical catalog"
        />
      </div>

      {data && !data.scanned_at && !scanning && (
        <Panel className="p-6">
          <EmptyState
            icon={BarChart3}
            title="No performance scan yet"
            description="Run a channel scan to calculate views per hour, top voice styles, and high-performing themes. Each scan uses ~1 YouTube quota unit per 50 videos."
            action={
              <Button variant="primary" size="sm" onClick={scan} icon={RefreshCw}>
                Scan channel now
              </Button>
            }
          />
        </Panel>
      )}

      {data?.scanned_at && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Board title="Best voices" rows={data.best?.voices || []} />
          <Board title="Best voice styles" rows={data.best?.styles || []} label={(r) => `${r.voice}: ${r.instruct}`} />
          <Board title="Best themes" rows={data.best?.themes || []} />
        </div>
      )}

      <VideoTable title="Shorts" videos={videos.filter((v) => v.format === 'short')} />
      <VideoTable title="Videos" videos={videos.filter((v) => v.format === 'video')} />
    </div>
  );
}
