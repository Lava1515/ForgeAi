// Visual loop (KAN-934): which frames of a code-built video to preview. Pure and deterministic. The result is a list
// of even frame numbers (the final render holds every second frame), 12 to 24 of them, with at least one frame
// inside every planned shot, one near the start and one in the last second, and the rest placed at the largest gaps.
// More shots than fit in 24 frames is refused (PREVIEW_COVERAGE_IMPOSSIBLE): a shot the model never saw is not allowed.
// `shotStarts` are seconds in video time, exactly like the planner's SHOT_STARTS.
export const PREVIEW_MIN_FRAMES = 12;
export const PREVIEW_MAX_FRAMES = 24;
const SETTLE = 0.4; // fraction of the way into a shot: after the cut and the first camera move, before the next cut
const OPENING_FRAME = 6; // added when the earliest shot frame is later than the first second

export class PreviewFramesError extends Error {
  constructor(code, message) { super(message); this.name = 'PreviewFramesError'; this.code = code; }
}
const bad = (message) => new PreviewFramesError('BAD_PREVIEW_INPUT', message);
const even = (n) => n - (n % 2);

/** How many preview frames to aim for: two per shot plus two, clamped to 12..24. */
export const previewFrameCount = (shots) => Math.min(PREVIEW_MAX_FRAMES, Math.max(PREVIEW_MIN_FRAMES, shots * 2 + 2));

export function pickPreviewFrames(input) {
  if (!input || typeof input !== 'object') throw bad('input must be an object');
  const { nframes, shotStarts, count, fps = 30 } = input;
  if (!Number.isInteger(nframes) || nframes < 24) throw bad('nframes must be an integer of at least 24');
  if (!Number.isFinite(fps) || fps <= 0) throw bad('fps must be a positive number');
  if (!Array.isArray(shotStarts) || shotStarts.length === 0) throw bad('shotStarts must be a non-empty array of seconds');
  const starts = shotStarts.map((s) => {
    if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) throw bad('shotStarts must be finite seconds >= 0');
    return Math.round(s * fps);
  });
  for (let i = 0; i < starts.length; i += 1) {
    if (starts[i] >= nframes - 2) throw bad('a shot starts at or after the last frames of the video');
    if (i > 0 && starts[i] <= starts[i - 1]) throw bad('shotStarts must be strictly increasing');
  }
  const lastEven = even(nframes - 1);
  const required = new Set();
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : nframes;
    let frame = even(Math.round(start + (end - start) * SETTLE));
    if (frame <= start && start + 2 < end) frame = even(start + 2);
    required.add(Math.min(frame, lastEven));
  });
  if (required.size < starts.length) throw bad('two shots are too short to each get their own preview frame');
  if (Math.min(...required) > fps) required.add(OPENING_FRAME);
  if (Math.max(...required) < nframes - fps) required.add(lastEven);
  if (required.size > PREVIEW_MAX_FRAMES) {
    throw new PreviewFramesError('PREVIEW_COVERAGE_IMPOSSIBLE', `${required.size} frames are needed to show every shot, more than the ${PREVIEW_MAX_FRAMES} allowed`);
  }
  const asked = count === undefined ? previewFrameCount(starts.length) : Math.trunc(Number(count)) || 0;
  const wanted = Math.min(PREVIEW_MAX_FRAMES, Math.max(PREVIEW_MIN_FRAMES, asked));
  const picked = new Set(required);
  while (picked.size < wanted) {
    const pts = [0, ...[...picked].sort((a, b) => a - b), lastEven];
    let best = null;
    for (let i = 1; i < pts.length; i += 1) {
      const gap = pts[i] - pts[i - 1];
      if (gap >= 4 && (best === null || gap > best.gap)) best = { gap, at: even(Math.round((pts[i] + pts[i - 1]) / 2)) };
    }
    if (best === null || picked.has(best.at)) break;
    picked.add(best.at);
  }
  return [...picked].sort((a, b) => a - b);
}

// claude-pro · claude-sonnet-5-5 · 2026-11-18 17:55 +02:00 (Fable check 2, fix 3). Route `authored` only; the classic pickPreviewFrames above is untouched.
// The author must see each big, tag, bars and counter text once: every such window (seconds, from the current overlay spec) holds at least one
// preview frame. Shot frames come first; a window that already holds a picked frame needs no new one; the rest get their middle (an even frame).
// When the 24-frame cap leaves windows without a frame they are returned in `uncovered` and the caller says so to the author; nothing throws.
export const COVERED_KINDS = ['big', 'tag', 'bars', 'counter'];
export function overlayWindows(spec) {
  const out = [];
  if (!spec || typeof spec !== 'object') return out;
  for (const kind of COVERED_KINDS) {
    const items = kind === 'tag' || kind === 'counter' ? (spec[kind] ? [spec[kind]] : []) : (Array.isArray(spec[kind]) ? spec[kind] : []);
    items.forEach((el, i) => {
      if (el && Number.isFinite(el.from) && Number.isFinite(el.to) && el.to > el.from) out.push({ id: kind === 'tag' || kind === 'counter' ? kind : `${kind}[${i}]`, from: el.from, to: el.to });
    });
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}
const frameInside = (frame, w, fps) => frame / fps >= w.from && frame / fps < w.to;
export function pickAuthoredPreviewFrames(input) {
  const { overlaySpec, nframes, fps = 30 } = input;
  const base = pickPreviewFrames(input);
  const windows = overlayWindows(overlaySpec);
  const picked = new Set(base);
  const uncovered = [];
  const lastEven = even(nframes - 1);
  for (const w of windows) {
    if ([...picked].some((f) => frameInside(f, w, fps))) continue;
    // Smallest even frame inside the window nearest to its middle: the text has faded in and has not started to fade out.
    const first = Math.ceil(w.from * fps), last = Math.min(Math.ceil(w.to * fps) - 1, lastEven);
    let frame = even(Math.round(((w.from + w.to) / 2) * fps));
    if (frame < first) frame += 2;
    if (frame > last) frame -= 2;
    if (frame < first || frame > last || frame < 0 || picked.size >= PREVIEW_MAX_FRAMES) { uncovered.push(w.id); continue; }
    picked.add(frame);
  }
  return { frames: [...picked].sort((a, b) => a - b), uncovered };
}
