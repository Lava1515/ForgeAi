import React, { useState, useEffect } from 'react';
import { Image as ImageIcon, Clapperboard, Mic } from 'lucide-react';
import * as api from '../services/api.js';

export const IMAGE_ENGINES = [
  { id: 'z_image_turbo', name: 'Z-Image Turbo', badge: 'Apache-2.0', desc: 'Rapid ideation & clean screenprint aesthetic.', option: 'Z-Image Turbo (Apache-2.0)' },
];

export const normalizeImageEngine = (id) => (!id || id === 'flux2_klein' || id === 'flux2_dev' || id === 'turbo' ? 'z_image_turbo' : id);

export const VIDEO_ENGINES = [
  { id: 'minimax_h3_turbo', name: 'MiniMax H3 Turbo', badge: '8-Step LoRA', desc: 'Fast vertical clips with generated audio.', option: 'MiniMax H3 Turbo (Speed)' },
  { id: 'minimax_h3', name: 'MiniMax H3', badge: '20 Steps', desc: 'Slower, richer motion and detail.', option: 'MiniMax H3 (Quality)' },
];

// Model licence policy: only MIT, Apache-2.0 or CC0 allowed for video creation (2026-10-29 voice licence table).
// Fish Speech 1.5 weights are CC-BY-NC-SA-4.0 (Non-Commercial) and excluded from video creation.
export const VOICE_POLICY_NOTICE = 'Unavailable under model licence policy (CC-BY-NC-SA-4.0 weights; MIT, Apache-2.0, or CC0 required).';
export const isVoiceAllowed = (id) => QWEN_VOICES.some((voice) => voice.id === id);

