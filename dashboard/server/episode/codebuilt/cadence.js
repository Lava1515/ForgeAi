// Shot cadence for code-built shorts (KAN-936): 2 to 6 second shots that average about 4.5 seconds, cut on measured word starts, covering the
// whole rendered video (lead + voice + tail). The shot count is not fixed: it follows the measured voice length (about 8 shots for 30 to 40 s).
//
//   planShotCadence(words, lead, { tail, fps })  -> start seconds in video time, first 0, ascending, one per shot
//   shotCountRange(seconds)                      -> { min, target, max } shot counts that can tile `seconds`
//
// The final render profile holds no frames (hold=1, KAN-937), so a cut may sit on any frame: the grid is one frame wide. `hold` stays a parameter
// (default CADENCE_HOLD = 1); with hold=2 cuts would sit on even frames only. A start is written as the largest millisecond value not above its frame
// time, so `f / fps >= start` (timeline.current_shot) and `ceil(start * fps)` (timeline.shot_frame_ranges) both pick that frame.
export const MIN_SHOT_S = 2;
export const MAX_SHOT_S = 6;
export const TARGET_SHOT_S = 4.5;
export const CADENCE_FPS = 30;
export const CADENCE_HOLD = 1;

export class CadenceError extends Error {
  constructor(message) { super(message); this.name = 'CadenceError'; this.code = 'BAD_WORDS'; }
}

/** Shot counts that can tile `seconds` with every shot 2 to 6 s: min = ceil(s / 6), max = floor(s / 2), target = round(s / 4.5) kept inside that range. */
export function shotCountRange(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return { min: 0, target: 0, max: 0 };
  const min = Math.ceil(s / MAX_SHOT_S - 1e-9);
  const max = Math.floor(s / MIN_SHOT_S + 1e-9);
  return { min, max, target: Math.max(min, Math.min(max, Math.round(s / TARGET_SHOT_S))) };
}

/** Start seconds (ms precision, never above the frame time) of a frame index. */
export const startSecondsForFrame = (frame, fps = CADENCE_FPS) => Math.floor((frame / fps) * 1000 + 1e-6) / 1000;
const fmt = (frames, fps) => `${Math.round((frames / fps) * 100) / 100} s`;

/**
 * Chooses the cut times. Dynamic programme over the word starts snapped to the hold grid, minimising the squared distance of every shot length from
 * 4.5 s, with every shot length (first, middle and last) 2 to 6 s. It is exact: it never rejects a set of boundaries that has a valid solution, and
 * it is bounded (each cut looks back only over the 2 to 6 s window, so work is words x about 60 frames, no search over subsets).
 * When no valid cut sequence exists it throws a CadenceError that names the stretch of video where no word start can carry a cut.
 */
export function planShotCadence(words, lead = 0.35, { tail = 1.5, fps = CADENCE_FPS, hold = CADENCE_HOLD } = {}) {
  const list = words?.words;
  if (!words || !Number.isFinite(words.dur) || words.dur <= 0 || !Array.isArray(list) || !list.length) throw new CadenceError('measured words are required for shot cadence');
  if (!Number.isFinite(lead) || lead < 0 || !Number.isFinite(tail) || tail < 0) throw new CadenceError('lead and tail must be finite seconds of 0 or more');
  if (!Number.isInteger(fps) || fps <= 0 || !Number.isInteger(hold) || hold <= 0) throw new CadenceError('fps and hold must be positive integers');
  let previous = -Infinity;
  for (const w of list) {
    if (!w || !Number.isFinite(w.s) || !Number.isFinite(w.e) || w.s < 0 || w.e < w.s) throw new CadenceError('every measured word needs finite start and end times');
    if (w.s < previous) throw new CadenceError('measured words must be in time order');
    previous = w.s;
  }
  // Same arithmetic as timeline.frame_count: int((dur + lead + tail) * fps).
  const end = Math.trunc((words.dur + lead + tail) * fps);
  const lo = Math.ceil(MIN_SHOT_S * fps / hold) * hold; // shortest shot, in frames (kept on the hold grid)
  const hi = Math.floor(MAX_SHOT_S * fps / hold) * hold;
  const goal = TARGET_SHOT_S * fps;
  if (end < lo) throw new CadenceError(`the ${fmt(end, fps)} video is shorter than one ${MIN_SHOT_S} s shot`);
  // Candidate cut frames: a word start in video time, snapped to the nearest hold-grid frame, inside the range that leaves 2 s before and after.
  const nodes = [...new Set(list.map((w) => Math.round(((w.s + lead) * fps) / hold) * hold).filter((f) => f >= lo && f <= end - lo))].sort((a, b) => a - b);
  const frames = [0, ...nodes, end];
  const cost = new Array(frames.length).fill(Infinity);
  const from = new Array(frames.length).fill(-1);
  cost[0] = 0;
  for (let i = 1; i < frames.length; i += 1) {
    for (let j = i - 1; j >= 0; j -= 1) {
      const len = frames[i] - frames[j];
      if (len > hi) break;
      if (len < lo || cost[j] === Infinity) continue;
      const c = cost[j] + (len - goal) ** 2;
      // Predecessors are scanned from the nearest back, and only a strictly cheaper chain replaces one, so equal-cost chains resolve the same way every run.
      if (c < cost[i]) { cost[i] = c; from[i] = j; }
    }
  }
  const last = frames.length - 1;
  if (cost[last] === Infinity) {
    let reach = 0; // furthest cut frame that a valid chain of shots can reach
    for (let i = 0; i < last; i += 1) if (cost[i] !== Infinity) reach = frames[i];
    const from_ = reach + lo; const to_ = Math.min(reach + hi, end - lo);
    const named = from_ > to_
      ? `a cut at ${fmt(reach, fps)} would leave a final shot of ${fmt(end - reach, fps)} (needs ${MIN_SHOT_S} to ${MAX_SHOT_S} s)`
      : `no measured word starts between ${fmt(from_, fps)} and ${fmt(to_, fps)} of the ${fmt(end, fps)} video to cut at after ${fmt(reach, fps)}`;
    throw new CadenceError(`measured word boundaries are too sparse for ${MIN_SHOT_S} to ${MAX_SHOT_S} s shots: ${named}`);
  }
  const starts = [];
  for (let i = last; i > 0; i = from[i]) starts.push(frames[from[i]]);
  return starts.reverse().map((f) => (f === 0 ? 0 : startSecondsForFrame(f, fps)));
}
