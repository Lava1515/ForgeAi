import React, { useEffect, useState } from 'react';
import {
  TrendingUp,
  RefreshCw,
  Target,
  Compass,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  BarChart2,
  Award,
  Edit3,
  Check,
  X,
  Layers,
  Lightbulb,
  Radio,
} from 'lucide-react';
import * as api from '../services/api.js';
import PageHeader from '../ui/PageHeader.jsx';
import Panel from '../ui/Panel.jsx';
import Button from '../ui/Button.jsx';
import Badge from '../ui/Badge.jsx';
import StatTile from '../ui/StatTile.jsx';
import Banner from '../ui/Banner.jsx';
import EmptyState from '../ui/EmptyState.jsx';
import { timeAgo } from '../utils/format.js';

const formatNumber = (num) => {
  if (num == null || Number.isNaN(Number(num))) return '-';
  const n = Number(num);
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
};

const scoreTone = (scoreStr) => {
  if (!scoreStr) return 'neutral';
  const s = String(scoreStr).toUpperCase();
  if (s.startsWith('A')) return 'success';
  if (s.startsWith('B')) return 'accent';
  if (s.startsWith('C')) return 'warn';
  return 'error';
};

const impactTone = (impact) => {
  const i = String(impact || '').toLowerCase();
  if (i === 'high') return 'accent';
  if (i === 'medium') return 'warn';
  return 'neutral';
};

