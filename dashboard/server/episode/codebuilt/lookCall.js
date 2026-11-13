// Visual loop (KAN-934): the host CLI call that hands contact sheets to the model, and the one-time probe that proves the
// installed CLI really accepts images before anything is built on that. The model process stays on the host, on the existing
// subscription login (no API key: the auth env vars are removed exactly as claudeEnv() does); every line of generated code still
// runs only in the offline job. This is a controller loop around a model call, not an agent session with tools.
//
// Transport (proven once against the installed CLI v2.1.322, canary of 2026-11-13, see docs/codebuilt-isolation.md):
//   claude -p --input-format stream-json --output-format stream-json --verbose --model <m> --tools "" --no-session-persistence
//          --disable-slash-commands --strict-mcp-config
// stdin = ONE user message whose content is image blocks (base64) followed by the text. The init event of that run reported
// tools: [], mcp_servers: [], skills: []. Nothing else is read or written by the model: it has no file tool at all. A read-tool
// fallback was NOT built because inline images work (and a Read tool would need a proven confined folder).
//
// A receipt proves delivery (this prompt and these image bytes went to this model call with these flags), not judgement.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { binPath, claudeEnv, usageFrom } from '../../routes/claudeCli.js';
import { LoopError } from './loopErrors.js';

export const LOOK_TRANSPORT = 'stdin-image-blocks';
export const LOOK_TIMEOUT_MS = 10 * 60 * 1000;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PROMPT_CHARS = 200000;
const MAX_OUTPUT_CHARS = 20 * 1024 * 1024;
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png']);
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** The exact argv (after the program name). The model is the only variable; it is checked like askClaude checks it. */
export function lookArgv(model) {
  if (typeof model !== 'string' || !MODEL_RE.test(model)) throw new TypeError('Invalid Claude model name');
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', model, '--tools', '',
    '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config',
  ];
}

/** On Windows the CLI is a .cmd file started through the shell, which only concatenates arguments: an empty one has to be written as "". */
export function shellArgs(args, platform = process.platform) {
  if (platform !== 'win32') return [...args];
  return args.map((arg) => {
    if (arg === '') return '""';
    if (!/^[A-Za-z0-9._:=/\\-]+$/.test(arg)) throw new TypeError('argument is not safe to pass through the Windows shell');
    return arg;
  });
}

/** Ends the CLI and every process it started. Never throws. */
export function killTree(child, { platform = process.platform, execFileFn = execFile, killFn = process.kill.bind(process) } = {}) {
  const pid = child?.pid;
  try {
    if (platform === 'win32') {
      if (Number.isInteger(pid)) { execFileFn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); return; }
    } else if (Number.isInteger(pid)) {
      killFn(-pid, 'SIGKILL');
      return;
    }
  } catch { /* fall through to the plain kill */ }
  try { child?.kill?.('SIGKILL'); } catch { /* already gone */ }
}

function checkInputs(prompt, images, model) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS) throw new TypeError('prompt must be a non-empty string of at most 200000 characters');
  if (!Array.isArray(images) || images.length < 1 || images.length > MAX_IMAGES) throw new TypeError(`images must be a list of 1..${MAX_IMAGES} items`);
  for (const image of images) {
    if (!image || !Buffer.isBuffer(image.bytes) || image.bytes.length < 1 || image.bytes.length > MAX_IMAGE_BYTES || !MEDIA_TYPES.has(image.mediaType)) {
      throw new TypeError('each image needs bytes (a Buffer up to 5 MB) and a mediaType of image/jpeg or image/png');
    }
  }
  return lookArgv(model);
}

function parseEvents(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try { events.push(JSON.parse(trimmed)); } catch { /* a partial or non-JSON line is not an event */ }
  }
  return events;
}

function failure(message, flags = {}) {
  return Object.assign(new Error(message), flags);
}

/**
 * One fresh CLI call with images. Resolves { text, usage, model, receipt, wallMs }. Rejects with an Error carrying .unavailable
 * (not installed / not logged in), .quota (usage limit), .timedOut, .aborted or .code === 'tools_offered'.
 * Options: model (required), timeoutMs, signal, and for tests spawnFn, claudeHome, platform, killTreeFn.
 */
