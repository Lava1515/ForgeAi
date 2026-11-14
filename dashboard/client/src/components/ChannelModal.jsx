import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Tv,
  Sparkles,
  Key,
  Brain,
  Video,
  Mic,
  Save,
  Trash2,
  ExternalLink,
} from 'lucide-react';
import * as api from '../services/api.js';
import Button from '../ui/Button.jsx';
import Banner from '../ui/Banner.jsx';

const PRESET_GENRES = [
  { id: 'mystery', label: 'Mystery & Unexplained', icon: '🕵️' },
  { id: 'history', label: 'History & Chronicles', icon: '🏛️' },
  { id: 'computers', label: 'Tech & Computers', icon: '💻' },
  { id: 'oddly_satisfying', label: 'Oddly Satisfying', icon: '✨' },
  { id: 'psychology', label: 'Psychology & Mind', icon: '🧠' },
  { id: 'space', label: 'Space & Astronomy', icon: '🚀' },
  { id: 'science', label: 'Science & Anomalies', icon: '🔬' },
  { id: 'general', label: 'General / Variety', icon: '🎭' },
];
const CHANNEL_VIDEO_TYPES = [
  { id: 'factual', label: 'Factual' },
  { id: 'whatif', label: 'What if' },
  { id: 'history', label: 'History' },
];