const ageViews = (video, days) => {
  const snapshot = video.analytics_history?.find((item) => item.age_days === days);
  return snapshot?.views ?? null;
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const stopRuleFor = (videos, format) => {
  if (!videos) return { state: 'Unavailable' };
  const uploads = videos.filter((video) => video.format === format);
  const judged = uploads.map((video) => ageViews(video, 7)).filter((views) => views != null);
  if (judged.length < 20) return { state: 'Collecting data', judged: judged.length, uploads: uploads.length };
  const typical = median(judged);
  const best = Math.max(...judged);
  const triggered = typical < 300 && best <= 10000;
  return { state: triggered ? 'Stop rule reached' : 'Stop rule not reached', judged: judged.length, uploads: uploads.length, typical, best };
};

export default function Growth({ activeChannel }) {
  const [report, setReport] = useState(null);
  const [channelStats, setChannelStats] = useState(null);
  const [strategy, setStrategy] = useState(null);
  const [ideas, setIdeas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [generatingStrategy, setGeneratingStrategy] = useState(false);
  const [generatingIdeas, setGeneratingIdeas] = useState(false);
  const [savingStrategy, setSavingStrategy] = useState(false);
  const [editingStrategy, setEditingStrategy] = useState(false);

  const [editPillar, setEditPillar] = useState('');
  const [editCadence, setEditCadence] = useState('');
  const [editPositioning, setEditPositioning] = useState('');

  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  // A/B target channel state (KAN-251)
  const [abData, setAbData] = useState(null);
  const [selectedAbChannel, setSelectedAbChannel] = useState('');
  const [savingAbChannel, setSavingAbChannel] = useState(false);

  const channelId = activeChannel?.id || 'default';
  const channelName = activeChannel?.name || 'ForgeAI (Primary)';
  const isTopicPickingOn = activeChannel?.growth_topic_picking === true;

  const boundAccount = activeChannel?.bound_account || activeChannel?.token;
  const boundAccountName = boundAccount?.channel;
  const boundAccountId = boundAccount?.channel_id;

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [reportData, stratData, ideasData, abChannelData, channelData] = await Promise.all([
        api.getGrowthReport(channelId).catch(() => null),
        api.getGrowthStrategy(channelId).catch(() => null),
        api.getGrowthIdeas(channelId).catch(() => null),
        api.getGrowthABChannel(channelId).catch(() => null),
        api.getChannel().catch(() => null),
      ]);

      // Each call falls back to null so one failure keeps the rest; all five failing means the API is down.
      if (!reportData && !stratData && !ideasData && !abChannelData && !channelData) {
        setError('Could not load growth data. Check that the dashboard server is running, then use Refresh Report.');
      }

      setReport(reportData);
      setChannelStats(channelData);

      const resolvedStrat = stratData?.strategy || reportData?.strategy || null;
      setStrategy(resolvedStrat);
      if (resolvedStrat) {
        setEditPillar(resolvedStrat.content_pillar || '');
        setEditCadence(resolvedStrat.upload_cadence || '');
        setEditPositioning(resolvedStrat.positioning || '');
      }

      const resolvedIdeas = ideasData?.ideas || reportData?.ideas || [];
      setIdeas(Array.isArray(resolvedIdeas) ? resolvedIdeas : []);

      setAbData(abChannelData);
      const currentTarget = abChannelData?.growth_ab_channel || activeChannel?.growth_ab_channel || channelId;
      setSelectedAbChannel(currentTarget);
    } catch (err) {
      console.error('Failed to load growth intelligence:', err);
      setError(err.message || 'Failed to load growth intelligence');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [channelId]);

  const handleRefreshReport = async (force = true) => {
    try {
      setRefreshing(true);
      setError(null);
      setNotice(null);
      const data = await api.refreshGrowthReport({ channelId, force });
      setReport(data);
      const freshChannelData = await api.getChannel().catch(() => null);
      if (freshChannelData) setChannelStats(freshChannelData);
      if (data?.strategy) setStrategy(data.strategy);
      if (data?.ideas) setIdeas(data.ideas);
      setNotice(data?.cached ? 'Returned recent report (< 1 hour old).' : 'Growth report refreshed successfully.');
    } catch (err) {
      console.error('Failed to refresh growth report:', err);
      setError(err.message || 'Failed to refresh growth report');
    } finally {
      setRefreshing(false);
    }
  };

  const handleSaveStrategy = async (e) => {
    e?.preventDefault?.();
    try {
      setSavingStrategy(true);
      setError(null);
      const res = await api.saveGrowthStrategy({
        channelId,
        content_pillar: editPillar,
        upload_cadence: editCadence,
        positioning: editPositioning,
      });
      setStrategy(res.strategy);
      setEditingStrategy(false);
      setNotice('Channel content strategy updated and saved.');
    } catch (err) {
      console.error('Failed to save strategy:', err);
      setError(err.message || 'Failed to save strategy');
    } finally {
      setSavingStrategy(false);
    }
  };

  const handleGenerateStrategy = async () => {
    try {
      setGeneratingStrategy(true);
      setError(null);
      const res = await api.generateGrowthStrategy({ channelId, force: true });
      setStrategy(res.strategy);
      if (res.strategy) {
        setEditPillar(res.strategy.content_pillar || '');
        setEditCadence(res.strategy.upload_cadence || '');
        setEditPositioning(res.strategy.positioning || '');
      }
      setNotice('AI Content Pillar & Cadence generated successfully.');
    } catch (err) {
      console.error('Failed to generate strategy:', err);
      setError(err.message || 'Failed to generate strategy');
    } finally {
      setGeneratingStrategy(false);
    }
  };

  const handleGenerateIdeas = async () => {
    try {
      setGeneratingIdeas(true);
      setError(null);
      const res = await api.generateGrowthIdeas({ channelId, force: true });
      setIdeas(res.ideas || []);
      setNotice('Pillar-aligned ideas generated and ranked.');
    } catch (err) {
      console.error('Failed to generate ideas:', err);
      setError(err.message || 'Failed to generate ideas');
    } finally {
      setGeneratingIdeas(false);
    }
  };

  const handleSaveAbChannel = async () => {
    try {
      setSavingAbChannel(true);
      setError(null);
      const res = await api.saveGrowthABChannel({
        channelId,
        growth_ab_channel: selectedAbChannel,
      });
      setNotice(`A/B experiment target channel saved (${res.growth_ab_channel}).`);
      const freshAb = await api.getGrowthABChannel(channelId).catch(() => null);
      if (freshAb) {
        setAbData(freshAb);
        setSelectedAbChannel(freshAb.growth_ab_channel);
      }
    } catch (err) {
      console.error('Failed to save A/B channel:', err);
      setError(err.message || 'Failed to save A/B channel target');
    } finally {
      setSavingAbChannel(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Channel Intelligence"
          title="Growth Diagnostics"
          subtitle={`Loading growth telemetry for ${channelName}...`}
        />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 animate-pulse">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-20 rounded-xl bg-ink-900/60 border border-ink-800" />
          ))}
        </div>
      </div>
    );
  }

  const isEmpty = !report || report.empty;
  const candidates = Array.isArray(abData?.candidates) ? abData.candidates : [];
  const selectedCandidate = candidates.find((c) => c.id === selectedAbChannel) || null;
  const currentTargetId = abData?.growth_ab_channel || activeChannel?.growth_ab_channel || channelId;
  const currentTargetCandidate = candidates.find((c) => c.id === currentTargetId) || null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Channel Intelligence"
        title="Growth Diagnostics & Strategy"
        badge={
          <div className="flex items-center gap-2 flex-wrap">
            {report?.profile_name || report?.profile ? (
              <Badge tone="accent">
                Profile: {report.profile_name || report.profile}
              </Badge>
            ) : null}
            <Badge tone={isTopicPickingOn ? 'success' : 'neutral'}>
              AutoPilot Topic Picking: {isTopicPickingOn ? 'ON' : 'OFF'}
            </Badge>
            {boundAccountName ? (
              <Badge tone="success" title={`Bound YouTube Account ID: ${boundAccountId || '-'}`}>
                Bound Account: {boundAccountName}{boundAccountId ? ` (${boundAccountId})` : ''}
              </Badge>
            ) : (
              <Badge tone="warn">
                Bound Account: Not connected
              </Badge>
            )}
          </div>
        }
        subtitle={
          report?.generated_at
            ? `Report generated ${timeAgo(report.generated_at)} (${new Date(report.generated_at).toLocaleDateString()}) from cached channel scan telemetry.`
            : `Per-channel audience analysis, content pillar strategy, and AutoPilot topic picking for ${channelName}.`
        }
        actions={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={refreshing}
            onClick={() => handleRefreshReport(true)}
            icon={<RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />}
          >
            {refreshing ? 'Refreshing...' : 'Refresh Report'}
          </Button>
        }
      />

      {error && (
        <Banner tone="error" title="Growth Diagnostics Error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}

      {notice && (
        <Banner tone="success" title="Growth Update" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      )}

      {/* A/B Target Channel Configuration Panel (KAN-251) */}
      <Panel className="p-5 space-y-4 border-ink-800 bg-ink-950/80">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-ink-800/80 pb-3">
          <div className="flex items-center gap-2.5">
            <Radio className="w-5 h-5 text-ember-400 shrink-0" />
            <div>
              <h3 className="text-sm font-semibold text-ink-50">A/B Experiment Target Channel (growth_ab_channel)</h3>
              <p className="text-xs text-ink-400">
                Determines which channel is targeted for growth A/B experimentation (KAN-250). Defaults to the current channel.
              </p>
            </div>
          </div>
          {selectedCandidate && (
            <div className="flex items-center gap-2">
              {selectedCandidate.is_current ? (
                <Badge tone="accent">Default (Current Channel)</Badge>
              ) : selectedCandidate.eligible ? (
                <Badge tone="success">Eligible Target</Badge>
              ) : (
                <Badge tone="warn">Ineligible</Badge>
              )}
            </div>
          )}
        </div>

        <div className="space-y-4 pt-1">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="min-w-0 space-y-2">
              <label htmlFor="growth-ab-channel" className="block text-xs font-medium text-ink-300">
                Select A/B Target Channel
              </label>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <select
                  id="growth-ab-channel"
                  value={selectedAbChannel}
                  disabled={candidates.length === 0}
                  onChange={(e) => setSelectedAbChannel(e.target.value)}
                  className="min-w-0 flex-1 px-3.5 py-2 bg-ink-900 border border-ink-800 rounded-xl text-sm text-ink-100 focus:outline-none focus:border-ember-500/70 transition shadow-inner"
                >
                  {candidates.length === 0 && <option value="">No channels available</option>}
                  {candidates.map((c) => {
                    const label = `${c.name}${c.is_current ? ' (Current - Default)' : ''}${!c.eligible && !c.is_current ? ` [Cannot select: ${c.reason}]` : ''}`;
                    return (
                      <option key={c.id} value={c.id} disabled={!c.eligible && !c.is_current}>
                        {label}
                      </option>
                    );
                  })}
                </select>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={
                    savingAbChannel ||
                    candidates.length === 0 ||
                    selectedAbChannel === currentTargetId ||
                    (selectedCandidate && !selectedCandidate.eligible && !selectedCandidate.is_current)
                  }
                  onClick={handleSaveAbChannel}
                  icon={<Check className="w-3.5 h-3.5" />}
                >
                  {savingAbChannel ? 'Saving...' : 'Set Target'}
                </Button>
              </div>
              <p className="text-[11px] text-ink-500">
                To target a different channel, that channel must have its YouTube Data API key saved and be connected via OAuth.
              </p>
            </div>

            <div className="p-3.5 rounded-xl bg-ink-900/60 border border-ink-800/80 space-y-1.5 text-xs">
              <span className="text-[11px] font-mono uppercase tracking-wider text-ink-400 block">
                Active A/B Target
              </span>
              <p className="text-sm font-semibold text-ember-300 truncate">
                {currentTargetCandidate?.name || activeChannel?.name || 'Current Channel'}
              </p>
              <div className="text-[11px] space-y-0.5 text-ink-400">
                <p className="truncate">
                  Bound: {currentTargetCandidate?.bound_account?.channel || boundAccountName || 'Not connected'}
                </p>
                <p>
                  API Key: {currentTargetCandidate?.has_api_key ? 'Saved (Masked)' : 'Missing'}
                </p>
              </div>
            </div>
          </div>

          {/* Missing requirements message if an ineligible channel was attempted or selected */}
          {selectedCandidate && !selectedCandidate.eligible && !selectedCandidate.is_current && (
            <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-300 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-amber-200">Cannot target "{selectedCandidate.name}": </span>
                <span>{selectedCandidate.reason}. </span>
                <span className="text-amber-400 block mt-0.5">
                  Open Channel Settings from the sidebar to save its YouTube Data API Key and connect its YouTube account.
                </span>
              </div>
            </div>
          )}

          {/* Configured Channel A/B Readiness Cards */}
          {candidates.length > 0 && (
            <div className="pt-2">
              <span className="text-xs font-semibold text-ink-300 block mb-2">
                Configured Channel A/B Readiness:
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {candidates.map((c) => {
                  const isSelected = c.id === currentTargetId;
                  const isCurrent = c.is_current;
                  const canPick = c.eligible || isCurrent;
                  return (
                    <div
                      key={c.id}
                      className={`p-3 rounded-xl border text-xs transition ${
                        isSelected
                          ? 'border-ember-500/50 bg-ember-500/10 shadow-sm'
                          : 'border-ink-800/70 bg-ink-950/50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <span className="font-medium text-ink-100 truncate">{c.name}</span>
                        {isCurrent ? (
                          <span className="text-[10px] font-mono text-ember-400 bg-ember-500/15 px-1.5 py-0.5 rounded">Default</span>
                        ) : c.eligible ? (
                          <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/15 px-1.5 py-0.5 rounded">Ready</span>
                        ) : (
                          <span className="text-[10px] font-mono text-rose-400 bg-rose-500/15 px-1.5 py-0.5 rounded">Missing</span>
                        )}
                      </div>
                      <div className="text-[11px] text-ink-400 space-y-0.5">
                        <p className="truncate">
                          Account: <span className={c.bound_account?.channel ? 'text-emerald-400' : 'text-ink-500'}>{c.bound_account?.channel || 'None'}</span>
                        </p>
                        <p>
                          Data API Key: <span className={c.has_api_key ? 'text-emerald-400' : 'text-rose-400'}>{c.has_api_key ? 'Saved' : 'Missing'}</span>
                        </p>
                      </div>
                      {!canPick && c.reason && (
                        <p className="text-[10px] text-rose-400/90 mt-1.5 leading-tight italic border-t border-ink-800/60 pt-1">
                          {c.reason}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </Panel>

      {/* Content Strategy & Pillar Panel (KAN-247) */}
      <Panel className="p-5 space-y-4 border-ember-500/20 bg-ink-950/80">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-ink-800/80 pb-3">
          <div className="flex items-center gap-2.5">
            <Target className="w-5 h-5 text-ember-400 shrink-0" />
            <div>
              <h3 className="text-sm font-semibold text-ink-50">Channel Content Strategy & Pillar</h3>
              <p className="text-xs text-ink-400">
                Picks one focused content pillar and upload cadence to feed AutoPilot topic picking.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {strategy && !editingStrategy && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setEditingStrategy(true)}
                icon={<Edit3 className="w-3.5 h-3.5" />}
              >
                Edit Strategy
              </Button>
            )}
            <Button
              type="button"
              variant={strategy ? 'secondary' : 'primary'}
              size="sm"
              disabled={generatingStrategy}
              onClick={handleGenerateStrategy}
              icon={<Sparkles className={`w-3.5 h-3.5 ${generatingStrategy ? 'animate-spin' : ''}`} />}
            >
              {generatingStrategy ? 'Analyzing Strategy...' : strategy ? 'Regenerate AI Strategy' : 'Generate Strategy'}
            </Button>
          </div>
        </div>

        {editingStrategy ? (
          <form onSubmit={handleSaveStrategy} className="space-y-4 pt-2">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="growth-edit-pillar" className="block text-xs font-medium text-ink-300 mb-1.5">
                  Content Pillar <span className="text-rose-400">*</span>
                </label>
                <input
                  id="growth-edit-pillar"
                  type="text"
                  value={editPillar}
                  onChange={(e) => setEditPillar(e.target.value)}
                  placeholder="e.g. Everyday Mechanism Forensics & 3D Cutaways"
                  required
                  className="w-full px-3.5 py-2.5 bg-ink-950 border border-ink-800 rounded-xl text-sm text-ink-100 placeholder-ink-600 focus:outline-none focus:border-ember-500/70 transition shadow-inner"
                />
                <span className="block text-[11px] text-ink-500 mt-1">
                  Primary thematic focus for all upcoming Shorts.
                </span>
              </div>

              <div>
                <label htmlFor="growth-edit-cadence" className="block text-xs font-medium text-ink-300 mb-1.5">
                  Upload Cadence
                </label>
                <input
                  id="growth-edit-cadence"
                  type="text"
                  value={editCadence}
                  onChange={(e) => setEditCadence(e.target.value)}
                  placeholder="e.g. 1 short per day"
                  className="w-full px-3.5 py-2.5 bg-ink-950 border border-ink-800 rounded-xl text-sm text-ink-100 placeholder-ink-600 focus:outline-none focus:border-ember-500/70 transition shadow-inner"
                />
                <span className="block text-[11px] text-ink-500 mt-1">
                  Target publication frequency matched to channel size tier.
                </span>
              </div>
            </div>

            <div>
              <label htmlFor="growth-edit-positioning" className="block text-xs font-medium text-ink-300 mb-1.5">
                Positioning Statement / Angle
              </label>
              <textarea
                id="growth-edit-positioning"
                value={editPositioning}
                onChange={(e) => setEditPositioning(e.target.value)}
                rows={2}
                placeholder="What differentiates this channel from competitors and what outcome viewers get..."
                className="w-full px-3.5 py-2.5 bg-ink-950 border border-ink-800 rounded-xl text-sm text-ink-100 placeholder-ink-600 focus:outline-none focus:border-ember-500/70 transition shadow-inner resize-none"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setEditingStrategy(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={savingStrategy}
                icon={<Check className="w-3.5 h-3.5" />}
              >
                {savingStrategy ? 'Saving...' : 'Save Strategy'}
              </Button>
            </div>
          </form>
        ) : strategy ? (
          <div className="space-y-4 pt-1">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 rounded-xl bg-ink-900/60 border border-ink-800/80 md:col-span-2">
                <span className="text-[11px] font-mono uppercase tracking-wider text-ink-400 block mb-1">
                  Active Content Pillar
                </span>
                <p className="text-base font-semibold text-ember-300">
                  {strategy.content_pillar || 'Not Defined'}
                </p>
                {strategy.positioning && (
                  <p className="text-xs text-ink-300 mt-2 leading-relaxed italic border-l-2 border-ember-500/40 pl-2.5">
                    "{strategy.positioning}"
                  </p>
                )}
              </div>

              <div className="p-4 rounded-xl bg-ink-900/60 border border-ink-800/80 space-y-2">
                <span className="text-[11px] font-mono uppercase tracking-wider text-ink-400 block">
                  Recommended Cadence
                </span>
                <p className="text-lg font-bold font-mono text-ink-100">
                  {strategy.upload_cadence || '1 short per day'}
                </p>
                {strategy.cadence_details && (
                  <p className="text-[11px] text-ink-400 leading-normal">
                    {strategy.cadence_details}
                  </p>
                )}
              </div>
            </div>

            {Array.isArray(strategy.content_pillars) && strategy.content_pillars.length > 1 && (
              <div className="pt-2">
                <span className="text-xs font-semibold text-ink-300 block mb-2">Supporting Pillars & Sub-Themes:</span>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
                  {strategy.content_pillars.map((p, idx) => (
                    <div key={idx} className="p-3 rounded-lg bg-ink-900/40 border border-ink-800/60 text-xs">
                      <span className="font-medium text-ink-200 block">{p.name}</span>
                      {p.description && <span className="text-[11px] text-ink-400 mt-0.5 block">{p.description}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="py-6 text-center space-y-3">
            <p className="text-xs text-ink-400 max-w-md mx-auto">
              No strategy is stored for this channel yet. Generate an AI content pillar and upload cadence based on channel profile intelligence.
            </p>
          </div>
        )}
      </Panel>

      {/* Topic Ideas Feeding AutoPilot Panel (KAN-247) */}
      <Panel className="p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-ink-800/80 pb-3">
          <div className="flex items-center gap-2.5">
            <Lightbulb className="w-5 h-5 text-ember-400 shrink-0" />
            <div>
              <h3 className="text-sm font-semibold text-ink-50">Topic Ideas Feeding AutoPilot</h3>
              <p className="text-xs text-ink-400">
                Pillar-focused concepts and competitor gap discoveries. Off-pillar topics rank below on-pillar ideas.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={generatingIdeas}
            onClick={handleGenerateIdeas}
            icon={<RefreshCw className={`w-3.5 h-3.5 ${generatingIdeas ? 'animate-spin' : ''}`} />}
          >
            {generatingIdeas ? 'Researching Ideas...' : 'Generate Fresh Ideas'}
          </Button>
        </div>

        {Array.isArray(ideas) && ideas.length > 0 ? (
          <div className="space-y-2.5">
            {ideas.map((item, idx) => (
              <div
                key={idx}
                className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl border transition ${
                  item.on_pillar
                    ? 'bg-ink-950/70 border-ember-500/30 hover:border-ember-500/50'
                    : 'bg-ink-950/40 border-ink-800/60 hover:border-ink-800 text-ink-400'
                }`}
              >
                <div className="flex items-start gap-3 min-w-0">
                  <span
                    className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-mono shrink-0 mt-0.5 ${
                      item.on_pillar ? 'bg-ember-500/20 text-ember-300 font-bold' : 'bg-ink-800 text-ink-400'
                    }`}
                  >
                    {item.rank || idx + 1}
                  </span>
                  <div className="min-w-0">
                    <p className={`text-xs font-semibold ${item.on_pillar ? 'text-ink-50' : 'text-ink-300'}`}>
                      {item.topic || item.theme}
                    </p>
                    {item.reason && (
                      <p className="text-[11px] text-ink-400 mt-1 leading-relaxed">
                        {item.reason}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                  <Badge tone={item.on_pillar ? 'accent' : 'neutral'}>
                    {item.on_pillar ? 'ON-PILLAR' : 'OFF-PILLAR'}
                  </Badge>
                  {item.score != null && (
                    <span className="text-[11px] font-mono text-ink-400 px-2 py-0.5 rounded bg-ink-900 border border-ink-800">
                      Score: {item.score}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-6 text-center space-y-3">
            <p className="text-xs text-ink-400 max-w-md mx-auto">
              No ranked ideas have been generated yet. Click "Generate Fresh Ideas" to run ideate and competitor gap discovery.
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={generatingIdeas}
              onClick={handleGenerateIdeas}
              icon={<Sparkles className="w-4 h-4" />}
            >
              {generatingIdeas ? 'Running Gap Analysis...' : 'Discover Topic Ideas'}
            </Button>
          </div>
        )}
      </Panel>

      {/* Report & Audit Telemetry */}
      <Panel className="p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 border-b border-ink-800/80 pb-3">
          <div>
            <h3 className="text-sm font-semibold text-ink-50">Growth over time</h3>
            <p className="text-xs text-ink-400">Views recorded at the same video age and views gained in the latest 24 hours.</p>
          </div>
          <span className="text-[11px] text-ink-500">{channelStats?.scanned_at ? `Last scan ${timeAgo(channelStats.scanned_at)}` : 'Scan history unavailable'}</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {['short', 'video'].map((format) => {
            const rule = stopRuleFor(channelStats?.scanned_at ? channelStats.videos || [] : null, format);
            const tone = rule.state === 'Stop rule reached' ? 'error' : rule.state === 'Stop rule not reached' ? 'success' : 'warn';
            return (
              <div key={format} className="p-3 rounded-xl bg-ink-900/50 border border-ink-800/80 flex items-start justify-between gap-3">
                <div>
                  <span className="text-[11px] uppercase tracking-wider text-ink-400">{format === 'short' ? 'Shorts' : 'Videos'} stop rule</span>
                  <p className="text-xs text-ink-300 mt-1">{rule.judged == null ? 'No channel scan data' : `${rule.judged}/20 videos with 7-day views`}{rule.typical != null ? ` · median ${formatNumber(rule.typical)} · best ${formatNumber(rule.best)}` : ''}</p>
                </div>
                <Badge tone={tone}>{rule.state}</Badge>
              </div>
            );
          })}
        </div>
        {Array.isArray(channelStats?.videos) && channelStats.videos.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-xs">
              <thead><tr className="text-left text-[10px] uppercase tracking-wider text-ink-500 border-b border-ink-800">
                <th className="py-2 pr-3 font-medium">Video</th><th className="py-2 px-3 font-medium text-right">1 day</th><th className="py-2 px-3 font-medium text-right">2 days</th><th className="py-2 px-3 font-medium text-right">7 days</th><th className="py-2 pl-3 font-medium text-right">Last 24 h</th>
              </tr></thead>
              <tbody>{channelStats.videos.map((video) => (
                <tr key={video.video_id} className="border-b border-ink-800/50 last:border-0">
                  <td className="py-2.5 pr-3 max-w-[320px]"><a href={video.url} target="_blank" rel="noreferrer" className="text-ink-200 hover:text-ember-300 truncate block">{video.title || video.video_id}</a><span className="text-[10px] text-ink-500">{video.format === 'short' ? 'Short' : 'Video'}</span></td>
                  {[1, 2, 7].map((days) => { const value = ageViews(video, days); return <td key={days} className="py-2.5 px-3 text-right font-mono text-ink-300">{value == null ? <span className="text-ink-500">Unavailable</span> : formatNumber(value)}</td>; })}
                  <td className="py-2.5 pl-3 text-right font-mono text-ink-300">{video.views_24h == null ? <span className="text-ink-500">Unavailable</span> : formatNumber(video.views_24h)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : (
          <p className="py-4 text-center text-xs text-ink-500">Per-video growth data unavailable. Run a channel scan to start collecting snapshots.</p>
        )}
        <p className="text-[10px] text-ink-500">Stop rule: after 20 videos in a format have 7-day data, it is reached when the median is below 300 views and none passed 10,000.</p>
      </Panel>

      {isEmpty ? (
        <Panel className="p-8">
          <EmptyState
            icon={TrendingUp}
            title={report?.reason === 'no_scan_data' ? 'No Channel Scan Found' : 'No Growth Report Generated Yet'}
            description={
              report?.message ||
              'A channel scan provides the baseline views, velocity, and theme performance required to run the Growth audit. Run a channel scan or click Refresh Report.'
            }
            action={
              <Button
                variant="primary"
                size="sm"
                disabled={refreshing}
                onClick={() => handleRefreshReport(true)}
                icon={<Sparkles className="w-4 h-4" />}
              >
                {refreshing ? 'Analyzing Channel...' : 'Generate Growth Report'}
              </Button>
            }
          />
        </Panel>
      ) : (
        <>
          {/* Baseline Metrics Bar */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="label">Baseline Telemetry (KAN-245 Benchmark)</span>
              <span className="text-[11px] font-mono text-ink-500">
                Settled comparison cohort
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatTile
                label="Baseline Shorts"
                value={report.baseline?.shorts_count ?? '-'}
                hint="Analyzed video volume"
              />
              <StatTile
                label="Total Views"
                value={formatNumber(report.baseline?.total_views)}
                hint="Audience reach pool"
                accent
              />
              <StatTile
                label="Subscribers"
                value={report.baseline?.subscribers ?? '-'}
                hint="Channel subscriber base"
              />
              <StatTile
                label="Median Velocity"
                value={`${report.baseline?.median_views_per_hour ?? 0}/h`}
                hint="Views/hr benchmark"
              />
            </div>
          </div>

          {/* Scores & Health Assessment */}
          {report.scores && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Panel className="p-5 md:col-span-2 space-y-4">
                <div className="flex items-center justify-between border-b border-ink-800/80 pb-2">
                  <div className="flex items-center gap-2">
                    <Award className="w-4 h-4 text-ember-400" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-ink-200">
                      Channel Audit Scorecard
                    </span>
                  </div>
                  <Badge tone={scoreTone(report.scores.overall)}>
                    Overall: {report.scores.overall}
                  </Badge>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
                  <div className="p-3 rounded-lg bg-ink-950/60 border border-ink-800/70">
                    <span className="text-[11px] text-ink-400 block font-medium">Technical SEO</span>
                    <span className="text-xl font-bold font-mono text-ink-100 mt-0.5 block">
                      {report.scores.seo || 'B'}
                    </span>
                    <span className="text-[10px] text-ink-500 block mt-1">Title & Tag coverage</span>
                  </div>
                  <div className="p-3 rounded-lg bg-ink-950/60 border border-ink-800/70">
                    <span className="text-[11px] text-ink-400 block font-medium">Performance</span>
                    <span className="text-xl font-bold font-mono text-ink-100 mt-0.5 block">
                      {report.scores.performance || 'B'}
                    </span>
                    <span className="text-[10px] text-ink-500 block mt-1">Velocity & reach</span>
                  </div>
                  <div className="p-3 rounded-lg bg-ink-950/60 border border-ink-800/70">
                    <span className="text-[11px] text-ink-400 block font-medium">Content Strategy</span>
                    <span className="text-xl font-bold font-mono text-ink-100 mt-0.5 block">
                      {report.scores.strategy || 'B'}
                    </span>
                    <span className="text-[10px] text-ink-500 block mt-1">Pillar & theme fit</span>
                  </div>
                  <div className="p-3 rounded-lg bg-ink-950/60 border border-ink-800/70">
                    <span className="text-[11px] text-ink-400 block font-medium">Monetization</span>
                    <span className="text-xl font-bold font-mono text-ink-100 mt-0.5 block">
                      {report.scores.monetization || 'C'}
                    </span>
                    <span className="text-[10px] text-ink-500 block mt-1">YPP readiness</span>
                  </div>
                </div>
              </Panel>

              {/* Next Suggested Sub-Skill */}
              <Panel className="p-5 flex flex-col justify-between border-ember-500/20 bg-ink-900/90">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-ember-400">
                    <Compass className="w-4 h-4" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-ember-300">
                      Suggested Next Step
                    </span>
                  </div>
                  <h3 className="text-base font-semibold text-ink-50 pt-1">
                    {report.next_subskill?.label || 'Hook & Retention Optimization'}
                  </h3>
                  <p className="text-xs text-ink-400 leading-relaxed">
                    {report.next_subskill?.reason ||
                      'Prioritize the first 3 seconds of each short to elevate audience retention beyond 70%.'}
                  </p>
                </div>
                <div className="pt-4 border-t border-ink-800/80 flex items-center justify-between">
                  <Badge tone="accent">
                    Skill: {report.next_subskill?.id || 'hook'}
                  </Badge>
                  <span className="text-[11px] text-ink-500 font-mono">Automated advice</span>
                </div>
              </Panel>
            </div>
          )}

          {/* Top Priority Actions */}
          <Panel className="p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-ink-800/80 pb-2">
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-ember-400" />
                <span className="text-xs font-semibold uppercase tracking-wider text-ink-200">
                  Top Priority Recommendations
                </span>
              </div>
              <span className="text-[11px] font-mono text-ink-500">
                {report.top_actions?.length || 0} actionable items
              </span>
            </div>

            <div className="space-y-2.5">
              {Array.isArray(report.top_actions) && report.top_actions.length > 0 ? (
                report.top_actions.map((act, idx) => (
                  <div
                    key={idx}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 rounded-xl bg-ink-950/60 border border-ink-800 hover:border-ink-700 transition"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <span className="flex items-center justify-center w-5 h-5 rounded-full bg-ink-800 text-[11px] font-mono text-ink-300 shrink-0 mt-0.5">
                        {idx + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-ink-100">
                          {act.action}
                        </p>
                        {act.details && (
                          <p className="text-[11px] text-ink-400 mt-0.5 leading-relaxed">
                            {act.details}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                      {act.category && (
                        <span className="text-[10px] uppercase font-mono text-ink-500 px-1.5 py-0.5 rounded bg-ink-900 border border-ink-800">
                          {act.category}
                        </span>
                      )}
                      <Badge tone={impactTone(act.impact)}>
                        {act.impact || 'High'} Impact
                      </Badge>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-xs text-ink-500 py-3">No actions reported.</p>
              )}
            </div>
          </Panel>

          {/* Winning Patterns Summary */}
          {report.channel_data_summary?.best && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Panel className="p-4 space-y-2">
                <span className="label">Leading Themes</span>
                <ol className="space-y-1.5 text-xs text-ink-300">
                  {report.channel_data_summary.best.themes?.slice(0, 4).map((t, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span className="truncate">{t.name || '-'}</span>
                      <span className="font-mono text-ember-400 shrink-0">{t.views_per_hour}/h</span>
                    </li>
                  )) || <li className="text-ink-500">None detected</li>}
                </ol>
              </Panel>
              <Panel className="p-4 space-y-2">
                <span className="label">Winning Voices</span>
                <ol className="space-y-1.5 text-xs text-ink-300">
                  {report.channel_data_summary.best.voices?.slice(0, 4).map((v, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span className="truncate">{v.name || '-'}</span>
                      <span className="font-mono text-ember-400 shrink-0">{v.views_per_hour}/h</span>
                    </li>
                  )) || <li className="text-ink-500">None detected</li>}
                </ol>
              </Panel>
              <Panel className="p-4 space-y-2">
                <span className="label">Winning Styles</span>
                <ol className="space-y-1.5 text-xs text-ink-300">
                  {report.channel_data_summary.best.styles?.slice(0, 4).map((s, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span className="truncate">{s.name || s.style || '-'}</span>
                      <span className="font-mono text-ember-400 shrink-0">{s.views_per_hour}/h</span>
                    </li>
                  )) || <li className="text-ink-500">None detected</li>}
                </ol>
              </Panel>
            </div>
          )}
        </>
      )}
    </div>
  );
}