export function askClaudeLook(prompt, images, options = {}) {
  try { return startLook(prompt, images, options); } catch (error) { return Promise.reject(error); } // bad input is a rejection, never a throw
}

function startLook(prompt, images, {
  model, timeoutMs = LOOK_TIMEOUT_MS, signal, spawnFn = spawn, claudeHome, platform = process.platform, killTreeFn = killTree,
} = {}) {
  const argv = checkInputs(prompt, images, model);
  if (signal?.aborted) return Promise.reject(failure('Claude CLI look aborted before start', { aborted: true }));
  const env = claudeEnv();
  const home = claudeHome ?? env.HOME;
  if (!home) return Promise.reject(failure('Claude CLI is not set up', { unavailable: true }));
  const workspace = path.join(home, 'workspace'); // an empty folder: the model has no file tool, but nothing is lying around either
  fs.mkdirSync(workspace, { recursive: true });
  const started = Date.now();
  const message = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.bytes.toString('base64') } })), { type: 'text', text: prompt }] },
  });

  return new Promise((resolve, reject) => {
    let out = ''; let err = ''; let timedOut = false; let aborted = false; let settled = false; let timer; let onAbort;
    const win = platform === 'win32';
    const bin = binPath();
    let child;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    try {
      child = spawnFn(win && /\s/.test(bin) ? `"${bin}"` : bin, shellArgs(argv, platform), { env: { ...env, HOME: home }, cwd: workspace, shell: win, windowsHide: true, detached: !win });
    } catch (error) {
      return finish(reject, failure(`Couldn't start Claude CLI (${error?.code || error?.message})`, { unavailable: true }));
    }
    timer = setTimeout(() => { timedOut = true; killTreeFn(child); }, timeoutMs);
    onAbort = () => { aborted = true; killTreeFn(child); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d) => { if (out.length < MAX_OUTPUT_CHARS) out += d; });
    child.stderr?.on('data', (d) => { if (err.length < 64 * 1024) err += d; });
    child.on('error', (error) => finish(reject, failure(`Couldn't start Claude CLI (${error?.code || error?.message})`, { unavailable: true })));
    child.on('close', (code) => {
      if (aborted) return finish(reject, failure('Claude CLI look aborted', { aborted: true }));
      if (timedOut) return finish(reject, failure(`Claude CLI look timed out after ${Math.round(timeoutMs / 1000)}s`, { timedOut: true }));
      const events = parseEvents(out);
      const init = events.find((e) => e.type === 'system' && e.subtype === 'init') ?? null;
      const res = [...events].reverse().find((e) => e.type === 'result') ?? null;
      const text = String(res?.result ?? '').trim();
      if (code !== 0 || !res || res.is_error || !text) {
        const why = (text || String(err).trim().split('\n').pop() || String(out).trim().split('\n').pop() || `exit ${code}`).slice(0, 300);
        const flags = {};
        if (/not logged in|\/login|authenticat/i.test(why)) flags.unavailable = true;
        if (/usage limit|rate limit|limit reached|quota/i.test(why)) flags.quota = true;
        return finish(reject, failure(`Claude CLI failed: ${why}`, flags));
      }
      const offered = { tools: init?.tools?.length ?? 0, mcp: init?.mcp_servers?.length ?? 0, skills: init?.skills?.length ?? 0 };
      if (!init || offered.tools || offered.mcp || offered.skills) {
        return finish(reject, failure('Claude CLI offered tools, MCP servers or skills to the look call, or did not say; refusing', { code: 'tools_offered' }));
      }
      return finish(resolve, {
        text,
        usage: usageFrom(res),
        model: init.model ?? model,
        wallMs: Date.now() - started,
        receipt: {
          noSessionPersistence: argv.includes('--no-session-persistence'),
          transport: LOOK_TRANSPORT,
          argvSha256: sha256(JSON.stringify(argv)),
          promptSha256: sha256(prompt),
          imageCount: images.length,
          imageSha256: images.map((i) => sha256(i.bytes)),
          cliVersion: init.claude_code_version ?? null,
          toolsOffered: offered.tools,
          model: init.model ?? model,
        },
      });
    });
    child.stdin?.end(`${message}\n`);
  });
}

