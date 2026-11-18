// codex · gpt-6.1-sol · 2026-11-18 19:41 +0200
// claude-pro Â· claude-sonnet-5-5 Â· 2026-11-18 17:55 +02:00
// Host wrapper for the all-frame text layout check of the authored route (Fable check 2, fixes 1 and 6).
// layout_gate.py runs the post step's own layout algorithm on every frame of the video, on the host CPU, with a fixed argv, no shell and a
// scrubbed environment. The result is saved in the round's look.json and bound into the receipt, so an accepted pair that never passed
// this check cannot be reused.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { authorError } from './authorCall.js';
import { REPO_ROOT } from '../engines/codebuilt/launch.js';

const SAFE_ENV_KEYS = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'LANG'];
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (message) => Object.assign(authorError('author_layout_unavailable'), { detail: { reason: String(message).slice(0, 300) } });
const secs = (frame, fps) => (frame / fps).toFixed(1);

function safeEnv(env) {
  const out = {};
  for (const key of SAFE_ENV_KEYS) if (typeof env[key] === 'string') out[key] = env[key];
  return out;
}

/**
 * The text a blocking result gives back to the author, or '' when the layout is fine. Pure.
 * Blocks on: any blocking overlap / outside_safe_zone / caption_overlap on any frame, and canonical whole-window camera visibility, and any text window with no preview frame (`uncovered`).
 */
export function layoutRefusal(layout) {
  if (!layout || layout.version !== 1 || typeof layout.ok !== 'boolean' || !Array.isArray(layout.blocking) || !Array.isArray(layout.labelHidden) || !Array.isArray(layout.uncovered)) return 'the host layout check is missing or malformed';
  const fps = Number.isFinite(layout.fps) && layout.fps > 0 ? layout.fps : 30;
  const lines = layout.blocking.slice(0, 12).map((b) => `${String(b.code).slice(0, 30)} ${(b.elements ?? []).slice(0, 4).join(' + ')}: frames ${b.first_frame}-${b.last_frame} (${secs(b.first_frame, fps)}-${secs(b.last_frame, fps)} s)`);
  // codex · gpt-6.1-sol · 2026-11-18 19:36 +0200: only canonical blocking decides visibility refusal.
  const uncovered = layout.uncovered.slice(0, 40).map((id) => String(id).slice(0, 30));
  if (uncovered.length) lines.push(`preview_uncovered ${uncovered.join(', ')}: no preview frame inside ${uncovered.length === 1 ? 'its window' : 'their windows'} (24-frame cap), so the sheets never show ${uncovered.length === 1 ? 'it' : 'them'}`);
  if (layout.ok === false && !layout.blocking.length) lines.push('the layout check reports not ok');
  if (!lines.length) return '';
  return `HOST LAYOUT CHECK, measured on all ${layout.framesChecked} frames of the final video, blocks this pair: ${lines.join('; ')}. A pass is not accepted: the final render refuses a blocking overlap, and a text window that no sheet showed is unchecked. Repair the overlay spec: move or shorten one of the named windows, shorten the text, mark the label's point where the camera sees it, or widen, merge or drop windows (a preview shows even frames only and at most 24 frames fit) so every window holds a preview frame. Name the element and its new window in notes.`;
}

/** What a saved layout record must hold for a receipt to count: the check ran on this exact spec, words and frame count. */
export function layoutBound(layout, { overlaySha256, wordsSha256, nframes }) {
  return !!layout && layout.version === 1 && layout.inputs?.overlaySha256 === overlaySha256 && layout.framesChecked === nframes
    && (layout.inputs?.wordsSha256 ?? null) === (wordsSha256 ?? null) && layoutRefusal(layout) === '';
}

