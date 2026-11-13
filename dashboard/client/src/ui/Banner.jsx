import React from 'react';

const TONES = {
  warn: { box: 'bg-amber-500/10 border-amber-500/30', dot: 'bg-amber-400', text: 'text-amber-300', strong: 'text-amber-200', btn: 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border-amber-500/30' },
  error: { box: 'bg-rose-500/10 border-rose-500/30', dot: 'bg-rose-500', text: 'text-rose-300', strong: 'text-rose-200', btn: 'bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border-rose-500/30' },
  success: { box: 'bg-emerald-500/10 border-emerald-500/30', dot: 'bg-emerald-400', text: 'text-emerald-300', strong: 'text-emerald-200', btn: 'bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 border-emerald-500/30' },
};
const ALIASES = { danger: 'error', ok: 'success' };

// `action` renders any control on the right; `onDismiss` adds the standard Dismiss button.
export default function Banner({ tone = 'error', title, onDismiss, action, children }) {
  const key = ALIASES[tone] || tone;
  const t = TONES[key] || TONES.error;
  return (
    <div role={key === 'error' ? 'alert' : 'status'} className={`ui-banner p-4 rounded-xl border flex items-center justify-between gap-4 animate-in ${t.box}`}>
      <div className="flex items-center gap-3 min-w-0">
        <span className={`h-2 w-2 shrink-0 rounded-full ${key === 'success' ? '' : 'animate-pulse'} ${t.dot}`} />
        <p className={`text-sm font-medium ${t.text}`}>
          {title && <strong className={`font-semibold ${t.strong}`}>{title}</strong>} {children}
        </p>
      </div>
      {(action || onDismiss) && (
        <div className="flex items-center gap-2 shrink-0">
          {action}
          {onDismiss && (
            <button type="button" onClick={onDismiss} className={`px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors ${t.btn}`}>
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}