// Qwen3-TTS 1.7B CustomVoice speakers. All speak English; ryan and aiden are native English speakers.
const QWEN_VOICES = [
  { id: 'qwen:ryan', name: 'Qwen3 · Ryan', badge: 'Dynamic Male', desc: 'Native English. Strong rhythmic drive, great for mysteries and hooks.', option: 'Ryan (Dynamic Male, English)' },
  { id: 'qwen:aiden', name: 'Qwen3 · Aiden', badge: 'Sunny Male', desc: 'Native English. Clear, friendly American voice for explainers.', option: 'Aiden (Sunny Male, English)' },
  { id: 'qwen:vivian', name: 'Qwen3 · Vivian', badge: 'Bright Female', desc: 'Bright, slightly edgy young female voice (native Chinese).', option: 'Vivian (Bright Female)' },
  { id: 'qwen:serena', name: 'Qwen3 · Serena', badge: 'Warm Female', desc: 'Warm, gentle young female voice (native Chinese).', option: 'Serena (Warm Female)' },
  { id: 'qwen:uncle_fu', name: 'Qwen3 · Uncle Fu', badge: 'Mellow Male', desc: 'Seasoned male voice with a low, mellow timbre (native Chinese).', option: 'Uncle Fu (Mellow Male)' },
  { id: 'qwen:dylan', name: 'Qwen3 · Dylan', badge: 'Youthful Male', desc: 'Clear, natural young male voice (native Chinese, Beijing).', option: 'Dylan (Youthful Male)' },
  { id: 'qwen:eric', name: 'Qwen3 · Eric', badge: 'Lively Male', desc: 'Lively, slightly husky male voice (native Chinese, Chengdu).', option: 'Eric (Lively Male)' },
  { id: 'qwen:ono_anna', name: 'Qwen3 · Ono Anna', badge: 'Playful Female', desc: 'Light, playful female voice (native Japanese).', option: 'Ono Anna (Playful Female)' },
  { id: 'qwen:sohee', name: 'Qwen3 · Sohee', badge: 'Emotive Female', desc: 'Warm female voice with rich emotion (native Korean).', option: 'Sohee (Emotive Female)' },
];
export const TTS_MODELS = [
  { id: 'qwen', name: 'Qwen3-TTS 1.7B', badge: 'Apache-2.0', desc: 'Built-in speakers, follows the delivery style.' },
  { id: 'fish', name: 'Fish Speech 1.5 (Unavailable under policy)', badge: 'CC-BY-NC-SA-4.0', desc: 'Clones each Qwen3 speaker (clip recorded on first use). Ignores delivery style. Unavailable for video creation under licence policy (CC-BY-NC-SA-4.0 weights).', unavailable: true, disabled: true },
];
// Fish Speech has no built-in speakers: the factory clones a short Qwen3 clip of the same speaker.
export const NARRATIVE_VOICES = [
  ...QWEN_VOICES,
  ...QWEN_VOICES.map((v) => ({ ...v, id: v.id.replace('qwen:', 'fish:'), name: v.name.replace('Qwen3', 'Fish 1.5'), desc: `Fish Speech 1.5 clone of ${v.name}.`, unavailable: true })),
];
export const voiceModel = (id) => (String(id).startsWith('fish:') ? 'fish' : 'qwen');
// Same speaker on the other model: 'qwen:ryan' -> 'fish:ryan'. A custom clone has no Qwen twin: Qwen's default.
export const withModel = (id, model) => {
  const next = `${model}:${String(id).replace(/^\w+:/, '')}`;
  return model === 'qwen' && !NARRATIVE_VOICES.some((v) => v.id === next) ? DEFAULT_VOICE : next;
};
// Fish voices saved in the Voices tab (clones of your own clips), as picker entries. The Voices tab fires
// 'fish-voices-changed' after any edit so every open picker refreshes.
export function useCustomFishVoices() {
  const [voices, setVoices] = useState([]);
  useEffect(() => {
    const load = () => api.listFishVoices()
      .then((r) => setVoices(r.voices.filter((v) => !v.qwen_copy).map((v) => ({ id: `fish:${v.name}`, name: `Fish 1.5 · ${v.name}`, badge: 'Your clone', desc: v.transcript, unavailable: true }))))
      .catch(() => {});
    load();
    window.addEventListener('fish-voices-changed', load);
    return () => window.removeEventListener('fish-voices-changed', load);
  }, []);
  return voices;
}
// <option>s for a voice <select>, grouped by model.
// Non-allowed voices (Fish Speech) are marked as unavailable under policy and disabled to prevent selection for new creations,
// while preserving display for persisted saved choices.
export function VoiceOptions({ selectedVoice, currentVoice } = {}) {
  const activeVoice = selectedVoice || currentVoice;
  const customFish = useCustomFishVoices();
  const all = [...NARRATIVE_VOICES, ...customFish];
  const missingActive = (activeVoice && !all.some((v) => v.id === activeVoice))
    ? [{ id: activeVoice, name: activeVoice.replace(/^fish:/, 'Fish 1.5 · '), badge: 'Saved voice', unavailable: !isVoiceAllowed(activeVoice) }]
    : [];
  const voiceList = [...all, ...missingActive];

  return TTS_MODELS.map((m) => {
    const isModelAllowed = m.id === 'qwen';
    const groupLabel = isModelAllowed ? m.name : `${m.name.replace(/ \(Unavailable.*$/, '')} (Unavailable under policy)`;
    const groupVoices = voiceList.filter((v) => voiceModel(v.id) === m.id);
    return (
      <optgroup key={m.id} label={groupLabel}>
        {groupVoices.map((v) => {
          const allowed = isVoiceAllowed(v.id);
          const optionLabel = allowed
            ? `${v.name} (${v.badge})`
            : `${v.name} (${v.badge}) — Unavailable under policy`;
          return (
            <option key={v.id} value={v.id} disabled={!allowed}>
              {optionLabel}
            </option>
          );
        })}
      </optgroup>
    );
  });
}
export const DEFAULT_VOICE = 'qwen:ryan';
// Browsers may still have an old Kokoro id (af_heart) or 'qwen:Aria' saved; show the default instead.
// Any fish:<name> passes: custom voices load later, and the factory falls back to ryan if the clip is gone.
export const normalizeVoice = (id) => (NARRATIVE_VOICES.some((v) => v.id === id) || /^fish:[a-z0-9_-]+$/.test(id) ? id : DEFAULT_VOICE);