export function createLayoutGate({ repoRoot = REPO_ROOT, python = 'python', execFileFn, env = process.env, timeoutMs = 60 * 1000 } = {}) {
  if (typeof execFileFn !== 'function') throw new TypeError('execFileFn must be passed in by the composition');
  const script = path.join(path.resolve(repoRoot), 'dashboard', 'server', 'episode', 'codebuilt', 'layout_gate.py');
  const abs = (name, file) => { if (typeof file !== 'string' || !path.isAbsolute(file)) throw fail(`${name} must be absolute`); return path.resolve(file); };

  /** Runs the layout algorithm on every frame. Rejects (layout_unavailable) when the check cannot run: the caller must then fail closed. */
  async function check({ overlaySpec, anchors, words, nframes, fps = 30, jobRoot, frames = [], lead = 0.35, signal } = {}) {
    if (!Number.isInteger(nframes) || nframes < 1) throw fail('nframes must be a positive whole number');
    if (!Number.isFinite(fps) || fps <= 0) throw fail('fps must be positive');
    // `frames: 'all'` (C2-AUTH-1): every frame, for an anchors file that holds the positions of every frame.
    if (frames !== 'all' && (!Array.isArray(frames) || frames.some((f) => !Number.isInteger(f) || f < 0))) throw fail('frames must be whole numbers or "all"');
    const args = ['-I', script, '--overlay', abs('overlaySpec', overlaySpec), '--nframes', String(nframes), '--fps', String(fps), '--job-root', abs('jobRoot', jobRoot), '--frames', frames === 'all' ? 'all' : frames.join(',')];
    let wordsSha256 = null, anchorsSha256 = null;
    if (words !== undefined) { args.push('--words', abs('words', words), '--lead', String(lead)); wordsSha256 = sha(fs.readFileSync(words)); }
    if (anchors !== undefined) { args.push('--anchors', abs('anchors', anchors)); anchorsSha256 = sha(fs.readFileSync(anchors)); }
    const overlaySha256 = sha(fs.readFileSync(overlaySpec));
    const body = await new Promise((resolve, reject) => {
      const child = execFileFn(python, args, { timeout: timeoutMs, windowsHide: true, shell: false, env: safeEnv(env), maxBuffer: 256 * 1024, signal }, (error, out) => {
        let parsed = null;
        try { parsed = JSON.parse(String(out).trim().split(/\r?\n/).pop()); } catch { /* handled below */ }
        if (error && !parsed) return reject(fail('the layout script failed'));
        if (!parsed || parsed.status !== 'ok') return reject(fail(parsed?.error ? String(parsed.error).slice(0, 300) : 'the layout script did not report ok'));
        return resolve(parsed);
      });
      child?.on?.('error', () => {});
    });
    if (body.version !== 1 || body.frames_checked !== nframes || !Array.isArray(body.blocking) || !Array.isArray(body.label_hidden) || typeof body.ok !== 'boolean') throw fail('the layout report is malformed');
    return {
      version: 1, ok: body.ok, framesChecked: body.frames_checked, fps: body.fps, previewFrames: body.preview_frames, anchoredFrames: body.anchored_frames,
      blocking: body.blocking.slice(0, 40).map((b) => ({ code: String(b.code), elements: (b.elements ?? []).map(String).slice(0, 4), first_frame: b.first_frame, last_frame: b.last_frame, frames: b.frames })),
      // Canonical advisories (partly hidden pin, crowded-out label, counter reversal): kept in the receipt, never a refusal.
      findings: (Array.isArray(body.findings) ? body.findings : []).slice(0, 40).map((f) => ({ code: String(f.code).slice(0, 30), elements: (f.elements ?? []).map(String).slice(0, 4), ...(Number.isFinite(f.share) ? { share: f.share } : {}), ...(Number.isFinite(f.frames) ? { frames: f.frames } : {}), ...(Number.isFinite(f.first_frame) ? { first_frame: f.first_frame } : {}), ...(Number.isFinite(f.last_frame) ? { last_frame: f.last_frame } : {}) })),
      labelHidden: body.label_hidden.slice(0, 24).map((h) => ({ element: String(h.element), share: h.share, frames: h.frames })),
      inputs: { overlaySha256, anchorsSha256, wordsSha256 },
    };
  }
  return Object.freeze({ check });
}
