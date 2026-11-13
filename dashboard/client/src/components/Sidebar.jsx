import React, { useEffect, useState } from 'react';
import { Terminal, RefreshCw, Cpu } from 'lucide-react';
import * as api from '../services/api.js';
import { NAV_ITEMS, navHostOf } from '../nav.js';
import { stageProgress } from '../runProgress.js';
import ChannelSwitcher from './ChannelSwitcher.jsx';
import PipelineControls from './PipelineControls.jsx';
import AntigravityAccount from './AntigravityAccount.jsx';
import ClaudeAccount from './ClaudeAccount.jsx';

// Polls while the tab is visible; same cadence the old Header used for the factory beacon.
function usePoll(fn, ms) {
  useEffect(() => {
    let alive = true;
    const tick = () => { if (!document.hidden) fn(() => alive); };
    tick();
    const id = setInterval(tick, ms);
    return () => { alive = false; clearInterval(id); };
  }, []);
}

export default function Sidebar({
  activeTab, setActiveTab, status, isRunning, tasks = [], currentStage,
  channels, activeChannel, onSwitchChannel, onOpenChannelModal,
  isLoggerOpen, onToggleLogger, onOpenLogger, logCount = 0, onControlAction, onRefresh,
}) {
  const [service, setService] = useState(null);
  const [draftCount, setDraftCount] = useState(0);

  usePoll((alive) => api.getNarrativeServiceStatus()
    .then((s) => alive() && setService(s))
    .catch(() => alive() && setService({ status: 'offline' })), 15000);
  usePoll((alive) => api.getYoutubeDrafts()
    .then((d) => alive() && setDraftCount(Array.isArray(d) ? d.length : 0))
    .catch(() => {}), 60000);

  const running = tasks.find((t) => t.status === 'running');
  const pct = running ? stageProgress(running.currentStage || currentStage) : null;
  const online = service?.status === 'online';

  return (
    // Only the groups scroll: an overflow container would clip the channel dropdown, which opens sideways in rail mode.
    <nav aria-label="Main" className="w-16 lg:w-56 shrink-0 h-full flex flex-col bg-ink-900 border-r border-ink-800 px-2 lg:px-3 py-3 gap-1">
      <ChannelSwitcher channels={channels} activeChannel={activeChannel} onSwitchChannel={onSwitchChannel} onOpenChannelModal={onOpenChannelModal} />

      <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1 space-y-1 mt-3">
      {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
        const isActive = navHostOf(activeTab) === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            aria-current={isActive ? 'page' : undefined}
            aria-label={label}
            title={label}
            className={`w-full flex items-center justify-center lg:justify-start gap-2.5 h-9 px-2.5 rounded-lg text-[13px] transition-colors ${
              isActive ? 'bg-ember-500/10 text-ember-300 font-medium' : 'text-ink-400 hover:text-ink-100 hover:bg-ink-850'
            }`}
          >
            <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-ember-400' : 'text-ink-500'}`} aria-hidden="true" />
            <span className="hidden lg:inline flex-1 text-left truncate">{label}</span>
            {id === 'products' && draftCount > 0 && (
              <span className="hidden lg:inline font-mono text-xs tabular-nums px-1.5 rounded-full bg-ember-500/15 text-ember-300">{draftCount}</span>
            )}
          </button>
        );
      })}
      </div>

      {running && (
        <button type="button" onClick={onOpenLogger} className="w-full text-left rounded-xl border border-ember-500/25 bg-ember-500/[0.06] p-2.5 space-y-1.5 hover:border-ember-500/50 transition-colors" title="Open logs">
          <span className="hidden lg:block text-xs text-ink-200 truncate">{running.title}</span>
          <span className="hidden lg:block font-mono text-xs text-ember-300 truncate">{running.stageLabel || running.currentStage}</span>
          <span className="block h-1 rounded-full bg-ink-800 overflow-hidden">
            {pct === null
              ? <span className="block h-full w-1/3 bg-ember-500 animate-pulse" />
              : <span className="block h-full bg-ember-500 transition-[width] duration-500" style={{ width: `${pct}%` }} />}
          </span>
        </button>
      )}

      <div className="border-t border-ink-800 pt-3 mt-2 space-y-3">
        <PipelineControls status={status} isRunning={isRunning} onControlAction={onControlAction} />

        <AntigravityAccount />
        <ClaudeAccount />

        <div className="flex items-center justify-center lg:justify-between gap-2 px-1" title={`Narrative Engine: ${service?.status || 'checking'}`}>
          <span className="flex items-center gap-1.5">
            <Cpu className={`w-3.5 h-3.5 ${online ? 'text-emerald-400' : 'text-ink-600'}`} aria-hidden="true" />
            <span className={`hidden lg:inline font-mono text-xs ${online ? 'text-ink-300' : 'text-ink-500'}`}>
              {service ? (online ? (service.nvenc_accelerated ? 'NVENC ON' : 'Online') : 'Offline') : '…'}
            </span>
          </span>
          <button type="button" onClick={onRefresh} className="hidden lg:flex h-8 w-8 items-center justify-center rounded-lg text-ink-400 hover:text-ink-100 hover:bg-ink-850" aria-label="Refresh dashboard data" title="Refresh dashboard data">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        <button
          type="button"
          onClick={onToggleLogger}
          aria-label={`Logs${logCount ? ` ${logCount}` : ''}`}
          title="Toggle live execution logs"
          className={`w-full flex items-center justify-center lg:justify-start gap-2 h-9 px-2.5 rounded-lg text-xs font-mono border transition-colors ${
            isLoggerOpen ? 'bg-ink-800 border-ink-700 text-ember-400'
              : isRunning ? 'bg-ember-500/10 border-ember-500/30 text-ember-300'
              : 'border-transparent text-ink-400 hover:text-ink-200 hover:bg-ink-850'
          }`}
        >
          <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="hidden lg:inline flex-1 text-left">Logs</span>
          {logCount > 0 && <span className="hidden lg:inline px-1.5 rounded-full text-xs tabular-nums bg-ink-800 text-ink-400">{logCount}</span>}
        </button>
      </div>
    </nav>
  );
}
