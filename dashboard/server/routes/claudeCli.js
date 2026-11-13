import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readJson } from '../lib/objects.js';

// Claude Code CLI (claude -p) logged in with a Claude subscription: the sibling of antigravityCli.js, for the Claude account panel.
// Everything lives in CLAUDE_HOME (data/claude in docker, next to data/agy), used as claude's HOME: its login, plus the CLI itself
// under cli/ (npm install @anthropic-ai/claude-code there, no image rebuild). Login is the manual flow: the CLI prints a link,
// the owner opens it, approves, and pastes the code the page shows back here.
const home = () => process.env.CLAUDE_HOME || (process.env.AGY_HOME ? path.join(path.dirname(process.env.AGY_HOME), 'claude') : '');
export const binPath = () => {
  const local = path.join(home(), 'cli', 'node_modules', '.bin', process.platform === 'win32' ? 'claude.cmd' : 'claude');
  return fs.existsSync(local) ? local : 'claude';
};
// An API key or cloud provider in the environment would make claude bill that instead of the subscription login.
const OTHER_AUTH_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];
export function claudeEnv() {
  const env = { ...process.env, HOME: home(), BROWSER: 'true' };
  for (const k of OTHER_AUTH_ENV) delete env[k];
  return env;
}

// The dashboard's choice (data/claude/forgeai.json), set from the Claude panel: plans and model code go to claude -p first.
const settingsFile = () => path.join(home(), 'forgeai.json');
export const claudeEnabled = () => Boolean(home() && readJson(settingsFile())?.use);
export const claudeModel = () => String(readJson(settingsFile())?.model || process.env.CLAUDE_MODEL || 'sonnet');
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_S) * 1000 || 300000;
// Usage limit hit: don't pay claude's startup on every call until it might work again. ponytail: flat 30 min, no reset time parsed.
let blockedUntil = 0;
export const claudeBlocked = () => Date.now() < blockedUntil;

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const URL_WAIT_MS = 20 * 1000;
const CODE_WAIT_MS = 45 * 1000;
const STATUS_TTL_MS = 30 * 1000;
const CODE_RE = /^[A-Za-z0-9#_.~%-]{8,400}$/; // what the callback page shows; nothing that could add a second stdin line

let login = null; // { child, out, timer }
let cached = null; // { at, value }

const endLogin = () => {
  if (!login) return;
  clearTimeout(login.timer);
  try { login.child.kill('SIGTERM'); } catch { /* already gone */ }
  login = null;
};

function run(args, { timeoutMs = 20000, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawnFn(binPath(), args, { env: claudeEnv(), cwd: home() || undefined, shell: process.platform === 'win32' });
    } catch (e) {
      return resolve({ code: -1, out: String(e.message) });
    }
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e.code || e.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

// One prompt in, the model's answer text out. No tools (--tools ""), no saved session, prompt on stdin (argv is capped at 128 KB).
// Rejects with .unavailable (not logged in, not installed), .quota (usage limit) or .timedOut so the caller can fall back to agy.
// Options: model (CLI alias or id; default is the panel's choice) and structured (resolve { text, usage, model } instead of
// the plain text; usage is only what the CLI reported, null when it reported none).
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function usageFrom(body) {
  const u = body?.usage;
  const ok = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const usage = {};
  if (u && ok(u.input_tokens) && ok(u.output_tokens)) {
    usage.input_tokens = u.input_tokens;
    usage.output_tokens = u.output_tokens;
  } else {
    const models = body?.modelUsage;
    if (!models || typeof models !== 'object' || Array.isArray(models)) return null;
    const entries = Object.values(models).filter((m) => m && typeof m === 'object');
    const valid = entries.filter((m) => ok(m.inputTokens) && ok(m.outputTokens));
    if (!valid.length) return null;
    usage.input_tokens = valid.reduce((sum, m) => sum + m.inputTokens, 0);
    usage.output_tokens = valid.reduce((sum, m) => sum + m.outputTokens, 0);
    if (!ok(usage.input_tokens) || !ok(usage.output_tokens)) return null;
    for (const [source, target] of [['cacheReadInputTokens', 'cache_read_input_tokens'], ['cacheCreationInputTokens', 'cache_creation_input_tokens']]) {
      const values = valid.filter((m) => ok(m[source]));
      const total = values.reduce((sum, m) => sum + m[source], 0);
      if (values.length && ok(total)) usage[target] = total;
    }
    return usage;
  }
  for (const [source, target] of [['cache_read_input_tokens', 'cache_read_input_tokens'], ['cache_creation_input_tokens', 'cache_creation_input_tokens']]) {
    if (ok(u[source])) usage[target] = u[source];
  }
  return usage;
}
export function askClaude(instruction, { timeoutMs = CLAUDE_TIMEOUT_MS, spawnFn = spawn, model, structured = false } = {}) {
  if (model !== undefined && (typeof model !== 'string' || !MODEL_RE.test(model))) return Promise.reject(new TypeError('Invalid Claude model name'));
  if (!home()) return Promise.reject(Object.assign(new Error('Claude CLI is not set up'), { unavailable: true }));
  const workspace = path.join(home(), 'workspace'); // empty folder: nothing for the agent to look at
  fs.mkdirSync(workspace, { recursive: true });
  const prompt = `${instruction}

Answer directly from your own knowledge with only the JSON object described above. Do not use any tools and do not read or write files.`;
  return new Promise((resolve, reject) => {
    let out = '';
    let timedOut = false;
    const child = spawnFn(binPath(), ['-p', '--output-format', 'json', '--model', model ?? claudeModel(), '--tools', '', '--no-session-persistence'], { env: claudeEnv(), cwd: workspace, shell: process.platform === 'win32' });
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch { /* gone */ } }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(Object.assign(new Error(`Couldn't start Claude CLI (${e.code || e.message})`), { unavailable: true })); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let body = null;
      try { body = JSON.parse(out.slice(out.lastIndexOf('\n{') + 1) || out); } catch { /* not JSON */ }
      const text = String(body?.result ?? '').trim();
      if (code === 0 && body && !body.is_error && text) return resolve(structured ? { text, usage: usageFrom(body), model: model ?? claudeModel() } : text);
      const why = timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (text || String(out).trim().split('\n').pop() || `exit ${code}`).slice(0, 300);
      const err = Object.assign(new Error(`Claude CLI failed: ${why}`), { timedOut });
      if (/not logged in|\/login|authenticat/i.test(why)) err.unavailable = true;
      if (/usage limit|rate limit|limit reached|quota/i.test(why)) { err.quota = true; blockedUntil = Date.now() + 30 * 60000; }
      reject(err);
    });
    child.stdin?.end(prompt);
  });
}

