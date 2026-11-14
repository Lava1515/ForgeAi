import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Copy,
  Check,
  Search,
  RotateCcw,
  Sparkles,
  Mic,
  Info,
  Clock,
  Radio,
  FileText,
} from 'lucide-react';
import PageHeader from '../ui/PageHeader.jsx';
import Panel from '../ui/Panel.jsx';
import Button from '../ui/Button.jsx';
import Badge, { StatusDot } from '../ui/Badge.jsx';
import Banner from '../ui/Banner.jsx';
import EmptyState from '../ui/EmptyState.jsx';

function formatDuration(sec) {
  if (typeof sec !== 'number' || Number.isNaN(sec) || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

export default function Voices() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [voicesData, setVoicesData] = useState(null);
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('all'); // all, native, accents, male, female
  const [sortBy, setSortBy] = useState('default'); // default, name, duration
  const [showScript, setShowScript] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [copiedScript, setCopiedScript] = useState(false);

  // Preferred voice state
  const [preferredVoice, setPreferredVoice] = useState(() => {
    try {
      return localStorage.getItem('forgeai_preferred_voice') || 'ryan';
    } catch {
      return 'ryan';
    }
  });

  // Audio playback state
  const [playingVoiceId, setPlayingVoiceId] = useState(null);
  const [playbackTime, setPlaybackTime] = useState({}); // { [id]: { current: number, duration: number } }
  const [isMuted, setIsMuted] = useState(false);
  const audioRef = useRef(null);
  const progressIntervalRef = useRef(null);

  const fetchVoices = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/voices');
      if (!res.ok) {
        throw new Error(`Failed to load voices (HTTP ${res.status})`);
      }
      const data = await res.json();
      setVoicesData(data);
    } catch (err) {
      console.error('[Voices] Failed to fetch voice data:', err);
      setError(err.message || 'Failed to load voices');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVoices();
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
    };
  }, []);

  const handleSelectPreferred = (id) => {
    setPreferredVoice(id);
    try {
      localStorage.setItem('forgeai_preferred_voice', id);
    } catch {}
  };

  const handleCopyId = (id) => {
    navigator.clipboard.writeText(id).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleCopyScript = () => {
    if (voicesData?.script) {
      navigator.clipboard.writeText(voicesData.script).catch(() => {});
      setCopiedScript(true);
      setTimeout(() => setCopiedScript(false), 2000);
    }
  };

  const handleTogglePlay = (voice) => {
    const isCurrentlyPlaying = playingVoiceId === voice.id;

    if (isCurrentlyPlaying) {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      setPlayingVoiceId(null);
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
      return;
    }

    // Start playing new voice
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
    }

    const audio = new Audio(voice.sampleUrl || `/api/voices/${voice.id}/sample`);
    audio.muted = isMuted;
    audioRef.current = audio;

    audio.onloadedmetadata = () => {
      setPlaybackTime((prev) => ({
        ...prev,
        [voice.id]: {
          current: 0,
          duration: audio.duration || voice.seconds || 0,
        },
      }));
    };

    audio.onended = () => {
      setPlayingVoiceId(null);
      setPlaybackTime((prev) => ({
        ...prev,
        [voice.id]: {
          current: 0,
          duration: prev[voice.id]?.duration || voice.seconds || 0,
        },
      }));
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    };

    audio.onerror = (e) => {
      console.error('[Voices] Audio playback error:', e);
      setPlayingVoiceId(null);
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    };

    audio.play()
      .then(() => {
        setPlayingVoiceId(voice.id);
        progressIntervalRef.current = setInterval(() => {
          if (audioRef.current) {
            setPlaybackTime((prev) => ({
              ...prev,
              [voice.id]: {
                current: audioRef.current.currentTime,
                duration: audioRef.current.duration || voice.seconds || 0,
              },
            }));
          }
        }, 100);
      })
      .catch((err) => {
        console.error('[Voices] Play was blocked or failed:', err);
        setPlayingVoiceId(null);
      });
  };

  const handleSeek = (voiceId, newTimeRatio) => {
    if (audioRef.current && playingVoiceId === voiceId && audioRef.current.duration) {
      const targetTime = audioRef.current.duration * newTimeRatio;
      audioRef.current.currentTime = targetTime;
      setPlaybackTime((prev) => ({
        ...prev,
        [voiceId]: {
          ...prev[voiceId],
          current: targetTime,
        },
      }));
    }
  };

  const handleToggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (audioRef.current) {
      audioRef.current.muted = nextMuted;
    }
  };

  // Filter and sort voices
  const filteredVoices = useMemo(() => {
    if (!voicesData?.voices) return [];
    let list = [...voicesData.voices];

    // Filter by search query
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((v) => (
        v.name.toLowerCase().includes(q) ||
        v.id.toLowerCase().includes(q) ||
        v.accent.toLowerCase().includes(q) ||
        v.description.toLowerCase().includes(q) ||
        v.traits?.some((t) => t.toLowerCase().includes(q)) ||
        v.bestFor?.some((b) => b.toLowerCase().includes(q))
      ));
    }

    // Filter by category
    if (filterCategory === 'native') {
      list = list.filter((v) => v.accent.toLowerCase().includes('native'));
    } else if (filterCategory === 'accents') {
      list = list.filter((v) => !v.accent.toLowerCase().includes('native'));
    } else if (filterCategory === 'male') {
      list = list.filter((v) => v.gender === 'male');
    } else if (filterCategory === 'female') {
      list = list.filter((v) => v.gender === 'female');
    }

    // Sort
    if (sortBy === 'name') {
      list.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortBy === 'duration') {
      list.sort((a, b) => (b.seconds || 0) - (a.seconds || 0));
    } else {
      // default: ryan first, then others
      list.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
    }

    return list;
  }, [voicesData, search, filterCategory, sortBy]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Voice Library"
        title="Qwen Voices"
        badge={
          <Badge tone="accent">
            {voicesData?.totalVoices || 9} Speakers
          </Badge>
        }
        subtitle="Browse and listen to the 9 built-in speakers from Qwen3-TTS. Pre-rendered samples were recorded under standard narration conditions on local GPU."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={fetchVoices}
              disabled={loading}
              title="Refresh voice samples"
            >
              <RotateCcw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            <Button
              variant={showScript ? 'primary' : 'secondary'}
              onClick={() => setShowScript(!showScript)}
              title="View sample narration script"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Sample Script</span>
            </Button>
          </div>
        }
      />

      {error && (
        <Banner
          tone="error"
          title="Error loading voices"
          action={
            <button
              type="button"
              onClick={fetchVoices}
              className="text-xs font-medium text-rose-300 hover:text-rose-100 underline"
            >
              Retry
            </button>
          }
        >
          {error}
        </Banner>
      )}

      {/* Model & Licensing Info Card */}
      <Panel className="bg-ink-900/60 border border-ink-800">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-ink-100 text-sm">Active Model</span>
              <Badge tone="accent">Apache-2.0</Badge>
              <Badge tone="neutral">Local CUDA</Badge>
            </div>
            <p className="text-xs font-mono text-ink-400 break-all">
              {voicesData?.model || 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice'}
            </p>
            <p className="text-xs text-ink-400">
              Commercial monetization allowed. Recorded in{' '}
              <code className="text-ink-300">licenses/register.json</code>. No paid APIs or external network calls.
            </p>
          </div>
          <div className="flex sm:flex-col items-center sm:items-end justify-between gap-2 shrink-0">
            <div className="text-right">
              <span className="text-[11px] text-ink-500 uppercase tracking-wider block">Preferred Voice</span>
              <span className="text-xs font-mono font-medium text-ember-300 capitalize">{preferredVoice}</span>
            </div>
          </div>
        </div>

        {/* Collapsible Sample Script */}
        {showScript && voicesData?.script && (
          <div className="mt-4 pt-4 border-t border-ink-800 space-y-2">
            <div className="flex items-center justify-between text-xs text-ink-400">
              <span className="font-medium text-ink-200">Standard Test Passage (20s Target)</span>
              <button
                type="button"
                onClick={handleCopyScript}
                className="inline-flex items-center gap-1 text-ink-400 hover:text-ember-300 transition-colors"
                title="Copy script"
              >
                {copiedScript ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedScript ? 'Copied' : 'Copy script'}</span>
              </button>
            </div>
            <p className="text-xs text-ink-300 italic bg-ink-950/70 p-3 rounded-lg border border-ink-800/80 leading-relaxed font-serif">
              &ldquo;{voicesData.script}&rdquo;
            </p>
          </div>
        )}
      </Panel>

      {/* Search and Filters */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-ink-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, accent, tone, or genre..."
            className="w-full bg-ink-900 border border-ink-700/80 rounded-xl pl-9 pr-8 py-2 text-xs text-ink-100 placeholder-ink-500 focus:outline-none focus:border-ember-500/50"
            aria-label="Search voices"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-200 text-xs px-1"
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Category Chips */}
          <div className="inline-flex rounded-lg bg-ink-900 border border-ink-800 p-0.5 text-xs">
            {[
              { id: 'all', label: 'All' },
              { id: 'native', label: 'Native' },
              { id: 'accents', label: 'Accents' },
              { id: 'male', label: 'Male' },
              { id: 'female', label: 'Female' },
            ].map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setFilterCategory(cat.id)}
                className={`px-2.5 py-1 rounded-md transition-colors ${
                  filterCategory === cat.id
                    ? 'bg-ink-800 text-ember-300 font-medium'
                    : 'text-ink-400 hover:text-ink-200'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Sort Selector */}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="bg-ink-900 border border-ink-800 rounded-lg px-2.5 py-1 text-xs text-ink-300 focus:outline-none focus:border-ink-700"
            aria-label="Sort voices"
          >
            <option value="default">Sort: Default</option>
            <option value="name">Sort: Name (A-Z)</option>
            <option value="duration">Sort: Duration</option>
          </select>

          {/* Mute toggle button */}
          <button
            type="button"
            onClick={handleToggleMute}
            className={`p-2 rounded-lg border transition-colors ${
              isMuted
                ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                : 'bg-ink-900 border-ink-800 text-ink-400 hover:text-ink-200'
            }`}
            title={isMuted ? 'Unmute preview' : 'Mute preview'}
            aria-label={isMuted ? 'Unmute preview' : 'Mute preview'}
          >
            {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Voices Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-56 rounded-2xl bg-ink-900/40 border border-ink-800/60 animate-pulse p-5" />
          ))}
        </div>
      ) : filteredVoices.length === 0 ? (
        <EmptyState
          icon={Mic}
          title="No voices found"
          description={search ? `No voices matched "${search}". Try clearing your filter.` : 'No voice samples available.'}
          action={
            search ? (
              <Button variant="secondary" onClick={() => { setSearch(''); setFilterCategory('all'); }}>
                Reset search
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredVoices.map((voice) => {
            const isPlaying = playingVoiceId === voice.id;
            const isPreferred = preferredVoice === voice.id;
            const timeInfo = playbackTime[voice.id] || { current: 0, duration: voice.seconds || 0 };
            const duration = timeInfo.duration || voice.seconds || 0;
            const progressRatio = duration > 0 ? Math.min(1, Math.max(0, timeInfo.current / duration)) : 0;

            return (
              <div
                key={voice.id}
                className={`relative flex flex-col justify-between rounded-2xl border transition-all duration-200 p-5 ${
                  isPlaying
                    ? 'bg-ink-900/90 border-ember-500/40 shadow-lg shadow-ember-500/5'
                    : isPreferred
                    ? 'bg-ink-900/70 border-ember-500/25 hover:border-ink-700'
                    : 'bg-ink-900/50 border-ink-800 hover:border-ink-700 hover:bg-ink-900/70'
                }`}
              >
                {/* Card Top: Name, ID, Badges */}
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold text-base text-ink-50 truncate">{voice.name}</h3>
                        <button
                          type="button"
                          onClick={() => handleCopyId(voice.id)}
                          className="font-mono text-[11px] text-ink-400 hover:text-ember-300 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-ink-950 border border-ink-800 transition-colors"
                          title="Click to copy voice ID"
                        >
                          <span>{voice.id}</span>
                          {copiedId === voice.id ? (
                            <Check className="w-3 h-3 text-emerald-400" />
                          ) : (
                            <Copy className="w-3 h-3 text-ink-500" />
                          )}
                        </button>
                      </div>
                      <div className="flex items-center gap-1.5 mt-1">
                        <Badge tone="neutral" className="text-[10px]">
                          {voice.gender}
                        </Badge>
                        <Badge tone={voice.accent.includes('Native') ? 'accent' : 'neutral'} className="text-[10px]">
                          {voice.accent}
                        </Badge>
                        {voice.isDefault && (
                          <Badge tone="accent" className="text-[10px]">
                            Default
                          </Badge>
                        )}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleSelectPreferred(voice.id)}
                      className={`text-xs px-2 py-1 rounded-lg border transition-colors shrink-0 ${
                        isPreferred
                          ? 'bg-ember-500/15 border-ember-500/30 text-ember-300 font-medium'
                          : 'bg-ink-950/60 border-ink-800 text-ink-400 hover:text-ink-200 hover:border-ink-700'
                      }`}
                      title={isPreferred ? 'Current preferred voice' : 'Set as preferred voice'}
                    >
                      {isPreferred ? 'Preferred' : 'Select'}
                    </button>
                  </div>

                  {/* Description */}
                  <p className="text-xs text-ink-300 leading-relaxed line-clamp-2">
                    {voice.description}
                  </p>

                  {/* Best For Tags */}
                  {Array.isArray(voice.bestFor) && voice.bestFor.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {voice.bestFor.map((tag) => (
                        <span
                          key={tag}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-ink-950/80 text-ink-400 border border-ink-800/80"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Card Middle: Audio Player */}
                <div className="mt-4 pt-3 border-t border-ink-800/80 space-y-2">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => handleTogglePlay(voice)}
                      className={`w-9 h-9 rounded-xl flex items-center justify-center transition-transform active:scale-95 shrink-0 ${
                        isPlaying
                          ? 'bg-ember-500 text-ink-950 shadow-md shadow-ember-500/20'
                          : 'bg-ember-500/15 hover:bg-ember-500/25 text-ember-300 border border-ember-500/30'
                      }`}
                      aria-label={isPlaying ? `Pause sample for ${voice.name}` : `Play sample for ${voice.name}`}
                    >
                      {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 ml-0.5 fill-current" />}
                    </button>

                    <div className="flex-1 min-w-0 space-y-1">
                      {/* Scrubber track */}
                      <div
                        className="relative h-2 bg-ink-950 rounded-full cursor-pointer overflow-hidden group border border-ink-800/60"
                        onClick={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const ratio = (e.clientX - rect.left) / rect.width;
                          handleSeek(voice.id, ratio);
                        }}
                      >
                        <div
                          className={`h-full transition-[width] duration-100 ${
                            isPlaying ? 'bg-ember-500' : 'bg-ink-700'
                          }`}
                          style={{ width: `${progressRatio * 100}%` }}
                        />
                      </div>

                      <div className="flex items-center justify-between text-[11px] text-ink-400 font-mono">
                        <span>{isPlaying ? formatDuration(timeInfo.current) : '0:00'}</span>
                        <span>{formatDuration(voice.seconds || duration)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Card Bottom Meta: Sample Rate and Wall Time */}
                  <div className="flex items-center justify-between text-[10px] text-ink-500 pt-1 font-mono">
                    <span className="flex items-center gap-1">
                      <Radio className="w-3 h-3 text-ink-600" />
                      {(voice.sampleRate || 24000) / 1000} kHz WAV
                    </span>
                    {voice.wallSeconds && (
                      <span title="Generation wall time for this sample">
                        {voice.wallSeconds}s gen time
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
