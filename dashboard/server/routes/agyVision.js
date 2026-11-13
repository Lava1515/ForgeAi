import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getAgyStatus } from './antigravityCli.js';

// Vision checks through the Antigravity CLI: the images are written into a throwaway folder inside agy's workspace,
// agy opens them with its read_file tool (allowed for those files only) and answers with JSON.
// antigravityCli.js is not edited, so the few bits askAgy keeps private (env scrub, envelope parse) are copied here.
const OTHER_AUTH_ENV = [
  'GEMINI_API_KEY', 'GEMINI_API_KEYS', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID',
];
const AGY_TIMEOUT_S = 120; // a check took ~15 s by hand
const STALE_MS = 3600000;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const unavailable = (message) => Object.assign(new Error(message), { unavailable: true });

export const agyVisionEnabled = () => process.env.AGY_VISION === '1';

function readAgyJson(out) {
  try {
    return JSON.parse(out.slice(out.lastIndexOf('\n{') + 1));
  } catch {
    return null;
  }
}

// Crash leftovers: folders from earlier calls that never got removed.
function sweepStale(workspace) {
  for (const name of fs.readdirSync(workspace)) {
    if (!/^vision-[0-9a-f]+$/.test(name)) continue;
    try {
      const dir = path.join(workspace, name);
      if (Date.now() - fs.statSync(dir).mtimeMs > STALE_MS) fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

// images: [{ mime, data(base64) }]. Resolves with agy's raw answer text, like askAgy. Rejects like askAgy:
// unavailable (agy can't run) / timedOut / badEnvelope / quota or other failures by message.
export async function askAgyVision(instruction, images, { timeoutMs = (AGY_TIMEOUT_S + 10) * 1000, graceMs = 5000, spawnFn = spawn } = {}) {
  const status = getAgyStatus();
  if (!status.ready) throw unavailable(status.reason);
  if (!images?.length) throw unavailable('No images to look at');
  const exts = images.map((i) => EXT[i?.mime]);
  if (exts.some((e, i) => !e || typeof images[i].data !== 'string')) throw unavailable('Unsupported image for Antigravity CLI');

  const workspace = path.join(process.env.AGY_HOME, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  sweepStale(workspace);
  const dir = path.join(workspace, `vision-${crypto.randomBytes(8).toString('hex')}`);
  fs.mkdirSync(dir);
  try {
    const names = images.map((img, i) => {
      const name = `image_${i + 1}.${exts[i]}`;
      fs.writeFileSync(path.join(dir, name), Buffer.from(img.data, 'base64'));
      return name;
    });
    const prompt = `${instruction}\n\nThe image file(s) to look at are in the current folder: ${names.join(', ')}. `
      + 'Open exactly those files by name with read_file, then answer with only the JSON object described above. '
      + 'Do not use any other tool, do not open other files and do not write files.';
    // Relative names and a folder glob were accepted by agy; a single absolute file path was not.
    const allow = [...names.flatMap((n) => [`read_file(${n})`, `read_file(./${n})`]), `read_file(${dir}/*)`];
    const args = ['-p', prompt, '--output-format', 'json', '--disable-slash-commands', '--print-timeout', `${AGY_TIMEOUT_S}s`,
      '--settings', JSON.stringify({ permissions: { allow } })];
    const env = { ...process.env, HOME: process.env.AGY_HOME };
    for (const k of OTHER_AUTH_ENV) delete env[k];
    return await run(spawnFn, args, { cwd: dir, env }, timeoutMs, graceMs);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(spawnFn, args, opts, timeoutMs, graceMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawnFn('agy', args, opts);
    let out = '';
    let err = '';
    let timedOut = false;
    let graceTimer = null;
    let closed = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (closed) return;
      try { child.kill('SIGTERM'); } catch {}
      graceTimer = setTimeout(() => { if (!closed) try { child.kill('SIGKILL'); } catch {} }, graceMs);
    }, timeoutMs);
    const cleanup = () => {
      closed = true;
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
    };
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.once('exit', cleanup);
    child.on('error', (e) => {
      cleanup();
      reject(unavailable(`Couldn't start Antigravity CLI (${e.code || e.message})`));
    });
    child.on('close', (code, signal) => {
      cleanup();
      const body = readAgyJson(out);
      if (code === 0 && body?.response?.trim()) return resolve(body.response);
      // An agy build that lacks a flag we pass (e.g. --settings on 1.3.x) exits 2 with its usage text: that is "agy
      // can't be used", so askGemini hands the call to the API and logs this message (it must not read as quota/auth).
      if (code !== 0 && /flags? provided but not defined|^\s*Usage of agy/im.test(`${err}\n${out}`)) {
        const flag = /flags? provided but not defined: (\S+)/i.exec(`${err}\n${out}`)?.[1];
        return reject(unavailable(`Antigravity CLI is too old for the options we pass${flag ? ` (${flag} not supported)` : ''}; update agy`));
      }
      const lines = `${err}\n${out}`.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('{') && !l.startsWith('at '));
      const denied = body?.denied_actions?.length ? `it wanted tools (${body.denied_actions.map((a) => a.action).join(', ')})` : '';
      const isTimeout = timedOut || (Date.now() - started >= AGY_TIMEOUT_S * 1000);
      const why = (isTimeout ? `timed out after ${AGY_TIMEOUT_S}s` : '') || body?.error?.message || body?.error
        || lines.find((l) => /error|denied|not logged/i.test(l)) || denied
        || (body ? `empty answer (${body.status})` : '') || lines.pop() || (signal ? `stopped (${signal})` : `exit ${code}`);
      const failure = new Error(`Antigravity CLI failed: ${why}`);
      if (isTimeout) failure.timedOut = true;
      if (!body && code === 0) failure.badEnvelope = true;
      reject(failure);
    });
  });
}
