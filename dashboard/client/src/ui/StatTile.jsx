import React from 'react';

export default function StatTile({ label, value, hint, accent = false, ...rest }) {
  return (
    <div className="ui-stat-tile rounded-xl border border-ink-800 bg-ink-900 p-4" {...rest}>
      <div className="label">{label}</div>
      <div className={`ui-stat-tile-value mt-1 font-mono tabular-nums text-2xl font-semibold ${accent ? 'text-ember-300' : 'text-ink-50'}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-ink-500">{hint}</div>}
    </div>
  );
}