export async function getClaudeStatus({ fresh = false, spawnFn } = {}) {
  if (!home()) return { available: false, loggedIn: false, account: '', reason: 'CLAUDE_HOME and AGY_HOME are not set' };
  if (!fresh && cached && Date.now() - cached.at < STATUS_TTL_MS) return { ...cached.value, loginPending: Boolean(login), use: claudeEnabled(), model: claudeModel() };
  const { code, out } = await run(['auth', 'status'], { spawnFn });
  let body = null;
  try { body = JSON.parse(out.slice(out.indexOf('{'))); } catch { /* not JSON: CLI missing or broken */ }
  const value = !body
    ? { available: false, loggedIn: false, account: '', reason: code === -1 ? 'Claude CLI is not installed (npm install @anthropic-ai/claude-code in data/claude/cli)' : "Couldn't read the Claude CLI status" }
    : { available: true, loggedIn: Boolean(body.loggedIn), account: String(body.email || body.account || body.accountEmail || ''), method: body.authMethod || '', reason: body.loggedIn ? '' : 'Claude CLI is not logged in' };
  cached = { at: Date.now(), value };
  return { ...value, loginPending: Boolean(login), use: claudeEnabled(), model: claudeModel() };
}

export const getClaudeHandler = async (req, res) => res.json(await getClaudeStatus());