/** `claude --version` as a version string (no model call), or null when it cannot be read. */
export function readCliVersion({ spawnFn = spawn, platform = process.platform, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let out = ''; let done = false;
    const end = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let child;
    try { child = spawnFn(binPath(), shellArgs(['--version'], platform), { env: claudeEnv(), shell: platform === 'win32', windowsHide: true }); } catch { return resolve(null); }
    const timer = setTimeout(() => { killTree(child); end(null); }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d; });
    child.on('error', () => end(null));
    child.on('close', () => end(/(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null));
  });
}

// ---- the vision probe --------------------------------------------------------------------------------------------------------
const probeCache = new Map();
export const resetProbeCache = () => probeCache.clear();
const POSITIONS = ['top_left', 'top_right', 'bottom_left', 'bottom_right'];
export const PROBE_PROMPT = 'The image shows a 5-character code written at the top and four coloured rectangles in a 2 by 2 grid below it. Reply with JSON only, nothing else: {"code": "<the 5 character code>", "quadrants": {"top_left": "<color>", "top_right": "<color>", "bottom_left": "<color>", "bottom_right": "<color>"}}. Use the colour names red, green, blue or yellow.';

function lenientJson(text) {
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/**
 * Proves, once per process and CLI version, that the installed CLI accepts images through this transport: a canary PNG with a
 * random code and four colours (made from a fresh nonce) must come back exactly. Writes <stageDir>/probe.json either way.
 * Rejects with LoopError('look_unavailable') and never falls back to numbers or to another model.
 */
export async function probeLookSupport({
  nonce, stageDir, makeCanary, askFn, cliVersion = readCliVersion, clock = () => new Date().toISOString(), model = 'sonnet', signal,
} = {}) {
  const version = (await cliVersion()) ?? 'unknown';
  const key = `${version}|${LOOK_TRANSPORT}`;
  fs.mkdirSync(stageDir, { recursive: true });
  const probeFile = path.join(stageDir, 'probe.json');
  const write = (body) => fs.writeFileSync(probeFile, `${JSON.stringify(body, null, 2)}\n`);
  if (probeCache.has(key)) {
    const cached = probeCache.get(key);
    write({ ...cached, cached: true, at: clock() });
    return { ...cached, cached: true };
  }
  const canary = await makeCanary({ nonce, outFile: path.join(stageDir, 'probe-canary.png'), signal });
  const expected = { code: canary.code, quadrants: { ...canary.quadrants } };
  const base = { cliVersion: version, transport: LOOK_TRANSPORT, imageSha256: canary.sha256, expected, at: clock() };
  const stop = (reason, extra = {}) => {
    write({ ...base, passed: false, reason, ...extra });
    return new LoopError('look_unavailable', `the vision probe did not pass (${reason})`, { reason });
  };
  let reply;
  try {
    reply = await askFn(PROBE_PROMPT, [{ bytes: fs.readFileSync(canary.file), mediaType: 'image/png' }], { model, timeoutMs: 120000, signal });
  } catch (error) {
    if (error?.aborted) throw new LoopError('aborted', 'aborted during the vision probe');
    throw stop(error?.quota ? 'quota' : error?.unavailable ? 'unavailable' : error?.timedOut ? 'timeout' : 'error');
  }
  const receipt = reply?.receipt ?? {};
  if (receipt.noSessionPersistence !== true || receipt.transport !== LOOK_TRANSPORT || receipt.toolsOffered !== 0) throw stop('receipt', { receipt });
  const got = lenientJson(String(reply.text ?? ''));
  const gotQuadrants = got?.quadrants && typeof got.quadrants === 'object' ? got.quadrants : null;
  const gotShape = { code: typeof got?.code === 'string' ? got.code : null, quadrants: gotQuadrants };
  const same = gotShape.code === expected.code && gotQuadrants !== null && POSITIONS.every((p) => gotQuadrants[p] === expected.quadrants[p]);
  if (!same) throw stop('mismatch', { got: gotShape, model: reply.model ?? null });
  const passed = {
    passed: true, cliVersion: version, transport: LOOK_TRANSPORT, argvSha256: receipt.argvSha256 ?? null, imageSha256: canary.sha256, expected, got: gotShape,
    model: reply.model ?? null, usage: reply.usage ?? null,
  };
  write({ ...passed, at: base.at });
  probeCache.set(key, passed);
  return { ...passed, cached: false };
}
