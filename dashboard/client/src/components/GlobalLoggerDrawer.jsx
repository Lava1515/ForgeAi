import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Terminal, 
  X, 
  Copy, 
  Check, 
  Trash2, 
  Search, 
  Filter, 
  ArrowDown, 
  AlertCircle, 
  CheckCircle2, 
  Clock,
  RefreshCw
} from 'lucide-react';
import usePersisted from '../usePersisted.js';

const SOURCE_FILTERS = ['ALL', 'GEMINI', 'COMFYUI', 'TTS', 'EDITOR', 'RESEARCH', 'PACKAGER', 'WARN/ERR'];
const DEFAULT_WIDTH = 540;
const MIN_WIDTH = 340;

export default function GlobalLoggerDrawer({
  isOpen,
  onClose,
  logs = [],
  tasks = [],
  onClearLogs,
  isRunning = false,
}) {
  const [selectedTaskId, setSelectedTaskId] = useState('all');
  const [selectedSource, setSelectedSource] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  // Normal mode hides debug lines (prompts, ffmpeg commands, per-sentence TTS detail)
  const [showDebug, setShowDebug] = usePersisted('app.loggerDebug', false);

  // Persisted panel width for side-by-side view
  const [width, setWidth] = usePersisted('app.loggerWidth', DEFAULT_WIDTH);
  const [isDragging, setIsDragging] = useState(false);

  const startXRef = useRef(0);
  const startWidthRef = useRef(width);
  const scrollRef = useRef(null);

  // Responsive check for small viewports (<768px falls back to slide-over)
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < 768;
  });

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Compute effective width constrained to viewport
  const effectiveWidth = useMemo(() => {
    if (typeof window === 'undefined') return width;
    const maxAllowedWidth = Math.max(MIN_WIDTH, Math.min(1200, Math.floor(window.innerWidth * 0.75)));
    return Math.max(MIN_WIDTH, Math.min(maxAllowedWidth, width));
  }, [width]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Filter logs based on task, source, and search query
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (!showDebug && log.level === 'debug') return false;

      // 1. Task filter
      if (selectedTaskId !== 'all') {
        const logRunId = log.run_id || 'system';
        if (selectedTaskId === 'system') {
          if (logRunId !== 'system' && logRunId !== 'sys') return false;
        } else if (logRunId !== selectedTaskId) {
          return false;
        }
      }

      // 2. Source filter
      if (selectedSource !== 'ALL') {
        const src = (log.source || 'SYS').toUpperCase();
        if (selectedSource === 'WARN/ERR') {
          if (src !== 'ERROR' && log.level !== 'error' && log.level !== 'warn') return false;
        } else if (src !== selectedSource) {
          return false;
        }
      }

      // 3. Search query filter
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const msg = (log.message || '').toLowerCase();
        const src = (log.source || '').toLowerCase();
        const taskTitle = (log.taskTitle || '').toLowerCase();
        if (!msg.includes(query) && !src.includes(query) && !taskTitle.includes(query)) {
          return false;
        }
      }

      return true;
    });
  }, [logs, selectedTaskId, selectedSource, searchQuery, showDebug]);

  // When drawer opens, reset scrolled-up state and jump to latest logs at the bottom
  useEffect(() => {
    if (isOpen) {
      setIsScrolledUp(false);
      const timer = setTimeout(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Handle auto-scrolling
  useEffect(() => {
    if (isOpen && autoScroll && !isScrolledUp && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [filteredLogs, isOpen, autoScroll, isScrolledUp]);

  // Detect when user manually scrolls up
  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const distanceToBottom = scrollHeight - (scrollTop + clientHeight);
    const scrolledUp = distanceToBottom > 80;
    setIsScrolledUp(scrolledUp);
  };

  const scrollToBottom = () => {
    setIsScrolledUp(false);
    setAutoScroll(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  };

  // Dragging handlers for resizing side-by-side panel
  const handlePointerDown = (e) => {
    e.preventDefault();
    startXRef.current = e.clientX;
    startWidthRef.current = effectiveWidth;
    setIsDragging(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // fallback if capture not available
    }
  };

  const handlePointerMove = (e) => {
    if (!isDragging) return;
    // Dragging handle towards left expands the right-docked panel
    const deltaX = startXRef.current - e.clientX;
    const newWidth = startWidthRef.current + deltaX;
    const maxAllowedWidth = Math.max(MIN_WIDTH, Math.min(1200, Math.floor(window.innerWidth * 0.75)));
    const clamped = Math.max(MIN_WIDTH, Math.min(maxAllowedWidth, newWidth));
    setWidth(clamped);
  };

  const handlePointerUp = (e) => {
    if (isDragging) {
      setIsDragging(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
  };

  // Global safety listener when dragging
  useEffect(() => {
    if (!isDragging) return;
    const onGlobalUp = () => setIsDragging(false);
    window.addEventListener('pointerup', onGlobalUp);
    return () => window.removeEventListener('pointerup', onGlobalUp);
  }, [isDragging]);

  // Prevent text selection across the window while dragging
  useEffect(() => {
    if (isDragging) {
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    } else {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
    return () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isDragging]);

  const handleCopyLogs = () => {
    const text = filteredLogs
      .map((l) => `[${l.timestamp || ''}] [${(l.level || 'info').toUpperCase()}] [${l.taskTitle || l.run_id || 'SYS'}] [${l.source || 'SYS'}] ${l.message || ''}`)
      .join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getSourceBadge = (source = 'SYS') => {
    const s = source.toUpperCase();
    switch (s) {
      case 'GEMINI':
      case 'RESEARCH':
        return 'bg-ink-800 text-ink-200 border-ink-700';
      case 'CREATIVE':
        return 'bg-ember-500/10 text-ember-300 border-ember-500/30';
      case 'COMFYUI':
        return 'bg-amber-500/10 text-amber-400 border-amber-500/30';
      case 'TTS':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
      case 'PACKAGER':
        return 'bg-ember-500/10 text-ember-300 border-ember-500/30';
      case 'ERROR':
        return 'bg-rose-500/10 text-rose-400 border-rose-500/30';
      case 'STAGE':
        return 'bg-ink-800 text-ink-100 border-ink-700';
      default:
        return 'bg-ink-800 text-ink-400 border-ink-700/50';
    }
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case 'running':
        return <RefreshCw className="w-3 h-3 text-ember-400 animate-spin" />;
      case 'completed':
        return <CheckCircle2 className="w-3 h-3 text-emerald-400" />;
      case 'failed':
        return <AlertCircle className="w-3 h-3 text-rose-400" />;
      default:
        return <Clock className="w-3 h-3 text-ink-500" />;
    }
  };

  if (!isOpen) return null;

  // The inner drawer / panel content (shared between desktop side-by-side & mobile overlay)
  const panelContent = (
    <div className="flex-1 flex flex-col min-h-0 bg-ink-950 overflow-hidden">
      {/* Drawer Header */}
      <div className="px-4 sm:px-5 py-3.5 bg-ink-900/70 border-b border-ink-800/80 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-ember-500/10 border border-ember-500/20 flex items-center justify-center shrink-0">
            <Terminal className="w-4 h-4 text-ember-400" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold tracking-tight text-ink-50 truncate">
                Logs
              </h2>
              {isRunning && (
                <span className="flex items-center gap-1 font-mono text-[10px] text-ember-300 bg-ember-500/10 px-2 py-0.5 rounded-full border border-ember-500/30 shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-ember-400 animate-pulse" />
                  LIVE
                </span>
              )}
            </div>
            <p className="text-[11px] text-ink-400 font-mono truncate">
              {filteredLogs.length} of {logs.length} events logged
            </p>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="flex items-center gap-1 shrink-0 ml-2">
          <button
            type="button"
            onClick={handleCopyLogs}
            disabled={filteredLogs.length === 0}
            className="p-1.5 rounded-lg text-ink-400 hover:text-ink-100 hover:bg-ink-800 transition disabled:opacity-40"
            title="Copy filtered logs"
            aria-label="Copy filtered logs"
          >
            {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={onClearLogs}
            disabled={logs.length === 0}
            className="p-1.5 rounded-lg text-ink-400 hover:text-rose-400 hover:bg-ink-800 transition disabled:opacity-40"
            title="Clear all logs"
            aria-label="Clear all logs"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <div className="h-4 w-px bg-ink-800 mx-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close telemetry drawer"
            className="p-1.5 rounded-lg text-ink-400 hover:text-ink-100 hover:bg-ink-800 transition"
            title="Close logs panel (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Filtering Controls */}
      <div className="px-4 sm:px-5 py-3 bg-ink-900/30 border-b border-ink-800/80 space-y-2.5 shrink-0">
        {/* Task Selector & Search */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {/* Task Dropdown */}
          <div className="relative">
            <select
              value={selectedTaskId}
              onChange={(e) => setSelectedTaskId(e.target.value)}
              className="w-full bg-ink-950 border border-ink-800 rounded-lg px-2.5 py-1.5 text-xs text-ink-200 font-mono focus:outline-none focus:border-ember-500/60 transition appearance-none cursor-pointer pr-7"
            >
              <option value="all">All tasks ({logs.length})</option>
              <option value="system">System</option>
              {tasks.map((task) => {
                const taskId = task.id || task.run_id;
                return (
                  <option key={taskId} value={taskId}>
                    {task.status === 'running' ? '● ' : task.status === 'failed' ? '✕ ' : ''}{task.title}
                  </option>
                );
              })}
            </select>
            <div className="absolute right-2 top-2 pointer-events-none text-ink-500">
              <Filter className="w-3.5 h-3.5" />
            </div>
          </div>

          {/* Search Input */}
          <div className="relative">
            <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-ink-500" />
            <input
              type="text"
              placeholder="Search logs"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-ink-950 border border-ink-800 rounded-lg pl-7 pr-7 py-1.5 text-xs text-ink-200 placeholder:text-ink-600 focus:outline-none focus:border-ember-500/60 transition font-mono"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-2 text-ink-500 hover:text-ink-300"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Source Badges Row */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]">
          <span className="text-[10px] font-mono text-ink-500 uppercase tracking-wider mr-0.5 shrink-0">Source:</span>
          {SOURCE_FILTERS.map((src) => {
            const isActive = selectedSource === src;
            return (
              <button
                key={src}
                type="button"
                onClick={() => setSelectedSource(src)}
                className={`h-6 px-2 rounded text-[10px] font-mono transition shrink-0 ${
                  isActive
                    ? 'bg-ember-500/15 border border-ember-500/50 text-ember-200'
                    : 'bg-ink-900 border border-ink-800 text-ink-400 hover:text-ink-200 hover:border-ink-700'
                }`}
              >
                {src}
              </button>
            );
          })}
        </div>
      </div>

      {/* Active Task Banner (if a single task is selected) */}
      {selectedTaskId !== 'all' && selectedTaskId !== 'system' && (() => {
        const currentTask = tasks.find(t => (t.id || t.run_id) === selectedTaskId);
        if (!currentTask) return null;
        return (
          <div className="px-4 sm:px-5 py-2 bg-ink-900/40 border-b border-ink-800/80 flex items-center justify-between text-xs font-mono shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              {getStatusIcon(currentTask.status)}
              <span className="text-ink-200 font-medium truncate">{currentTask.title}</span>
              <span className="text-ink-500 text-[10px]">[{currentTask.currentStage || currentTask.status}]</span>
            </div>
            <button
              type="button"
              onClick={() => setSelectedTaskId('all')}
              className="text-[11px] text-ember-400 hover:underline shrink-0 ml-2"
            >
              View all
            </button>
          </div>
        );
      })()}

      {/* Log Stream Output Area */}
      <div 
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 p-3 sm:p-4 font-mono text-xs overflow-y-auto space-y-1.5 select-text bg-ink-950"
      >
        {filteredLogs.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-ink-500 text-center py-12 px-6">
            <Terminal className="w-9 h-9 mb-2.5 opacity-25 text-ink-400" />
            <p className="text-ink-300 font-medium">No logs yet</p>
            <p className="text-[11px] text-ink-500 mt-1 max-w-xs">
              {searchQuery || selectedSource !== 'ALL' || selectedTaskId !== 'all'
                ? 'Nothing matches these filters.'
                : 'Start a Studio video or a Shorts batch and its logs stream in here.'}
            </p>
            {(searchQuery || selectedSource !== 'ALL' || selectedTaskId !== 'all') && (
              <button
                type="button"
                onClick={() => {
                  setSelectedTaskId('all');
                  setSelectedSource('ALL');
                  setSearchQuery('');
                }}
                className="mt-3 px-2.5 py-1 text-xs bg-ink-900 hover:bg-ink-800 text-ink-300 rounded-lg border border-ink-800 transition"
              >
                Reset all filters
              </button>
            )}
          </div>
        ) : (
          filteredLogs.map((log, idx) => {
            const timeStr = log.timestamp 
              ? new Date(log.timestamp).toLocaleTimeString() 
              : new Date().toLocaleTimeString();

            return (
              <div 
                key={log.id || idx} 
                className="flex flex-wrap items-start gap-x-2 gap-y-1 leading-relaxed hover:bg-ink-900/60 px-2 py-1 rounded transition group border border-transparent hover:border-ink-800/40"
              >
                <span className="text-ink-500 text-[11px] shrink-0 font-mono select-none pt-0.5">
                  {timeStr}
                </span>

                {/* Task badge if viewing all */}
                {selectedTaskId === 'all' && log.taskTitle && (
                  <span 
                    title={`Task: ${log.taskTitle}`}
                    className="text-[9.5px] max-w-[85px] truncate text-ink-400 bg-ink-900/80 px-1.5 py-0.5 rounded border border-ink-800 shrink-0 font-mono"
                  >
                    {log.taskTitle}
                  </span>
                )}

                {/* Python logger names (qwen_tts.core.models...) are long; show the last segment */}
                <span
                  title={log.source || 'SYS'}
                  className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded border shrink-0 max-w-[110px] truncate font-mono ${getSourceBadge(log.source)}`}
                >
                  {(log.source || 'SYS').split('.').pop()}
                </span>

                {/* Below 14rem of room the message wraps under the badges at full width */}
                <span className={`[overflow-wrap:anywhere] whitespace-pre-wrap flex-1 min-w-[14rem] ${
                  log.source === 'ERROR' || log.level === 'error'
                    ? 'text-rose-300'
                    : log.level === 'warn'
                      ? 'text-amber-300'
                      : log.level === 'debug'
                        ? 'text-ink-500'
                        : log.source === 'STAGE'
                          ? 'text-ink-50 font-medium'
                          : 'text-ink-200'
                }`}>
                  {log.message}
                </span>
              </div>
            );
          })
        )}
      </div>

      {/* Footer Bar: Auto-Scroll controls & Jump to Bottom */}
      <div className="px-4 sm:px-5 py-2.5 bg-ink-900/80 border-t border-ink-800/80 flex items-center justify-between shrink-0 text-xs font-mono text-ink-400">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="accent-ember-500 rounded"
          />
          <span className="text-[11px]">Auto-scroll</span>
        </label>

        <label className="flex items-center gap-2 cursor-pointer select-none" title="Also show debug lines: prompts, ffmpeg commands, per-sentence TTS detail">
          <input
            type="checkbox"
            checked={showDebug}
            onChange={(e) => setShowDebug(e.target.checked)}
            className="accent-ember-500 rounded"
          />
          <span className="text-[11px]">Debug logs</span>
        </label>

        {isScrolledUp && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-ember-500/10 hover:bg-ember-500/20 text-ember-300 border border-ember-500/30 text-[11px] transition"
          >
            <ArrowDown className="w-3 h-3" />
            <span>To bottom</span>
          </button>
        )}

      </div>
    </div>
  );

  // Mobile mode: Slide-over drawer overlay (no backdrop blur)
  if (isMobile) {
    return (
      <div className="fixed inset-0 z-50 overflow-hidden md:hidden">
        <div 
          className="fixed inset-0 bg-black/60 transition-opacity animate-in fade-in duration-200"
          onClick={onClose}
          aria-hidden="true"
        />
        <div className="fixed inset-y-0 right-0 max-w-full flex">
          <div className="w-screen max-w-md bg-ink-950 border-l border-ink-800 shadow-2xl flex flex-col animate-in slide-in-from-right duration-300">
            {panelContent}
          </div>
        </div>
      </div>
    );
  }

  // Desktop mode: Docked side-by-side panel with interactive draggable resize handle
  return (
    <aside 
      aria-label="Logs"
      style={{ width: `${effectiveWidth}px` }}
      className={`relative self-stretch h-full shrink-0 flex flex-col bg-ink-950 border-l border-ink-800 z-30 transition-[width] duration-75 ease-out ${
        isDragging ? 'select-none !transition-none' : ''
      }`}
    >
      {/* Draggable resize handle on the left edge */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize logs panel"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
        className="absolute -left-2 top-0 bottom-0 w-4 cursor-col-resize z-40 group flex items-center justify-center select-none"
        title="Drag to resize width · Double-click to reset"
      >
        <div 
          className={`w-1 h-14 rounded-full transition-all ${
            isDragging 
              ? 'bg-ember-400 h-20 shadow-[0_0_8px_rgba(255,90,31,0.8)]' 
              : 'bg-ink-700/60 group-hover:bg-ember-500/80 group-hover:h-16'
          }`} 
        />
      </div>

      {panelContent}
    </aside>
  );
}
