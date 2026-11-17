// Visual loop (KAN-934): the host wrapper around narrative_factory/codebuilt/post/preview_sheet.py. It runs only after the offline
// container is gone, on frames the runner already confined and checked (collectPreview). The argv is fixed apart from three
// absolute paths and a 5-character code; no shell, and the child gets a scrubbed environment (no token, no key).
// The result is re-checked on disk: the script is host code, but the folder it writes to is read back like any other output.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LoopError } from './loopErrors.js';
import { REPO_ROOT } from '../engines/codebuilt/launch.js';

const SAFE_ENV_KEYS = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'LANG'];
const CODE_RE = /^[A-Z0-9]{5}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHEET_RE = /^sheet_[1-9]\.jpg$/;
const MAX_SHEET_BYTES = 3 * 1024 * 1024;
const MAX_CANARY_BYTES = 512 * 1024;
const fail = (message) => new LoopError('sheet_failed', message);
const inside = (parent, child) => { const rel = path.relative(parent, child); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };

function safeEnv(env) {
  const out = {};
  for (const key of SAFE_ENV_KEYS) if (typeof env[key] === 'string') out[key] = env[key];
  return out;
}

function regularBytes(file, maxBytes) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size === 0 || st.size > maxBytes) throw fail('an output file is not a regular file of a sane size');
  return fs.readFileSync(file);
}

export function createPreviewSheetMaker({ repoRoot = REPO_ROOT, python = 'python', execFileFn, env = process.env, timeoutMs = 2 * 60 * 1000 } = {}) {
  if (typeof execFileFn !== 'function') throw new TypeError('execFileFn must be passed in by the composition');
  const script = path.join(path.resolve(repoRoot), 'narrative_factory', 'codebuilt', 'post', 'preview_sheet.py');

  function run(args, signal) {
    return new Promise((resolve, reject) => {
      const child = execFileFn(python, ['-I', script, ...args], { timeout: timeoutMs, windowsHide: true, shell: false, env: safeEnv(env), maxBuffer: 256 * 1024, signal }, (error, out) => {
        let body = null;
        try { body = JSON.parse(String(out).trim().split(/\r?\n/).pop()); } catch { /* handled below */ }
        if (error) return reject(fail(body?.error || 'the sheet script failed'));
        if (!body || body.status !== 'ok') return reject(fail('the sheet script did not report ok'));
        return resolve(body);
      });
      child?.on?.('error', () => {});
    });
  }

  async function makeSheets({ framesDir, outDir, code, signal, words, overlaySpec, anchors, lead, nframes, fps, jobRoot } = {}) {
    if (typeof framesDir !== 'string' || !path.isAbsolute(framesDir) || typeof outDir !== 'string' || !path.isAbsolute(outDir)) throw fail('framesDir and outDir must be absolute');
    if (typeof code !== 'string' || !CODE_RE.test(code)) throw fail('code must be 5 characters A-Z or 0-9');
    for (const [name, file] of [['words', words], ['overlaySpec', overlaySpec], ['anchors', anchors], ['jobRoot', jobRoot]]) {
      if (file !== undefined && (typeof file !== 'string' || !path.isAbsolute(file))) throw fail(`${name} must be absolute`);
    }
    if (overlaySpec && (!Number.isInteger(nframes) || nframes < 1)) throw fail('nframes must be a positive whole number with overlaySpec');
    const frames = path.resolve(framesDir); const out = path.resolve(outDir);
    if (frames === out || inside(frames, out) || inside(out, frames)) throw fail('the sheet folder must be separate from the frames folder');
    fs.mkdirSync(out, { recursive: true });
    for (const entry of fs.readdirSync(out)) { // a rerun replaces its own earlier sheets, nothing else
      if (SHEET_RE.test(entry) && fs.lstatSync(path.join(out, entry)).isFile()) fs.unlinkSync(path.join(out, entry));
    }
    const args = ['sheets', frames, out, code];
    if (words) args.push('--words', path.resolve(words), '--lead', String(lead ?? 0));
    if (overlaySpec) args.push('--overlay', path.resolve(overlaySpec), '--nframes', String(nframes), '--fps', String(fps ?? 30), '--job-root', path.resolve(jobRoot));
    if (anchors) args.push('--anchors', path.resolve(anchors));
    const body = await run(args, signal);
    if (!Array.isArray(body.sheets) || body.sheets.length < 1 || body.sheets.length > 2) throw fail('the sheet script reported an unexpected number of sheets');
    const names = body.sheets.map((s) => s?.file);
    if (names.some((n) => typeof n !== 'string' || !SHEET_RE.test(n)) || new Set(names).size !== names.length) throw fail('the sheet script reported unexpected file names');
    const onDisk = fs.readdirSync(out).sort();
    if (JSON.stringify(onDisk) !== JSON.stringify([...names].sort())) throw fail('the sheet folder does not hold exactly the reported sheets');
    return body.sheets.map((s) => {
      if (s.code !== code || !Number.isInteger(s.w) || !Number.isInteger(s.h) || !Array.isArray(s.tiles) || s.tiles.length < 1) throw fail('a reported sheet is malformed');
      const file = path.join(out, s.file);
      const bytes = regularBytes(file, MAX_SHEET_BYTES);
      if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) throw fail('a sheet is not a JPEG');
      return {
        file: s.file, path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, w: s.w, h: s.h, code,
        // Measured per tile by the sheet script (mean luma, spread, blown share, and a flag for a flat, dark or blown frame); absent from an older script.
        tiles: s.tiles.map((t) => ({ n: t.n, frame: t.frame, ...(['flat', 'dark', 'blown', 'plain'].includes(t.flag) ? { flag: t.flag } : {}), ...(Number.isFinite(t.luma) ? { luma: t.luma } : {}), ...(Number.isFinite(t.spread) ? { spread: t.spread } : {}) })),
        layout_findings: Array.isArray(s.layout_findings) ? s.layout_findings : [],
      };
    });
  }

  async function makeCanary({ nonce, outFile, signal } = {}) {
    if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) throw fail('nonce must be 1-64 letters, digits, - or _');
    if (typeof outFile !== 'string' || !path.isAbsolute(outFile) || !/\.png$/i.test(outFile)) throw fail('outFile must be an absolute .png path');
    const file = path.resolve(outFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = await run(['canary', nonce, file], signal);
    const quadrants = body.quadrants;
    if (typeof body.code !== 'string' || !CODE_RE.test(body.code) || !quadrants || typeof quadrants !== 'object') throw fail('the canary report is malformed');
    const bytes = regularBytes(file, MAX_CANARY_BYTES);
    if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw fail('the canary is not a PNG');
    return { file, code: body.code, quadrants: { ...quadrants }, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  }

  return Object.freeze({ makeSheets, makeCanary });
}
