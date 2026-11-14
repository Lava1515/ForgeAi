import React, { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar.jsx';
import MobileNav from './components/MobileNav.jsx';
import Library from './components/Library.jsx';
import Insights from './components/Insights.jsx';
import NewVideo from './components/episode/NewVideo.jsx';
import Voices from './components/Voices.jsx';
import GlobalLoggerDrawer from './components/GlobalLoggerDrawer.jsx';
import ChannelModal from './components/ChannelModal.jsx';
import Banner from './ui/Banner.jsx';
import { isNavId, navHostOf, resolveNavHash, DEFAULT_TAB } from './nav.js';
import { channelListFrom } from './components/channelList.js';
import * as api from './services/api.js';
import usePersisted from './usePersisted.js';

export default function App() {
  // The hash is local to this browser tab, so each window can stay on its own view. Without a hash, sessionStorage restores the last tab.
  const [storedTab, setStoredTab] = usePersisted('app.activeTab', DEFAULT_TAB, { storage: 'session', syncTabs: false });
  const [activeTab, setActiveTabState] = useState(() => resolveNavHash(window.location.hash || storedTab));

  const setActiveTab = (tab) => {
    const nextTab = typeof tab === 'function' ? tab(activeTab) : tab;
    if (!isNavId(nextTab)) return;
    setActiveTabState(nextTab);
    setStoredTab(nextTab);
    const nextHash = `#/${nextTab}`;
    if (window.location.hash !== nextHash) window.location.hash = nextHash;
  };

  useEffect(() => {
    const syncFromHash = () => {
      const nextTab = resolveNavHash(window.location.hash || storedTab);
      setActiveTabState(nextTab);
      if (window.location.hash !== `#/${nextTab}`) {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/${nextTab}`);
      }
    };
    syncFromHash();
    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, []);

  const [isLoggerOpen, setIsLoggerOpen] = usePersisted('app.loggerOpen', false, { storage: 'session', syncTabs: false });
  const [status, setStatus] = useState(null);
  const [logs, setLogs] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [currentStage, setCurrentStage] = usePersisted('app.currentStage', 'idle');
  const [isRunning, setIsRunning] = usePersisted('app.isRunning', false);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null); // status polling clears `error`, so a failed action keeps its own
  const [fallbackNotice, setFallbackNotice] = useState(null);
  const dismissedFallbacksRef = useRef(new Set());
  const fallbackTimerRef = useRef(null);
  const fallbackNoticeRef = useRef(null);
  fallbackNoticeRef.current = fallbackNotice;

  const dismissFallbackNotice = () => {
    const currentFb = fallbackNoticeRef.current;
    if (currentFb?.timestamp) {
      dismissedFallbacksRef.current.add(currentFb.timestamp);
    }
    setFallbackNotice(null);
    fallbackNoticeRef.current = null;
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    api.dismissGeminiFallback().catch(() => {});
  };

  const triggerFallbackNotice = (fb) => {
    if (!fb?.timestamp || dismissedFallbacksRef.current.has(fb.timestamp)) return;
    setFallbackNotice(fb);
    fallbackNoticeRef.current = fb;
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
    }
    // Auto-dismiss once fallback has had time to succeed (and moved to log drawer);
    // real failures will trigger error banner / activeError without being hidden.
    fallbackTimerRef.current = setTimeout(() => {
      dismissFallbackNotice();
    }, 8000);
  };

  useEffect(() => {
    return () => {
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
    };
  }, []);

  // Multi-Account YouTube Channels & Psychology Rules
  const [channels, setChannels] = useState([]);
  const [activeChannel, setActiveChannel] = useState(null);
  const [isChannelModalOpen, setIsChannelModalOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState(null);
  const [channelSwitchCount, setChannelSwitchCount] = useState(0);

  const fetchStatus = async () => {
    try {
      const data = await api.getStatus();
      setStatus(data);
      setError(null);

      if (data?.last_gemini_fallback?.timestamp) {
        const fb = data.last_gemini_fallback;
        const age = Date.now() - new Date(fb.timestamp).getTime();
        if (age < 30 * 1000 && !dismissedFallbacksRef.current.has(fb.timestamp)) {
          triggerFallbackNotice(fb);
        }
      }

      // Reconcile running pipelines with active runs from server
      if (Array.isArray(data?.active_runs)) {
        if (data.active_runs.length > 0) {
          setIsRunning(true);
          const active = data.active_runs[0];
          if (active?.stage) {
            setCurrentStage(active.stage);
          }
          for (const run of data.active_runs) {
            upsertTask(run.run_id, {
              title: run.title || run.run_id,
              status: 'running',
              currentStage: run.stage || 'started',
              stageLabel: run.stageLabel || run.stage,
            });
          }
        } else {
          // If server reports no active runs, mark lingering running tasks complete/idle
          setIsRunning(false);
          setTasks((prev) => {
            if (prev.some((t) => t.status === 'running')) {
              return prev.map((t) => t.status === 'running' ? { ...t, status: 'completed', currentStage: 'completed' } : t);
            }
            return prev;
          });
          if (currentStage !== 'completed' && currentStage !== 'failed') {
            setCurrentStage('idle');
          }
        }
      }
    } catch (err) {
      console.error('Failed to fetch status:', err);
      setError(err.message);
    }
  };

  const fetchChannels = async () => {
    try {
      const data = await api.getChannels();
      const list = channelListFrom(data);
      if (list) {
        setChannels(list);
        const active = list.find(c => c.id === data.active_channel_id) || list[0];
        setActiveChannel(active);
        if (active?.id) {
          api.setActiveChannelId(active.id);
        }
      }
    } catch (err) {
      console.warn('Could not load channels:', err.message);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchChannels();
    const interval = setInterval(() => !document.hidden && fetchStatus(), 4000);
    return () => clearInterval(interval);
  }, []);

  const handleSwitchChannel = async (channelId) => {
    try {
      await api.switchChannel(channelId);
      const found = channels.find(c => c.id === channelId);
      if (found) {
        setActiveChannel(found);
      }
      setChannelSwitchCount(prev => prev + 1);
      try {
        localStorage.setItem('forgeai.channel.activeId', channelId);
      } catch {}
    } catch (err) {
      console.error('Failed to switch channel:', err);
    }
  };

  // Cross-tab synchronization for logs clearing and active channel switching
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === 'forgeai.logs.clearedAt') {
        setLogs([]);
      } else if (e.key === 'forgeai.channel.activeId' && e.newValue) {
        setActiveChannel((prev) => {
          if (prev?.id === e.newValue) return prev;
          const found = channels.find(c => c.id === e.newValue);
          return found || prev;
        });
        setChannelSwitchCount(prev => prev + 1);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [channels]);

  const handleOpenChannelModal = (chan = null) => {
    setEditingChannel(chan);
    setIsChannelModalOpen(true);
  };

  const handleChannelSaved = async (saved) => {
    await fetchChannels();
    if (saved?.id) {
      await handleSwitchChannel(saved.id);
    }
  };

  const handleChannelDeleted = async () => {
    await fetchChannels();
    setChannelSwitchCount(prev => prev + 1);
  };

  // Helper to upsert a task in the HUD queue
  const upsertTask = (runId, patch) => {
    if (!runId) return;
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.run_id === runId);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], ...patch, updated_at: new Date().toISOString() };
        return next;
      }
      const newTask = {
        run_id: runId,
        title: patch.title || runId,
        status: patch.status || 'running',
        currentStage: patch.currentStage || 'started',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...patch,
      };
      return [newTask, ...prev.slice(0, 19)];
    });
  };

  const handleClearLogs = () => {
    setLogs([]);
    try {
      localStorage.setItem('forgeai.logs.clearedAt', Date.now().toString());
    } catch {}
  };

  // Subscribe to live SSE events from the dashboard backend (replays recent buffer so new tabs get live logs)
  useEffect(() => {
    const appendLog = (logEntry) => {
      // ponytail: 2000-line cap so debug mode keeps a whole run; virtualize the list if rendering gets slow
      setLogs((prev) => [...prev.slice(-1999), logEntry]);
    };

    const unsubscribe = api.subscribeEvents((event) => {
      const runId = event.run_id;
      const now = event.timestamp || new Date().toISOString();

      // Ignore replayed logs that occurred prior to user clearing logs
      let isReplayedOldLog = false;
      try {
        const clearedAt = Number(localStorage.getItem('forgeai.logs.clearedAt') || 0);
        if (clearedAt && event.timestamp && new Date(event.timestamp).getTime() <= clearedAt) {
          isReplayedOldLog = true;
        }
      } catch {}

      if (event.type === 'stage_change') {
        setCurrentStage(event.stage);
        if (event.stage === 'completed') {
          setIsRunning(false);
          dismissFallbackNotice();
          upsertTask(runId, {
            status: 'completed',
            currentStage: 'completed',
            stageLabel: event.label || 'Complete',
          });
        } else if (event.stage === 'failed') {
          setIsRunning(false);
          upsertTask(runId, {
            status: 'failed',
            currentStage: 'failed',
            stageLabel: event.label || 'Failed',
            error: event.error,
          });
        } else {
          setIsRunning(true);
          // Auto-dismiss fallback notice once subsequent stage begins execution successfully
          if (fallbackNoticeRef.current && event.stage !== 'stage1_research') {
            dismissFallbackNotice();
          }
          upsertTask(runId, {
            status: 'running',
            currentStage: event.stage,
            stageLabel: event.label,
          });
        }

        if (!isReplayedOldLog) {
          const stageLog = {
            id: `stage-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
            run_id: runId,
            taskTitle: runId,
            source: 'STAGE',
            message: `${event.label || event.stage} (${event.status || 'active'})`,
            timestamp: now,
          };
          appendLog(stageLog);
        }
      } else if (event.type === 'log') {
        if (!isReplayedOldLog) {
          const logEntry = {
            id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
            run_id: runId,
            taskTitle: runId,
            source: event.source || 'SYSTEM',
            level: event.level || 'info',
            message: event.message || '',
            timestamp: now,
          };
          appendLog(logEntry);
        }
      } else if (event.type === 'gemini_fallback') {
        const fb = {
          from_model: event.from_model,
          to_model: event.to_model,
          message: event.message || `Gemini HTTP 503 high demand: switched from ${event.from_model} to ${event.to_model}.`,
          timestamp: event.timestamp || now,
        };
        triggerFallbackNotice(fb);
        if (!isReplayedOldLog) {
          appendLog({
            id: `fb-${Date.now()}`,
            run_id: runId || 'gemini',
            taskTitle: 'Gemini Fallback',
            source: 'GEMINI',
            level: 'warn',
            message: fb.message,
            timestamp: now,
          });
        }
      } else if (event.type === 'complete') {
        setIsRunning(false);
        setCurrentStage('completed');
        dismissFallbackNotice();
        upsertTask(runId, {
          status: 'completed',
          currentStage: 'completed',
          draft_id: event.draft_id,
          title: event.title || runId,
          graphic_url: event.graphic_url,
          video_url: event.video_url,
          audio_url: event.audio_url,
          tags: event.tags,
        });

        if (!isReplayedOldLog) {
          const completeLog = {
            id: `comp-${Date.now()}`,
            run_id: runId,
            taskTitle: runId,
            source: 'COMPLETE',
            message: `Finished: ${event.title || event.draft_id || 'Packaged asset saved to Library.'}`,
            timestamp: now,
          };
          appendLog(completeLog);
        }
        fetchStatus();
      } else if (event.type === 'error') {
        setIsRunning(false);
        setCurrentStage('failed');
        upsertTask(runId, {
          status: 'failed',
          currentStage: 'failed',
          error: event.error,
        });

        if (!isReplayedOldLog) {
          const errorLog = {
            id: `err-${Date.now()}`,
            run_id: runId,
            taskTitle: runId,
            source: 'ERROR',
            level: 'error',
            message: event.message || event.error || event.data?.message || 'Worker reported an execution failure.',
            timestamp: now,
          };
          appendLog(errorLog);
        }
        fetchStatus();
      }
    }, undefined, { replay: true });

    return () => unsubscribe();
  }, []);

  const handleControlAction = async (action, payload = {}) => {
    try {
      setActionError(null);
      const updated = await api.sendControl(action, payload);
      if (updated && typeof updated === 'object') {
        setStatus(updated);
      }
      await fetchStatus();
    } catch (err) {
      console.error(`Failed to execute control action '${action}':`, err);
      setActionError(err.message);
    }
  };

  const handleDismissError = () => {
    setError(null);
    setActionError(null);
  };

  const handleDismissFallback = () => {
    dismissFallbackNotice();
  };

  const activeError = actionError || error;
  const openLogger = () => setIsLoggerOpen(true);

  const host = navHostOf(activeTab);

  return (
    <div className="h-dvh min-w-0 bg-ink-950 text-ink-100 flex flex-col md:flex-row font-sans selection:bg-ember-500/20 selection:text-ember-300 overflow-hidden">
      <MobileNav
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        channels={channels}
        activeChannel={activeChannel}
        onSwitchChannel={handleSwitchChannel}
        onOpenChannelModal={handleOpenChannelModal}
        logCount={logs.length}
        onOpenLogger={openLogger}
      />
      <div className="hidden md:flex min-h-0">
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        status={status}
        isRunning={isRunning}
        tasks={tasks}
        currentStage={currentStage}
        channels={channels}
        activeChannel={activeChannel}
        onSwitchChannel={handleSwitchChannel}
        onOpenChannelModal={handleOpenChannelModal}
        isLoggerOpen={isLoggerOpen}
        onToggleLogger={() => setIsLoggerOpen(!isLoggerOpen)}
        onOpenLogger={openLogger}
        logCount={logs.length}
        onControlAction={handleControlAction}
        onRefresh={() => { fetchStatus(); fetchChannels(); }}
      />
      </div>

      {/* Main Workspace Area (Side-by-side with resizable logger docked to the entire right side) */}
      <div className="flex-1 min-h-0 min-w-0 flex relative overflow-hidden">
        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto min-w-0 transition-all duration-300">
          <div className="max-w-6xl mx-auto min-w-0 px-3 py-4 sm:px-5 md:px-8 md:py-8 space-y-5 md:space-y-6">
            {fallbackNotice && (
              <Banner
                tone="warn"
                title="Gemini High Demand (HTTP 503):"
                action={
                  <button
                    type="button"
                    onClick={handleDismissFallback}
                    className="h-8 min-h-[32px] px-3 text-xs font-medium rounded-lg border transition-colors bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border-amber-500/30 inline-flex items-center justify-center cursor-pointer"
                    aria-label="Dismiss warning"
                  >
                    Dismiss
                  </button>
                }
              >
                {fallbackNotice.message || `Switched from ${fallbackNotice.from_model} to fallback model ${fallbackNotice.to_model}.`}
              </Banner>
            )}

            {activeError && (
              <Banner
                tone="error"
                title="Alert:"
                action={
                  <button
                    type="button"
                    onClick={handleDismissError}
                    className="h-8 min-h-[32px] px-3 text-xs font-medium rounded-lg border transition-colors bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border-rose-500/30 inline-flex items-center justify-center cursor-pointer"
                    aria-label="Dismiss alert"
                  >
                    Dismiss
                  </button>
                }
              >
                {activeError}
              </Banner>
            )}

            {host === 'products' && (
              <div data-host-root="products" className="fade-page">
                <Library section={activeTab} onSection={setActiveTab} channelSwitchCount={channelSwitchCount} />
              </div>
            )}

            {host === 'channel' && (
              <div data-host-root="channel" className="fade-page">
                <Insights section={activeTab} onSection={setActiveTab} channelSwitchCount={channelSwitchCount} activeChannel={activeChannel} />
              </div>
            )}

            {host === 'newvideo' && (
              <div data-host-root="newvideo" className="fade-page">
                <NewVideo />
              </div>
            )}

            {host === 'voices' && (
              <div data-host-root="voices" className="fade-page">
                <Voices />
              </div>
            )}
          </div>
        </main>

        {/* Global Side-by-Side Execution Logger Panel docked to the entire right side */}
        <GlobalLoggerDrawer
          isOpen={isLoggerOpen}
          onClose={() => setIsLoggerOpen(false)}
          logs={logs}
          onClearLogs={handleClearLogs}
          isRunning={isRunning}
          tasks={tasks}
        />
      </div>

      {/* Multi-Account Channel Settings Modal */}
      {isChannelModalOpen && (
        <ChannelModal
          channel={editingChannel}
          onClose={() => {
            setIsChannelModalOpen(false);
            setEditingChannel(null);
          }}
          onSaved={handleChannelSaved}
          onDeleted={handleChannelDeleted}
        />
      )}
    </div>
  );
}