export const AUDIENCES = [
  { id: 'general', label: 'General audience' },
  { id: 'preschool', label: 'Kids · Preschool (2–5)' },
  { id: 'kids', label: 'Kids · 6–12' },
];

const SCENE_SECONDS = 15;
export const VIDEO_LENGTHS = [
  { seconds: 5, estMin: 4 },
  { seconds: 10, estMin: 9 },
  { seconds: 15, estMin: 16 },
  { seconds: 60, estMin: 64, long: true },
  { seconds: 120, estMin: 128, long: true },
  { seconds: 180, estMin: 192, long: true },
];

export const sceneCount = (seconds) => (seconds > SCENE_SECONDS ? Math.ceil(seconds / SCENE_SECONDS) : 1);
export const formatLength = (seconds) => (seconds >= 60 ? `${seconds / 60} min` : `${seconds}s`);
export const formatMinutes = (min) => (min >= 90 ? `${(min / 60).toFixed(1).replace('.0', '')} h` : `${min} min`);

export const videoTimeoutMs = (seconds) => {
  const scenes = sceneCount(seconds);
  const clipSeconds = scenes > 1 ? SCENE_SECONDS : seconds;
  return (scenes * (10 + clipSeconds * 2.5) + 5) * 60 * 1000;
};

// Voice-over length for narrative shorts (seconds). Gemini sizes the script to it.
export const NARRATIVE_SECONDS = { min: 1, max: 300, default: 60 };
export const WORDS_PER_SECOND = 2.0; // measured 2026-10-11: Qwen3 with the positive narrator instruction, pauses included (old 2.6 made 1-min videos ~2 min)
const LENGTH_PRESETS = [15, 30, 60, 90, 120, 180, 300];

export const formatSeconds = (s) => {
  if (s < 60) return `${s}s`;
  return s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
export const narrativeScenes = (seconds) => Math.min(30, Math.max(1, Math.round(seconds / 10)));

export function NarrativeLength({ value, onChange, disabled }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const isPreset = LENGTH_PRESETS.includes(value);

  const typeCustom = (e) => {
    setDraft(e.target.value);
    const n = Math.round(e.target.valueAsNumber);
    if (n >= NARRATIVE_SECONDS.min && n <= NARRATIVE_SECONDS.max) onChange(n);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Voice-over length">
        {LENGTH_PRESETS.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={value === s}
            disabled={disabled}
            onClick={() => onChange(s)}
            className={`chip ${value === s ? 'chip-active' : ''}`}
          >
            {formatSeconds(s)}
          </button>
        ))}
        <label className={`chip gap-1.5 cursor-text focus-within:ring-2 focus-within:ring-ember-400/70 ${isPreset ? '' : 'chip-active'} ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
          <span>Custom</span>
          <input
            type="number"
            inputMode="numeric"
            aria-label="Custom length in seconds"
            min={NARRATIVE_SECONDS.min}
            max={NARRATIVE_SECONDS.max}
            value={draft}
            disabled={disabled}
            onChange={typeCustom}
            onBlur={() => setDraft(String(value))}
            className="self-stretch w-12 min-w-0 px-1 bg-transparent text-right text-ink-100 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span>s</span>
        </label>
      </div>
      <p className="text-xs font-mono text-ink-400">
        {formatSeconds(value)} · ~{Math.round(value * WORDS_PER_SECOND)} words · {narrativeScenes(value)} scene{narrativeScenes(value) > 1 ? 's' : ''} · 1–300s
      </p>
    </div>
  );
}

// Batch size picker: presets plus a Custom box, same as NarrativeLength. Max matches the server's MAX_AUTO_VIDEOS.
export const CREATION_COUNT = { min: 1, max: 100 };
const COUNT_PRESETS = [1, 2, 3, 5, 10, 15, 20, 25];

export function CreationCount({ value, onChange, disabled, className = '' }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const isPreset = COUNT_PRESETS.includes(value);

  const typeCustom = (e) => {
    setDraft(e.target.value);
    const n = Math.round(e.target.valueAsNumber);
    if (n >= CREATION_COUNT.min && n <= CREATION_COUNT.max) onChange(n);
  };

  return (
    <div role="radiogroup" aria-label="Number of creations" className={`flex flex-wrap gap-1 p-1 rounded-xl bg-ink-950 border border-ink-800 ${className}`}>
      {COUNT_PRESETS.map((num) => (
        <button
          key={num}
          type="button"
          role="radio"
          aria-checked={value === num}
          disabled={disabled}
          onClick={() => onChange(num)}
          className={`chip min-w-[2.75rem] justify-center border-transparent ${value === num ? 'chip-active' : ''}`}
        >
          {num}
        </button>
      ))}
      <label className={`chip gap-1.5 cursor-text focus-within:ring-2 focus-within:ring-ember-400/70 border-transparent ${isPreset ? '' : 'chip-active'} ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
        <span>Custom</span>
        <input
          type="number"
          inputMode="numeric"
          aria-label={`Custom number of creations (${CREATION_COUNT.min}-${CREATION_COUNT.max})`}
          min={CREATION_COUNT.min}
          max={CREATION_COUNT.max}
          value={draft}
          disabled={disabled}
          onChange={typeCustom}
          onBlur={() => setDraft(String(value))}
          className="self-stretch w-10 min-w-0 px-1 bg-transparent text-right text-ink-100 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        />
        <span>videos</span>
      </label>
    </div>
  );
}