export default function ChannelModal({
  channel = null,
  onClose,
  onSaved,
  onDeleted,
}) {
  const isEditing = Boolean(channel?.id);

  const [name, setName] = useState(channel?.name || '');
  const [description, setDescription] = useState(channel?.description || '');
  const [genre, setGenre] = useState(channel?.genre || 'mystery');
  const [customGenre, setCustomGenre] = useState('');
  const [youtubeChannelId, setYoutubeChannelId] = useState(channel?.youtube_channel_id || '');
  const [apiKey, setApiKey] = useState(channel?.api_key || '');
  const [clientId, setClientId] = useState(channel?.client_id || '');
  const [clientSecret, setClientSecret] = useState(channel?.client_secret || '');
  
  const [voiceoverRules, setVoiceoverRules] = useState(channel?.voiceover_psychology_rules || '');
  const [videoRules, setVideoRules] = useState(channel?.video_psychology_rules || '');
  const [engine, setEngine] = useState(channel?.engine || 'classic');
  const [audioMode, setAudioMode] = useState(channel?.audio_mode || '');
  const [captions, setCaptions] = useState(channel?.captions == null ? '' : String(channel.captions));
  const [madeForKids, setMadeForKids] = useState(channel?.made_for_kids == null ? '' : String(channel.made_for_kids));
  const [style, setStyle] = useState(channel?.style || '');
  const [maxDailyPosts, setMaxDailyPosts] = useState(channel?.max_daily_posts || 2);
  const [videoTypes, setVideoTypes] = useState(Array.isArray(channel?.video_types) ? channel.video_types : CHANNEL_VIDEO_TYPES.map(({ id }) => id));
  const [autoReleaseEnabled, setAutoReleaseEnabled] = useState(channel?.auto_release?.enabled === true);
  const [autoReleaseDailyCap, setAutoReleaseDailyCap] = useState(channel?.auto_release?.daily_cap == null ? '' : String(channel.auto_release.daily_cap));
  const [growthProfilePrompts, setGrowthProfilePrompts] = useState(channel?.growth_profile_prompts === true);
  const [growthTopicPicking, setGrowthTopicPicking] = useState(channel?.growth_topic_picking === true);
  const [researchSummary, setResearchSummary] = useState('');

  const [niche, setNiche] = useState(channel?.profile?.niche || '');
  const [language, setLanguage] = useState(channel?.profile?.language || 'en');
  const [avoid, setAvoid] = useState(
    Array.isArray(channel?.profile?.avoid)
      ? channel.profile.avoid.join('\n')
      : (channel?.profile?.avoid || '')
  );

  const [activeTab, setActiveTab] = useState('general'); // 'general' | 'keys' | 'psychology'
  const [isResearching, setIsResearching] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // If initial channel prop changes, sync state
  useEffect(() => {
    if (channel) {
      setName(channel.name || '');
      setDescription(channel.description || '');
      const isPreset = PRESET_GENRES.some(g => g.id === channel.genre);
      setGenre(isPreset ? channel.genre : 'custom');
      setCustomGenre(isPreset ? '' : (channel.genre || ''));
      setYoutubeChannelId(channel.youtube_channel_id || '');
      setApiKey(channel.api_key || '');
      setClientId(channel.client_id || '');
      setClientSecret(channel.client_secret || '');
      setVoiceoverRules(channel.voiceover_psychology_rules || '');
      setVideoRules(channel.video_psychology_rules || '');
      setEngine(channel.engine || 'classic');
      setAudioMode(channel.audio_mode || '');
      setCaptions(channel.captions == null ? '' : String(channel.captions));
      setMadeForKids(channel.made_for_kids == null ? '' : String(channel.made_for_kids));
      setStyle(channel.style || '');
      setMaxDailyPosts(channel.max_daily_posts || 2);
      setVideoTypes(Array.isArray(channel.video_types) ? channel.video_types : CHANNEL_VIDEO_TYPES.map(({ id }) => id));
      setAutoReleaseEnabled(channel.auto_release?.enabled === true);
      setAutoReleaseDailyCap(channel.auto_release?.daily_cap == null ? '' : String(channel.auto_release.daily_cap));
      setGrowthProfilePrompts(channel.growth_profile_prompts === true);
      setGrowthTopicPicking(channel.growth_topic_picking === true);
      setResearchSummary('');
      setNiche(channel.profile?.niche || '');
      setLanguage(channel.profile?.language || 'en');
      setAvoid(
        Array.isArray(channel.profile?.avoid)
          ? channel.profile.avoid.join('\n')
          : (channel.profile?.avoid || '')
      );
    } else {
      setName('');
      setDescription('');
      setGenre('mystery');
      setCustomGenre('');
      setYoutubeChannelId('');
      setApiKey('');
      setClientId('');
      setClientSecret('');
      setVoiceoverRules('');
      setVideoRules('');
      setEngine('classic');
      setAudioMode('');
      setCaptions('');
      setMadeForKids('');
      setStyle('');
      setMaxDailyPosts(2);
      setVideoTypes(CHANNEL_VIDEO_TYPES.map(({ id }) => id));
      setAutoReleaseEnabled(false);
      setAutoReleaseDailyCap('');
      setGrowthProfilePrompts(false);
      setGrowthTopicPicking(false);
      setResearchSummary('');
      setNiche('');
      setLanguage('en');
      setAvoid('');
    }
    setError('');
    setSuccessMsg('');
    setConfirmDelete(false);
  }, [channel]);

  const effectiveGenre = genre === 'custom' ? (customGenre.trim() || 'general') : genre;

  const handleResearchRules = async () => {
    if (!effectiveGenre) {
      setError('Please choose or enter a genre before researching psychology rules.');
      return;
    }
    setError('');
    setIsResearching(true);
    try {
      const result = await api.researchChannelRules({
        genre: effectiveGenre,
        name: name.trim() || undefined,
        description: description.trim() || undefined
      });
      if (result) {
        setVoiceoverRules(result.voiceover_rules || result.voiceover_psychology_rules || '');
        setVideoRules(result.video_rules || result.video_psychology_rules || '');
        setResearchSummary(result.summary || `AI generated psychological retention strategy for ${effectiveGenre}`);
        setSuccessMsg('Psychology rules dynamically researched and updated!');
        setActiveTab('psychology');
      }
    } catch (err) {
      setError(`Failed to research rules: ${err.message}`);
    } finally {
      setIsResearching(false);
    }
  };

  const handleGetApiKey = (e) => {
    e?.preventDefault?.();
    // Opens Credentials page and YouTube Data API v3 library in new tabs without sending any network request
    window.open('https://console.cloud.google.com/apis/library/youtube.googleapis.com', '_blank', 'noopener,noreferrer');
    window.open('https://console.cloud.google.com/apis/credentials', '_blank', 'noopener,noreferrer');
  };

  const handleSave = async (e) => {
    e?.preventDefault();
    if (!name.trim()) {
      setError('Channel name is required.');
      return;
    }
    if (!effectiveGenre) {
      setError('Channel genre is required.');
      return;
    }

    setIsSaving(true);
    setError('');

    const trimmedNiche = niche.trim().slice(0, 200);
    const selectedFormat = 'narrated';
    const trimmedLanguage = language.trim() || 'en';
    const avoidPhrases = avoid
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 10);

    const isDefaultProfile =
      !trimmedNiche &&
      selectedFormat === 'narrated' &&
      trimmedLanguage === 'en' &&
      avoidPhrases.length === 0;

    const profile = isDefaultProfile
      ? null
      : {
          niche: trimmedNiche,
          format: selectedFormat,
          language: trimmedLanguage,
          avoid: avoidPhrases,
        };

    const payload = {
      name: name.trim(),
      description: description.trim(),
      genre: effectiveGenre,
      engine,
      audio_mode: audioMode || null,
      captions: captions === '' ? null : captions === 'true',
      made_for_kids: madeForKids === '' ? null : madeForKids === 'true',
      kids_length_s: channel?.kids_length_s ?? null,
      kids_video_model: channel?.kids_video_model || null,
      kids_clip_seconds: channel?.kids_clip_seconds ?? null,
      style: style === 'viral_v1' ? 'viral_v1' : '',
      max_daily_posts: Number(maxDailyPosts) || 2,
      video_types: videoTypes,
      auto_release: { enabled: autoReleaseEnabled, daily_cap: autoReleaseDailyCap.trim() ? Number(autoReleaseDailyCap) : null },
      growth_profile_prompts: growthProfilePrompts,
      growth_topic_picking: growthTopicPicking,
      youtube_channel_id: youtubeChannelId.trim(),
      api_key: apiKey.trim(),
      client_id: clientId.trim(),
      ...(clientSecret.trim() ? { client_secret: clientSecret.trim() } : {}),
      voiceover_psychology_rules: voiceoverRules,
      video_psychology_rules: videoRules,
      profile
    };

    try {
      let saved;
      if (isEditing) {
        saved = await api.updateChannel(channel.id, payload);
      } else {
        saved = await api.createChannel(payload);
      }
      onSaved?.(saved);
      onClose?.();
    } catch (err) {
      setError(`Save failed: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await api.deleteChannel(channel.id);
      onDeleted?.(channel.id);
      onClose?.();
    } catch (err) {
      setError(`Delete failed: ${err.message}`);
    }
  };

  const boundAccount = channel?.bound_account || channel?.token;
  const boundAccountName = boundAccount?.channel;
  const boundAccountId = boundAccount?.channel_id;

  const modalContent = (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink-950/80 backdrop-blur-sm animate-in fade-in duration-200"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div 
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-modal-title"
        className="bg-ink-900 border border-ink-800 rounded-2xl max-w-3xl w-full max-h-[92vh] flex flex-col shadow-2xl overflow-hidden"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-ink-800 bg-ink-900/60">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-ember-500/10 border border-ember-500/20 rounded-xl text-ember-400">
              <Tv className="w-5 h-5" />
            </div>
            <div>
              <h2 id="channel-modal-title" className="text-base font-semibold text-ink-50 flex items-center gap-2">
                {isEditing ? `Edit Channel: ${channel.name}` : 'Register New YouTube Channel'}
              </h2>
              <p className="text-xs text-ink-400">
                Configure channel genre, local API credentials, and dynamic AI psychology rules.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="p-1.5 text-ink-400 hover:text-ink-100 rounded-lg hover:bg-ink-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center px-6 border-b border-ink-800 bg-ink-950/40 gap-4">
          <button
            type="button"
            onClick={() => setActiveTab('general')}
            className={`py-3 text-xs font-semibold flex items-center gap-2 border-b-2 transition ${
              activeTab === 'general'
                ? 'border-ember-500 text-ember-400'
                : 'border-transparent text-ink-400 hover:text-ink-200'
            }`}
          >
            <Tv className="w-3.5 h-3.5" /> Channel Info & Genre
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('psychology')}
            className={`py-3 text-xs font-semibold flex items-center gap-2 border-b-2 transition ${
              activeTab === 'psychology'
                ? 'border-ember-500 text-ember-400'
                : 'border-transparent text-ink-400 hover:text-ink-200'
            }`}
          >
            <Brain className="w-3.5 h-3.5" /> Retention Psychology Rules
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('keys')}
            className={`py-3 text-xs font-semibold flex items-center gap-2 border-b-2 transition ${
              activeTab === 'keys'
                ? 'border-ember-500 text-ember-400'
                : 'border-transparent text-ink-400 hover:text-ink-200'
            }`}
          >
            <Key className="w-3.5 h-3.5" /> API Keys & OAuth
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {error && (
            <Banner tone="danger">
              {error}
            </Banner>
          )}

          {successMsg && (
            <Banner tone="success">
              {successMsg}
            </Banner>
          )}

          {/* TAB 1: General Info & Genre */}
          {activeTab === 'general' && (
            <div className="space-y-5">
              <label className="flex items-start gap-3 rounded-xl border border-ink-800 bg-ink-950/50 p-3">
                <input type="checkbox" checked={growthProfilePrompts} onChange={(e) => setGrowthProfilePrompts(e.target.checked)} className="mt-0.5 accent-ember-500" />
                <span><span className="block text-sm font-medium text-ink-100">Use growth profile prompts</span><span className="block text-xs text-ink-400">Tailor hooks, titles, descriptions, and tags to this channel. Off by default.</span></span>
              </label>
              <div>
                <label className="block text-xs font-medium text-ink-300 mb-1.5">
                  Channel Name <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Dark File Mysteries, ChronoChronicles, CodeForge"
                  className="w-full px-3.5 py-2.5 bg-ink-950 border border-ink-800 rounded-xl text-sm text-ink-100 placeholder-ink-600 focus:outline-none focus:border-ember-500/70 transition shadow-inner"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-ink-300 mb-1.5">
                  Channel Description / Focus
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  placeholder="Brief summary of the target audience, tone, and subject matter..."
                  className="w-full px-3.5 py-2.5 bg-ink-950 border border-ink-800 rounded-xl text-sm text-ink-100 placeholder-ink-600 focus:outline-none focus:border-ember-500/70 transition resize-none shadow-inner"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-ink-300 mb-1.5">
                  Niche
                </label>
                <input
                  type="text"
                  maxLength={200}
                  value={niche}
                  onChange={(e) => setNiche(e.target.value)}
                  placeholder="e.g. geography oddities, borders and country comparisons shown on a map"
                  className="w-full px-3.5 py-2.5 bg-ink-950 border border-ink-800 rounded-xl text-sm text-ink-100 placeholder-ink-600 focus:outline-none focus:border-ember-500/70 transition shadow-inner"
                />
                <p className="text-[11px] text-ink-400 mt-1">
                  What this channel is about. Videos pick their theme inside it.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-ink-300 mb-1.5">Format</label>
                  <div className="px-3.5 py-2.5 bg-ink-950 border border-ink-800 rounded-xl text-sm text-ink-100">Narrated</div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-ink-300 mb-1.5">Language</label>
                  <input
                    type="text"
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    placeholder="en"
                    className="w-full px-3.5 py-2.5 bg-ink-950 border border-ink-800 rounded-xl text-sm text-ink-100 placeholder-ink-600 focus:outline-none focus:border-ember-500/70 transition shadow-inner"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-ink-300 mb-1.5">
                  Avoid
                </label>
                <textarea
                  value={avoid}
                  onChange={(e) => setAvoid(e.target.value)}
                  rows={3}
                  placeholder={"current wars\ndisputed borders"}
                  className="w-full px-3.5 py-2.5 bg-ink-950 border border-ink-800 rounded-xl text-sm text-ink-100 placeholder-ink-600 focus:outline-none focus:border-ember-500/70 transition resize-none shadow-inner"
                />
                <p className="text-[11px] text-ink-400 mt-1">
                  Up to 10 short phrases (topics to stay away from), entered one per line.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <fieldset className="sm:col-span-3">
                  <legend className="block text-xs font-medium text-ink-300 mb-2">Video types for this channel</legend>
                  <div className="flex flex-wrap gap-4">
                    {CHANNEL_VIDEO_TYPES.map(({ id, label }) => (
                      <label key={id} className="flex items-center gap-2 text-sm text-ink-200">
                        <input
                          type="checkbox"
                          checked={videoTypes.includes(id)}
                          onChange={(e) => setVideoTypes((current) => e.target.checked ? [...current, id] : current.filter((type) => type !== id))}
                          className="accent-ember-500"
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                  <p className="text-[11px] text-ink-400 mt-1">A channel can handle more than one type.</p>
                </fieldset>
                <fieldset className="sm:col-span-3 rounded-xl border border-ink-800 p-3">
                  <legend className="px-1 text-xs font-medium text-ink-300">Auto release</legend>
                  <label className="flex items-center gap-2 text-sm text-ink-200">
                    <input type="checkbox" checked={autoReleaseEnabled} onChange={(e) => setAutoReleaseEnabled(e.target.checked)} className="accent-ember-500" />
                    Enable auto release for this channel
                  </label>
                  <div className="mt-3 max-w-xs">
                    <label className="block text-xs font-medium text-ink-300 mb-1.5" htmlFor="auto-release-daily-cap">Daily release cap</label>
                    <input
                      id="auto-release-daily-cap"
                      type="number"
                      min={1}
                      step={1}
                      value={autoReleaseDailyCap}
                      onChange={(e) => setAutoReleaseDailyCap(e.target.value)}
                      placeholder="No cap set"
                      className="w-full px-3.5 py-2.5 bg-ink-950 border border-ink-800 rounded-xl text-sm text-ink-100 placeholder-ink-600 focus:outline-none focus:border-ember-500/70 transition shadow-inner"
                    />
                    <p className="text-[11px] text-ink-400 mt-1">Auto release stays off by default. A positive whole-number cap is required before any release.</p>
                  </div>
                </fieldset>
                <div>
                  <label className="block text-xs font-medium text-ink-300 mb-1.5">Max videos going public per day</label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={maxDailyPosts}
                    onChange={(e) => setMaxDailyPosts(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-ink-950 border border-ink-800 rounded-xl text-sm text-ink-100 focus:outline-none focus:border-ember-500/70 transition shadow-inner"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium text-ink-300 mb-1.5">Made for Kids</label>
                  <select value={madeForKids} onChange={(e) => setMadeForKids(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-ink-950 border border-ink-800 rounded-xl text-sm text-ink-100 focus:outline-none focus:border-ember-500/70 transition shadow-inner">
                    <option value="">Auto</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-ink-300 mb-2">
                  Select Channel Genre <span className="text-rose-400">*</span>
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                  {PRESET_GENRES.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        setGenre(preset.id);
                        setCustomGenre('');
                      }}
                      className={`p-2.5 rounded-xl border text-left text-xs font-medium flex items-center gap-2 transition ${
                        genre === preset.id
                          ? 'border-ember-500/50 bg-ember-500/10 text-ember-300 font-semibold'
                          : 'border-ink-800 bg-ink-950/60 text-ink-400 hover:text-ink-200 hover:border-ink-700'
                      }`}
                    >
                      <span className="text-base">{preset.icon}</span>
                      <span className="truncate">{preset.label}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setGenre('custom')}
                    className={`p-2.5 rounded-xl border text-left text-xs font-medium flex items-center gap-2 transition ${
                      genre === 'custom'
                        ? 'border-ember-500/50 bg-ember-500/10 text-ember-300 font-semibold'
                        : 'border-ink-800 bg-ink-950/60 text-ink-400 hover:text-ink-200 hover:border-ink-700'
                    }`}
                  >
                    <span className="text-base">🎨</span>
                    <span>Custom Genre...</span>
                  </button>
                </div>

                {genre === 'custom' && (
                  <input
                    type="text"
                    value={customGenre}
                    onChange={(e) => setCustomGenre(e.target.value)}
                    placeholder="Enter custom genre (e.g. true crime, woodworking, cyber security)"
                    className="w-full px-3.5 py-2.5 bg-ink-950 border border-ember-500/50 rounded-xl text-sm text-ink-100 placeholder-ink-600 focus:outline-none focus:border-ember-500 transition shadow-inner"
                  />
                )}
              </div>

              {/* Research CTA banner inside General tab */}
              <div className="p-4 bg-ink-950/80 border border-ember-500/30 rounded-xl flex items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-ink-100 mb-0.5">
                    <Sparkles className="w-3.5 h-3.5 text-ember-400" />
                    AI Retention Psychology Engineering
                  </div>
                  <p className="text-[11px] text-ink-400">
                    Dynamically formulate psychological vocal and video withholding rules for "{effectiveGenre}".
                  </p>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleResearchRules}
                  disabled={isResearching}
                  loading={isResearching}
                  icon={Sparkles}
                >
                  Research Rules with AI
                </Button>
              </div>
            </div>
          )}

          {/* TAB 2: Retention Psychology Rules */}
          {activeTab === 'psychology' && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-semibold text-ink-100 flex items-center gap-1.5">
                    <Brain className="w-4 h-4 text-ember-400" /> Dynamic Psychology Directives
                  </h3>
                  <p className="text-[11px] text-ink-400 mt-0.5">
                    Tailored rules applied during script generation, voice-over synthesis, and video framing.
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleResearchRules}
                  disabled={isResearching}
                  loading={isResearching}
                  icon={Sparkles}
                >
                  Regenerate via AI
                </Button>
              </div>

              {researchSummary && (
                <div className="p-3 bg-ember-500/10 border border-ember-500/20 rounded-xl text-xs text-ember-300">
                  <span className="font-semibold text-ink-100">Retention Strategy: </span>
                  {researchSummary}
                </div>
              )}

              {/* Voiceover Rules Box */}
              <div>
                <label className="block text-xs font-medium text-ink-300 mb-1.5 flex items-center gap-1.5">
                  <Mic className="w-3.5 h-3.5 text-ember-400" />
                  Voiceover Psychology & Vocal Retention Directives
                </label>
                <textarea
                  value={voiceoverRules}
                  onChange={(e) => setVoiceoverRules(e.target.value)}
                  rows={6}
                  placeholder="Psychological vocal rules: orienting reflex, conspiratorial drops, micro-cliffhangers, cadence contrasts..."
                  className="w-full font-mono text-xs px-3.5 py-2.5 bg-ink-950 border border-ink-800 rounded-xl text-ink-200 placeholder-ink-600 focus:outline-none focus:border-ember-500/70 transition leading-relaxed shadow-inner"
                />
                <p className="text-[11px] text-ink-500 mt-1">
                  Injected into the narrator prompt and story-arc director to guide tone, cadence, and volume drops.
                </p>
              </div>

              {/* Video Rules Box */}
              <div>
                <label className="block text-xs font-medium text-ink-300 mb-1.5 flex items-center gap-1.5">
                  <Video className="w-3.5 h-3.5 text-emerald-400" />
                  Video Visual Psychology & Anticipation Withholding Rules
                </label>
                <textarea
                  value={videoRules}
                  onChange={(e) => setVideoRules(e.target.value)}
                  rows={6}
                  placeholder="Visual psychology rules: anticipation withholding (e.g. keeping soap on a window to force the viewer to wait for cleaning), pattern interrupts, dopamine delay..."
                  className="w-full font-mono text-xs px-3.5 py-2.5 bg-ink-950 border border-ink-800 rounded-xl text-ink-200 placeholder-ink-600 focus:outline-none focus:border-ember-500/70 transition leading-relaxed shadow-inner"
                />
                <p className="text-[11px] text-ink-500 mt-1">
                  Injected into Gemini visual scene director and ComfyUI generation prompts.
                </p>
              </div>
            </div>
          )}

          {/* TAB 3: API Keys & YouTube Credentials */}
          {activeTab === 'keys' && (
            <div className="space-y-5">
              <div className="p-3.5 bg-ink-950/60 border border-ink-800 rounded-xl text-xs text-ink-400 space-y-1">
                <p className="font-semibold text-ink-300 flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5 text-ember-400" /> Local Persistence Guarantee
                </p>
                <p>
                  Credentials entered here are saved locally in <code className="text-ink-200">data/channels.json</code> and never transmitted outside your local machine.
                </p>
              </div>

              {/* Bound YouTube Account Card (KAN-251) */}
              <div className="p-3.5 bg-ink-950/60 border border-ink-800 rounded-xl text-xs space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-ink-300 flex items-center gap-1.5">
                    <Tv className="w-3.5 h-3.5 text-ember-400" /> Bound YouTube Account
                  </span>
                  {boundAccountName ? (
                    <span className="text-[10px] font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                      Connected
                    </span>
                  ) : (
                    <span className="text-[10px] font-medium text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full">
                      Not Bound
                    </span>
                  )}
                </div>
                {boundAccountName ? (
                  <p className="text-ink-200">
                    <span className="font-medium text-emerald-400">{boundAccountName}</span>
                    {boundAccountId && (
                      <span className="font-mono text-[11px] text-ink-400 ml-1.5">({boundAccountId})</span>
                    )}
                  </p>
                ) : (
                  <p className="text-ink-500 text-[11px]">
                    No YouTube account bound. Connect via the Channels menu or Channel Stats tab.
                  </p>
                )}
                <p className="text-[10px] text-ink-500 italic pt-1 border-t border-ink-800/60">
                  Note: Google account email requires openid email scope and owner re-authorisation; not requested here.
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-ink-300 mb-1.5">
                  YouTube Channel ID
                </label>
                <input
                  type="text"
                  value={youtubeChannelId}
                  onChange={(e) => setYoutubeChannelId(e.target.value)}
                  placeholder="e.g. UCrYSf42sxY0hEa2pWSZ140w"
                  className="w-full px-3.5 py-2.5 bg-ink-950 border border-ink-800 rounded-xl text-sm text-ink-100 placeholder-ink-600 focus:outline-none focus:border-ember-500/70 transition shadow-inner"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-medium text-ink-300">
                    YouTube Data API Key (Optional)
                  </label>
                  <button
                    type="button"
                    onClick={handleGetApiKey}
                    className="h-6 px-2.5 text-[11px] font-medium rounded-lg bg-ink-800 hover:bg-ink-700 text-ink-200 hover:text-ink-50 inline-flex items-center gap-1.5 transition border border-ink-700/80"
                    title="Opens Google Cloud Console Credentials and YouTube Data API v3 library in new tabs (sends no request)"
                  >
                    <ExternalLink className="w-3 h-3 text-ember-400" />
                    Get an API key
                  </button>
                </div>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={channel?.has_api_key ? '•••••••• (API key saved - enter new key to replace)' : 'AIzaSy...'}
                  className="w-full px-3.5 py-2.5 bg-ink-950 border border-ink-800 rounded-xl text-sm text-ink-100 placeholder-ink-600 focus:outline-none focus:border-ember-500/70 transition font-mono shadow-inner"
                />
                <div className="mt-2 text-[11px] text-ink-400 space-y-0.5 border-l-2 border-ember-500/40 pl-2.5 bg-ink-950/40 py-1.5 rounded-r-lg">
                  <p className="leading-tight">Step 1: Enable the YouTube Data API v3 in Google Cloud Console.</p>
                  <p className="leading-tight">Step 2: Create Credentials &rarr; API key, and paste it here.</p>
                </div>
                <p className="text-[11px] text-ink-500 mt-1">
                  Used for channel ranking, competitor analytics, and view tracking. Stays masked and never logged or exposed.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-ink-300 mb-1.5">
                    OAuth Client ID (Optional Override)
                  </label>
                  <input
                    type="password"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder="xxxxxxxx.apps.googleusercontent.com"
                    className="w-full px-3.5 py-2.5 bg-ink-950 border border-ink-800 rounded-xl text-sm text-ink-100 placeholder-ink-600 focus:outline-none focus:border-ember-500/70 transition font-mono shadow-inner"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-300 mb-1.5">
                    OAuth Client Secret (Optional Override)
                  </label>
                  <input
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder="GOCSPX-..."
                    className="w-full px-3.5 py-2.5 bg-ink-950 border border-ink-800 rounded-xl text-sm text-ink-100 placeholder-ink-600 focus:outline-none focus:border-ember-500/70 transition font-mono shadow-inner"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-ink-800 bg-ink-950/60">
          <div>
            {isEditing && (
              <Button
                variant="danger"
                size="sm"
                onClick={handleDelete}
                icon={Trash2}
              >
                {confirmDelete ? 'Click Again to Confirm' : 'Delete Channel'}
              </Button>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={isSaving}
              loading={isSaving}
              icon={Save}
            >
              {isEditing ? 'Save Channel Changes' : 'Register Channel'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modalContent, document.body) : modalContent;
}
