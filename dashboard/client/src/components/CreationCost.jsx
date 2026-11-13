import React from 'react';

const amount = (n) => `$${Number(n).toFixed(Number(n) < 0.01 ? 4 : 2)}`;

export default function CreationCost({ cost }) {
  if (!cost) return null;
  const total = cost.estimate_usd == null ? `${cost.reported_tokens ?? 0} tokens` : `${cost.reported_tokens ?? 0} tokens, about ${amount(cost.estimate_usd)} (estimate)`;
  return (
    <details className="text-xs text-ink-300" data-creation-cost>
      <summary className="cursor-pointer">Cost: {total}{cost.estimate_usd != null && <span className="ml-1 text-ink-500">estimate at list price; subscription, not a bill</span>}</summary>
      <div className="overflow-x-auto mt-2"><table className="w-full text-left"><thead><tr><th>Step / model</th><th>Wall s</th><th>Input</th><th>Output</th><th>Usage</th><th>Estimate</th></tr></thead>
        <tbody>{(cost.steps || []).map((row, index) => <tr key={`${row.step}-${index}`}><td>{row.step} · {row.provider} / {row.model}{row.retries ? ` · ${row.retries} retries` : ''}{row.escalated ? ' · escalated' : ''}</td><td>{row.wall_s ?? '—'}</td><td>{row.input_tokens ?? '—'}</td><td>{row.output_tokens ?? '—'}</td><td>{row.tokens_status === 'tokens_not_reported' ? 'tokens not reported' : row.tokens_status === 'partly_reported' ? 'partly reported' : 'reported'}</td><td>{row.estimate_usd == null ? '—' : amount(row.estimate_usd)}</td></tr>)}</tbody>
      </table></div>
      <p className="mt-2 text-ink-500">Render: {cost.render_duration_s == null ? 'not reported' : `${cost.render_duration_s}s`} · Peak VRAM: {cost.peak_vram_mb == null ? 'not reported' : `${cost.peak_vram_mb} MB`}</p>
    </details>
  );
}
