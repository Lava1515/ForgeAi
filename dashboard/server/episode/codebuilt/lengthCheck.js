// KAN-933: requested versus actual finished video length. Pure; no audio is ever stretched to make a video fit.
export const LENGTH_TOLERANCE_S = 10;

/** { requested_s, actual_s, tolerance_s, overrun_s, within_tolerance }, or null when either number is not usable. */
export function lengthCheck(requested, actual, type = 'factual') {
  const r = Number(requested);
  const a = Number(actual);
  if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(a) || a <= 0) return null;
  // codex · gpt-6.1-sol · 2026-11-14: loops have a format limit, no narration tolerance.
  if (type === 'loop') return { requested_s: r, actual_s: Math.round(a * 1000) / 1000, min_s: 6, max_s: 20, within_tolerance: a >= 6 && a <= 20 };
  const actual_s = Math.round(a * 1000) / 1000;
  const overrun_s = Math.round(Math.max(0, actual_s - r) * 1000) / 1000;
  return { requested_s: r, actual_s, tolerance_s: LENGTH_TOLERANCE_S, overrun_s, within_tolerance: a <= r + LENGTH_TOLERANCE_S + 1e-9 && a >= r - ({ 30: 2, 45: 3 }[r] ?? 4) - 1e-9 };
}