// Starts a login and answers with the link to open. A login already waiting for its code is replaced.
export async function startClaudeLoginHandler(req, res) {
  if (!home()) return res.status(400).json({ error: 'CLAUDE_HOME and AGY_HOME are not set on the dashboard' });
  endLogin();
  let child;
  try {
    child = spawn(binPath(), ['auth', 'login', '--claudeai'], { env: claudeEnv(), cwd: home(), shell: process.platform === 'win32' });
  } catch (e) {
    return res.status(503).json({ error: "Couldn't start the Claude CLI" });
  }
  const state = { child, out: '', timer: setTimeout(endLogin, LOGIN_TIMEOUT_MS) };
  login = state;
  child.stdout?.on('data', (d) => { state.out += d; });
  child.stderr?.on('data', (d) => { state.out += d; });
  child.on('error', () => { if (login === state) endLogin(); });
  child.on('close', () => { if (login === state) { clearTimeout(state.timer); login = null; } });

  const started = Date.now();
  while (Date.now() - started < URL_WAIT_MS) {
    const url = state.out.match(/https:\/\/\S+/)?.[0];
    if (url) return res.json({ url });
    if (login !== state) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  endLogin();
  res.status(503).json({ error: "The Claude CLI didn't print a login link (is it installed?)" });
}

// The code from the page the link led to: written to the waiting login's stdin; the CLI then finishes the sign-in and exits.
export async function claudeLoginCodeHandler(req, res) {
  const code = String(req.body?.code || '').trim();
  if (!CODE_RE.test(code)) return res.status(400).json({ error: 'That does not look like the code from the Claude page. Copy all of it.' });
  const state = login;
  if (!state) return res.status(409).json({ error: 'No login is waiting. Start the login again.' });
  const exited = new Promise((resolve) => state.child.once('close', (c) => resolve(c)));
  try { state.child.stdin.write(`${code}\n`); } catch { return res.status(409).json({ error: 'The login ended. Start it again.' }); }
  const result = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), CODE_WAIT_MS))]);
  if (result === 'timeout') { endLogin(); return res.status(504).json({ error: 'The Claude CLI did not answer. Start the login again.' }); }
  const status = await getClaudeStatus({ fresh: true });
  if (!status.loggedIn) return res.status(400).json({ error: 'Claude did not accept that code. Start the login again and copy the whole code.', status });
  res.json(status);
}

export async function testClaudeHandler(req, res) {
  const started = Date.now();
  try {
    const reply = await askClaude('Reply with the single word OK.', { timeoutMs: 90000 });
    res.json({ ok: true, reply: reply.slice(0, 200), error: '', ms: Date.now() - started, status: await getClaudeStatus({ fresh: true }) });
  } catch (err) {
    res.json({ ok: false, reply: '', error: String(err.message).slice(0, 200), ms: Date.now() - started, status: await getClaudeStatus({ fresh: true }) });
  }
}

// { use: boolean }: turning it on needs a working login, so the switch never points the pipeline at a Claude that can't answer.
export async function setClaudeHandler(req, res) {
  if (!home()) return res.status(400).json({ error: 'CLAUDE_HOME and AGY_HOME are not set on the dashboard' });
  const use = req.body?.use === true;
  if (use && !(await getClaudeStatus({ fresh: true })).loggedIn) return res.status(409).json({ error: 'Log in with Claude first.' });
  fs.mkdirSync(home(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify({ ...readJson(settingsFile()), use }, null, 2));
  blockedUntil = 0;
  res.json(await getClaudeStatus({ fresh: true }));
}