export const isKidsAudience =(audience) => audience === 'preschool' || audience === 'kids';

export const enginesFor = (media) => {
  if (media === 'narrative') return NARRATIVE_VOICES;
  if (media === 'video') return VIDEO_ENGINES;
  return IMAGE_ENGINES;
};

const OPTIONS = [
  { id: 'image', label: 'Apparel Photo', icon: ImageIcon },
  { id: 'video', label: 'T2V Clip', icon: Clapperboard },
  { id: 'narrative', label: 'Narrative Short (TTS)', icon: Mic },
];

// Server switch FORGEAI_ALLOW_MINIMAX_H3 (licence guard): MiniMax-backed options are hidden while it is off.
export function useVideoStatus() {
  const [status, setStatus] = useState({ minimax_h3_enabled: false, message: '' });
  useEffect(() => {
    api.getVideoStatus().then((reply) => {
      if (reply && typeof reply === 'object') setStatus(reply);
    }).catch(() => {
      setStatus({ minimax_h3_enabled: false, message: 'Unable to check video availability.' });
    });
  }, []);
  return status && typeof status === 'object' ? status : { minimax_h3_enabled: false, message: '' };
}

export default function MediaToggle({ value, onChange, disabled }) {
  const video = useVideoStatus();
  return (
    <div className="inline-flex flex-col gap-1">
    <div className="inline-flex rounded-xl bg-ink-950 p-1 border border-ink-800" role="radiogroup" aria-label="Output type">
      {OPTIONS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          data-cy={`media-${id}`}
          disabled={disabled || (id === 'video' && !video?.minimax_h3_enabled)}
          title={id === 'video' && !video?.minimax_h3_enabled ? video?.message : undefined}
          onClick={() => onChange(id)}
          className={`flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-xs transition disabled:opacity-40 ${
            value === id ? 'bg-ember-500 text-ink-950 font-medium' : 'text-ink-400 hover:text-ink-100'
          }`}
        >
          <Icon className="w-3.5 h-3.5" />
          {label}
        </button>
      ))}
    </div>
    {!video?.minimax_h3_enabled && <p className="text-xs text-ink-400">{video?.message}</p>}
    </div>
  );
}
