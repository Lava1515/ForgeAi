// KAN-928 (CB16): one sanitized cost record per router attempt, shared by the single-job starter and the batch coordinator.
// askRole's onCallRecord sink gives role, provider, model, tokens, wall time and status; only these fixed fields are kept, never text, errors or paths.
// The shape is the one start.js writes to cost_calls.json (normalizeJobCalls reads it), so a theme or fact-check attempt is costed like a script attempt.
const scalar = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);

export function sanitizeRouterCall(record) {
  if (!record || typeof record !== 'object') return null;
  const tokens = record.tokens;
  return {
    step: text(record.step), provider: text(record.provider), model: text(record.model),
    wall_s: Number.isFinite(record.wall_s) && record.wall_s >= 0 ? record.wall_s : null,
    input_tokens: scalar(tokens?.input ?? record.input_tokens), output_tokens: scalar(tokens?.output ?? record.output_tokens),
    retries: scalar(record.retries) ?? 0, status: text(record.status), trigger: text(record.trigger), escalated: record.escalated === true,
  };
}
