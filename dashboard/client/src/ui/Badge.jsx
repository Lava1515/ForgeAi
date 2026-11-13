import React from 'react';

const TONES = {
  neutral: 'bg-ink-800 text-ink-300 border-ink-700/60',
  accent: 'bg-ember-500/15 text-ember-300 border-ember-500/30',
  success: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  warn: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  error: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
};

const DOT = {
  neutral: 'bg-ink-500',
  accent: 'bg-ember-400',
  success: 'bg-emerald-400',
  warn: 'bg-amber-400',
  error: 'bg-rose-400',
};

// Callers use a few synonyms; map them so an unknown tone never renders an uncoloured dot/badge.
const ALIASES = { ok: 'success', danger: 'error', idle: 'neutral' };
const tone_ = (t) => ALIASES[t] || t;

export function Badge({ tone = 'neutral', children, className = '' }) {
  return <span className={`ui-badge inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-mono leading-none tracking-wide ${TONES[tone_(tone)] || TONES.neutral} ${className}`}>{children}</span>;
}

export function StatusDot({ tone: rawTone = 'neutral', pulse = false, label }) {
  const tone = DOT[tone_(rawTone)] ? tone_(rawTone) : 'neutral';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative flex h-2 w-2">
        {pulse && <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-60 ${DOT[tone]}`} />}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${DOT[tone]}`} />
      </span>
      {label && <span className="font-mono text-[11px] uppercase tracking-wider text-ink-300">{label}</span>}
    </span>
  );
}

export default Badge;
